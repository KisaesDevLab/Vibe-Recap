"""Map a text-layer PDF to the extraction schema using a form profile.

Geometry first: words are clustered into lines by y-band, the IRS line number identifies
the row, and the value is the right-most amount token on that row. Label regexes are a
secondary check so a wrong page or a renumbered form fails loudly instead of silently.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..numbers import looks_like_amount, parse_amount
from .identify import find_names
from .pdf import Line, Word, cluster_lines, page_words
from .profiles import load_states

LINE_NO_RE = re.compile(r"^\d{1,2}[a-z]?$", re.I)
MARKER_RE = re.compile(r"^(\[?[xX✓✔☒]\]?|\[X\]|X)$")
PUNCT_RE = re.compile(r"^[.…:\-_]+$")  # dotted leaders and similar filler


class ExtractionError(Exception):
    """Raised when required lines are missing or a fact could not be determined."""


@dataclass
class PageInfo:
    number: int  # 1-based
    kind: str | None
    lines: list[Line]
    words: list[Word]
    text: str


@dataclass
class Found:
    value: int
    page: int
    label: str
    line_no: str | None
    y: float


@dataclass
class Mapped:
    values: dict[str, Any] = field(default_factory=dict)
    evidence: dict[str, Found] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Page classification
# ---------------------------------------------------------------------------


def _matches(pat: str, text: str) -> bool:
    return re.search(pat, text, re.I) is not None


def classify_page(text: str, classifiers: dict[str, dict[str, list[str]]]) -> str | None:
    for kind, rule in classifiers.items():
        if not any(_matches(p, text) for p in rule.get("any", [])):
            continue
        if any(_matches(p, text) for p in rule.get("not", [])):
            continue
        if not all(_matches(p, text) for p in rule.get("all", [])):
            continue
        return kind
    return None


def read_pages(pdf: Any, profile: dict[str, Any]) -> list[PageInfo]:
    tol = float(profile.get("geometry", {}).get("y_tolerance", 3))
    out: list[PageInfo] = []
    for i, page in enumerate(pdf.pages):
        words = page_words(page)
        lines = cluster_lines(words, tol)
        text = "\n".join(ln.text for ln in lines)
        out.append(PageInfo(i + 1, classify_page(text, profile.get("pages", {})), lines, words, text))
    return out


# ---------------------------------------------------------------------------
# Row matching
# ---------------------------------------------------------------------------


def _row_number(line: Line, position: str, min_x: float) -> tuple[str | None, list[Word], list[Word]]:
    """Return (line number, label words, value candidates) for a clustered line.

    Geometry decides what is a value: amount-looking tokens at or right of `min_x`.
    Everything else is label territory, and the IRS line number is its first (prefix)
    or last (suffix) token. This keeps a bare "9" line number from being read as $9.
    """
    words = line.words
    if not words:
        return None, [], []
    amounts: list[Word] = sorted((w for w in words if w.x1 >= min_x and looks_like_amount(w.text)), key=lambda w: w.x0)
    label_words = [w for w in words if w not in amounts and not PUNCT_RE.match(w.text)]
    number: str | None = None
    if position in ("prefix", "auto") and label_words and LINE_NO_RE.match(label_words[0].text):
        number = label_words[0].text
        label_words = label_words[1:]
    elif position in ("suffix", "auto") and label_words and LINE_NO_RE.match(label_words[-1].text):
        number = label_words[-1].text
        label_words = label_words[:-1]
    elif position in ("suffix", "auto") and len(amounts) >= 2 and LINE_NO_RE.match(amounts[0].text) and len(amounts[0].text) <= 3:
        # ProSeries-style: the line number sits right of the label, inside the value zone
        number = amounts[0].text
        amounts = amounts[1:]
    return number, label_words, amounts


def _value_for(amounts: list[Word]) -> Word | None:
    return max(amounts, key=lambda w: w.x1) if amounts else None


def find_row(page: PageInfo, spec: dict[str, Any], geometry: dict[str, Any]) -> Found | None:
    position = geometry.get("number_position", "auto")
    min_x = float(geometry.get("value_min_x", 360))
    want_no = str(spec.get("line", "")).lower() or None
    label_re = spec.get("label")
    for ln in page.lines:
        number, label_words, amounts = _row_number(ln, position, min_x)
        label = " ".join(w.text for w in label_words)
        if want_no:
            if (number or "").lower() != want_no:
                continue
            if label_re and not re.search(label_re, label, re.I):
                # number matched but the label is unexpected: keep looking, but remember nothing
                continue
        else:
            if not label_re or not re.search(label_re, label, re.I):
                continue
        v = _value_for(amounts)
        if v is None:
            continue
        parsed = parse_amount(v.text)
        if parsed is None:
            continue
        return Found(parsed, page.number, label, number, ln.top)
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _set(values: dict[str, Any], path: str, value: Any, combine: str | None) -> None:
    parts = path.split(".")
    d = values
    for p in parts[:-1]:
        d = d.setdefault(p, {})
    leaf = parts[-1]
    if combine == "sum" and isinstance(d.get(leaf), int):
        d[leaf] += value
    else:
        d[leaf] = value


def map_lines(pages: list[PageInfo], profile: dict[str, Any]) -> Mapped:
    geometry = profile.get("geometry", {})
    out = Mapped()
    required = set(profile.get("required", []))
    for spec in profile.get("lines", []):
        kind = spec.get("page")
        targets = [p for p in pages if kind is None or p.kind == kind]
        found: Found | None = None
        for page in targets:
            found = find_row(page, spec, geometry)
            if found:
                break
        path = spec["path"]
        if found:
            _set(out.values, path, found.value, spec.get("combine"))
            out.evidence[f"{path}@{spec.get('line', '')}"] = found
        else:
            if spec.get("required", path in required):
                out.missing.append(f"{path} (line {spec.get('line', '?')})")
            elif spec.get("combine") == "sum":
                _set(out.values, path, 0, "sum")
            else:
                _set(out.values, path, 0, None)
    return out


def _find_phrase(words: list[Word], phrase: str) -> int | None:
    """Index of the first word of `phrase` in `words` (case-insensitive, punctuation-insensitive)."""
    parts = [re.sub(r"[^a-z0-9]", "", p.lower()) for p in phrase.split()]
    n = len(parts)
    for i in range(len(words) - n + 1):
        if [re.sub(r"[^a-z0-9]", "", w.text.lower()) for w in words[i : i + n]] == parts:
            return i
    return None


def detect_filing_status(page: PageInfo, statuses: dict[str, str]) -> str | None:
    """Marked checkbox next to a status phrase, or the only status phrase on the page.

    Handles markers printed as one token ("[X]"), split tokens ("[", "X", "]") and a bare "X",
    and treats "[ ]" as unmarked. Works whether all five statuses are printed or only the chosen one.
    """
    present: list[str] = []
    marked: list[str] = []
    for code, pat in statuses.items():
        found_any = False
        for alt in pat.split("|"):
            for ln in page.lines:
                words = sorted(ln.words, key=lambda w: w.x0)
                idx = _find_phrase(words, alt)
                if idx is None:
                    continue
                found_any = True
                before = [w for w in words[max(0, idx - 3) : idx] if words[idx].x0 - w.x1 < 40]
                joined = " ".join(w.text for w in before)
                if re.search(r"\[\s*[xX✓✔☒]\s*\]\s*$", joined) or re.search(r"(^|\s)[xX✓✔☒](\s|$)", joined) and not re.search(r"\[\s*\]\s*$", joined):
                    marked.append(code)
                break
            if found_any:
                break
        if found_any:
            present.append(code)
    marked = list(dict.fromkeys(marked))
    if len(marked) == 1:
        return marked[0]
    if len(marked) == 0 and len(present) == 1:
        return present[0]
    return None


def detect_states(pages: list[PageInfo], profile: dict[str, Any], profiles_dir: str) -> list[dict[str, Any]]:
    states = load_states(profiles_dir)
    geometry = dict(profile.get("geometry", {}))
    geometry["number_position"] = "auto"
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in pages:
        if page.kind != "state":
            continue
        head = "\n".join(ln.text for ln in page.lines[:6])
        code = None
        for c, needles in states.items():
            if any(re.search(rf"\b{re.escape(n)}\b", head, re.I) for n in needles):
                code = c
                break
        if not code or code in seen:
            continue
        seen.add(code)
        row: dict[str, Any] = {"code": code, "taxable_income": 0, "tax": 0, "payments": 0, "refund": 0, "amount_owed": 0}
        for spec in profile.get("state", {}).get("lines", []):
            f = find_row(page, {"label": spec["label"]}, geometry)
            if f:
                row[spec["path"]] = f.value
        out.append(row)
    return out


def extract_document(pdf: Any, profile: dict[str, Any], profiles_dir: str) -> tuple[dict[str, Any], list[PageInfo], Mapped]:
    """Run the mapper over an open pdfplumber document. Returns (partial extraction, pages, mapping)."""
    pages = read_pages(pdf, profile)
    mapped = map_lines(pages, profile)
    if mapped.missing:
        raise ExtractionError("required lines missing: " + ", ".join(mapped.missing))
    p1 = next((p for p in pages if p.kind == "f1040_1"), None)
    if not p1:
        raise ExtractionError("Form 1040 page 1 not found")
    first, last, spouse = find_names(p1.words)
    status = detect_filing_status(p1, profile.get("filing_status", {}))
    if not status:
        raise ExtractionError("filing status not detected")
    v = mapped.values
    extras = v.pop("extras", {}) if isinstance(v.get("extras"), dict) else {}
    has_sched_a = any(p.kind == "schedule_a" for p in pages)
    deduction_type = "itemized" if has_sched_a else "standard"
    doc: dict[str, Any] = {
        "meta": {"filing_status": status, "state_returns": []},
        "taxpayer": {"first_name": first, "last_name": last, "spouse_first_name": spouse if status in ("MFJ", "MFS") else None},
        "income": v.get("income", {}),
        "adjustments": v.get("adjustments", {}),
        "deductions": {"type": deduction_type, **v.get("deductions", {})},
        "tax": v.get("tax", {}),
        "payments": v.get("payments", {}),
        "result": v.get("result", {}),
        "state": detect_states(pages, profile, profiles_dir),
        "_extras": {**extras, "has_form_2210": any(p.kind == "form_2210" for p in pages)},
    }
    doc["meta"]["state_returns"] = [s["code"] for s in doc["state"]]
    return doc, pages, mapped
