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

LINE_NO_RE = re.compile(r"^\d{1,2}[a-z]?\.?$", re.I)
MARGIN_MAX_X = 75.0  # sidebar text on a letter page ends left of this x
MARKER_RE = re.compile(r"^(\[?[xX✓✔☒]\]?|\[X\]|X)$")
PUNCT_RE = re.compile(r"^[.…:\-_•�▶►]+$")  # dotted leaders, bullets, and similar filler


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
    prefix_at = _prefix_index(label_words) if position in ("prefix", "auto") else None
    if prefix_at is not None:
        number = label_words[prefix_at].text.rstrip(".")
        label_words = label_words[prefix_at + 1 :]
    elif position in ("suffix", "auto") and label_words and LINE_NO_RE.match(label_words[-1].text):
        number = label_words[-1].text.rstrip(".")
        label_words = label_words[:-1]
    elif position in ("suffix", "auto") and len(amounts) >= 2 and LINE_NO_RE.match(amounts[0].text) and len(amounts[0].text) <= 3:
        # ProSeries-style: the line number sits right of the label, inside the value zone
        number = amounts[0].text.rstrip(".")
        amounts = amounts[1:]
    if number:
        # UltraTax prints the line number twice, the second copy just left of the amount column.
        amounts = [w for w in amounts if w.text.rstrip(".").lower() != number.lower()]
    # State forms print a separate cents column ("1,150 . 00"); a "00" there is never the value,
    # and on its own it means the line is blank (a real zero prints as "0").
    amounts = [w for w in amounts if not re.fullmatch(r"00", w.text)]
    return number, label_words, amounts


def _prefix_index(label_words: list[Word]) -> int | None:
    """Index of the IRS line number when it opens the label, allowing for sidebar text.

    Software prints section words ("Income", "Attach Form(s)", "spouse,") in a narrow margin to
    the left of the line number. Those words end before the number starts and sit in the leftmost
    strip of the page, so they are skipped; anything else before a number means it is not a prefix.
    """
    for k, w in enumerate(label_words[:3]):
        if not LINE_NO_RE.match(w.text):
            continue
        if all(m.x1 <= w.x0 + 0.5 and m.x1 < MARGIN_MAX_X for m in label_words[:k]):
            return k
        return None
    return None


def _value_for(amounts: list[Word]) -> Word | None:
    return max(amounts, key=lambda w: w.x1) if amounts else None


def find_row(page: PageInfo, spec: dict[str, Any], geometry: dict[str, Any]) -> Found | None:
    position = geometry.get("number_position", "auto")
    min_x = float(spec.get("value_min_x", geometry.get("value_min_x", 360)))  # a line may sit in a narrower column
    orphan_tol = float(geometry.get("orphan_y_tolerance", 0))
    raw_line = spec.get("line", "")
    # A line may be written as a list when the IRS renumbered it between years ("11a" in 2025, "11" before).
    want_nos = {str(x).lower() for x in (raw_line if isinstance(raw_line, list) else [raw_line]) if str(x)}
    label_re = spec.get("label")
    for ln in page.lines:
        number, label_words, amounts = _row_number(ln, position, min_x)
        label = " ".join(w.text for w in label_words)
        if want_nos:
            if (number or "").lower() not in want_nos:
                continue
            if label_re and not re.search(label_re, label, re.I):
                # number matched but the label is unexpected: keep looking, but remember nothing
                continue
        else:
            if not label_re or not re.search(label_re, label, re.I):
                continue
        v = _value_for(amounts)
        if v is None and orphan_tol:
            v = _orphan_value(page, ln, orphan_tol, position, min_x, number)
        if v is None:
            continue
        parsed = parse_amount(v.text)
        if parsed is None:
            continue
        return Found(parsed, page.number, label, number, ln.top)
    return None


def _value_row(other: Line, position: str, min_x: float, number: str | None) -> Word | None:
    """The amount of a row that carries a value but no label of its own, else None.

    Such a row holds amounts, optionally sidebar text in the left margin, and optionally the
    second copy of the IRS line number printed just left of the amount column (x >= 400). When
    the row names a line number it must be the one being looked up, so a neighbouring line's
    value is never borrowed.
    """
    row_no, label_words, amounts = _row_number(other, position, min_x)
    if not amounts or any(w.x1 >= MARGIN_MAX_X for w in label_words):
        return None
    if row_no is not None:
        num_word = next((w for w in other.words if w.text.rstrip(".").lower() == row_no.lower()), None)
        if num_word is None or num_word.x0 < 400:
            return None
        if number is not None and row_no.lower() != number.lower():
            return None
    return _value_for(amounts)


def _orphan_value(page: PageInfo, ln: Line, tol: float, position: str, min_x: float, number: str | None) -> Word | None:
    """Amount printed on its own row rather than on the labelled row.

    UltraTax draws the value a few points above the label's baseline, and for a multi-row label
    (line 16 "Tax") it aligns the value with the row that carries the second copy of the line
    number, which can sit below the first label row. So a value row counts when it sits just above
    the labelled row, or when it repeats this line's number and sits within a few rows below it.
    Rows below the label with no such anchor never qualify, so a blank line cannot borrow the next
    line's amount.
    """
    best: tuple[float, Word] | None = None
    for other in page.lines:
        d = ln.top - other.top
        if 0 < d <= tol:
            v = _value_row(other, position, min_x, number)
            if v is not None and (best is None or d < best[0]):
                best = (d, v)
    if best or not number:
        return best[1] if best else None
    for s in sorted((s for s in page.lines if 0 < s.top - ln.top <= 3 * tol), key=lambda s: s.top):
        if not any(w.text.rstrip(".").lower() == number.lower() and w.x0 >= 400 for w in s.words):
            continue
        _n, _l, amounts = _row_number(s, position, min_x)
        amounts = [w for w in amounts if w.text.rstrip(".").lower() != number.lower()]
        if amounts:
            return _value_for(amounts)
        for other in page.lines:
            d = s.top - other.top
            if 0 < d <= tol:
                v = _value_row(other, position, min_x, number)
                if v is not None and (best is None or d < best[0]):
                    best = (d, v)
        if best:
            return best[1]
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
                # The mark may be its own text object on a slightly different baseline (UltraTax),
                # so it lands on a neighbouring row: look for a lone X just left of the phrase.
                anchor = words[idx]
                if any(re.fullmatch(r"[xX✓✔☒]", w.text) and 0 <= anchor.x0 - w.x1 < 40 and abs(w.top - anchor.top) <= 6 for w in page.words):
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
    """State returns as groups of pages.

    A state form starts on a page classified `state` whose header names the state (or its form id)
    and continues over following unclassified pages that still mention the state; real state forms
    run three to six pages with the totals at the end. Federal pages and excluded page types (letters,
    worksheets, reports) end a group. Each line label is searched across the group in page order.
    """
    states = load_states(profiles_dir)
    geometry = dict(profile.get("geometry", {}))
    geometry["number_position"] = "auto"
    excludes = profile.get("pages", {}).get("state", {}).get("not", [])
    groups: dict[str, list[PageInfo]] = {}
    current: str | None = None
    for page in pages:
        head = "\n".join(ln.text for ln in page.lines[:10])
        code = None
        if page.kind == "state":
            for c, needles in states.items():
                if any(re.search(rf"\b{re.escape(n)}\b", head, re.I) for n in needles):
                    code = c
                    break
        if code:
            current = code
            groups.setdefault(code, []).append(page)
            continue
        # Continuation pages of the current state form: unclassified or state-like, titled as neither
        # a letter nor a report (the exclusions are checked against the page title lines only, since
        # form instructions say "see worksheet" in running text), and still naming the state.
        if current and page.kind in (None, "state") and not any(_matches(p, head) for p in excludes):
            name = states[current][0]
            if re.search(rf"\b{re.escape(name)}\b", page.text, re.I):
                groups[current].append(page)
                continue
        current = None
    out: list[dict[str, Any]] = []
    for code, group in groups.items():
        row: dict[str, Any] = {"code": code, "taxable_income": 0, "tax": 0, "payments": 0, "refund": 0, "amount_owed": 0}
        for spec in profile.get("state", {}).get("lines", []):
            for page in group:
                f = find_row(page, {"label": spec["label"]}, geometry)
                if f:
                    row[spec["path"]] = f.value
                    break
        if not row.get("penalty"):
            row.pop("penalty", None)  # only present when the form prints one
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
