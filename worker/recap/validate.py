"""Script validator: the hard gate between the language model and the client (L6).

Every dollar amount, percentage, and bare number >= 100 in the script must equal a value that
exists in extraction.json (or a whitelisted computed value: observation deltas and percentages,
the effective rate, the tax year and its neighbours). Structure rules: the seven slide tags in
order, 250-450 words, no SSN / email / street address. There is no override.

The TypeScript mirror in packages/shared/src/script.ts gives the editor live feedback with the
same rules; this module is the authority the worker enforces.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from .numbers import find_amount_tokens, normalize_pct

SLIDE_ORDER = ["greeting", "income", "deductions", "tax", "result", "observations", "next"]
TAG_RE = re.compile(r"\[\[slide:([a-z_]+)\]\]")
MIN_WORDS = 250
MAX_WORDS = 450

SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+(?:[A-Z][a-z]+\s){0,3}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Court|Ct\.?|Way|Circle|Cir\.?|Place|Pl\.?)\b"
)
PCT_RE = re.compile(r"(?<![\w.])(-?\d+(?:\.\d+)?)\s*%")
BARE_NUM_RE = re.compile(r"(?<![\w$.,-])(\d{1,3}(?:,\d{3})+|\d{3,})(?![\w,.]*\d)(?!\s*%)")


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    word_count: int = 0
    amounts: list[int] = field(default_factory=list)
    percents: list[float] = field(default_factory=list)


def _walk_numbers(obj: Any) -> Iterable[int | float]:
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_numbers(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_numbers(v)


def allowed_amounts(extraction: dict[str, Any]) -> set[int]:
    """Every integer in the extraction plus observation deltas, as absolute values."""
    out: set[int] = set()
    for section in ("income", "adjustments", "deductions", "tax", "payments", "result", "state", "prior_year"):
        for n in _walk_numbers(extraction.get(section)):
            if isinstance(n, int):
                out.add(abs(n))
    for obs in extraction.get("observations", []):
        d = obs.get("delta")
        if isinstance(d, int):
            out.add(abs(d))
    return out


def allowed_percents(extraction: dict[str, Any]) -> set[float]:
    """Percent values (as printed, e.g. 13.4) that the script may state."""
    out: set[float] = set()
    rate = extraction.get("tax", {}).get("effective_rate")
    if isinstance(rate, (int, float)):
        out.add(round(rate * 100, 1))
    for obs in extraction.get("observations", []):
        p = obs.get("pct")
        if isinstance(p, (int, float)) and p:
            out.add(round(abs(p) * 100, 1))
    return out


def allowed_years(extraction: dict[str, Any]) -> set[int]:
    y = extraction.get("meta", {}).get("tax_year")
    return {y - 1, y, y + 1} if isinstance(y, int) else set()


def strip_tags(script: str) -> str:
    return TAG_RE.sub(" ", script)


def slide_sections(script: str) -> list[tuple[str, str]]:
    """[(slide, text)] in document order."""
    parts = TAG_RE.split(script)
    out: list[tuple[str, str]] = []
    # parts = [pre, tag1, text1, tag2, text2, ...]
    for i in range(1, len(parts) - 1, 2):
        out.append((parts[i], parts[i + 1].strip()))
    return out


def word_count(script: str) -> int:
    return len(re.findall(r"[A-Za-z0-9$][\w$',.%-]*", strip_tags(script)))


def _pct_matches(value: float, allowed: set[float]) -> bool:
    for a in allowed:
        if abs(value - a) <= 0.1 + 1e-6:  # same tolerance as the verifier (0.1 point)
            return True
        if float(value).is_integer() and round(a) == value:
            return True
    return False


def validate_script(script: str, extraction: dict[str, Any]) -> ValidationResult:
    errors: list[str] = []
    res = ValidationResult(ok=False)

    # -- structure ---------------------------------------------------------
    tags = TAG_RE.findall(script)
    if tags != SLIDE_ORDER:
        missing = [t for t in SLIDE_ORDER if t not in tags]
        extra = [t for t in tags if t not in SLIDE_ORDER]
        dup = [t for t in set(tags) if tags.count(t) > 1]
        detail = []
        if missing:
            detail.append("missing " + ", ".join(f"[[slide:{t}]]" for t in missing))
        if extra:
            detail.append("unknown " + ", ".join(extra))
        if dup:
            detail.append("duplicated " + ", ".join(dup))
        if not detail:
            detail.append("wrong order; use " + " ".join(f"[[slide:{t}]]" for t in SLIDE_ORDER))
        errors.append("slide tags: " + "; ".join(detail))
    res.word_count = word_count(script)
    if res.word_count < MIN_WORDS:
        errors.append(f"too short: {res.word_count} words, need at least {MIN_WORDS}")
    elif res.word_count > MAX_WORDS:
        errors.append(f"too long: {res.word_count} words, keep it under {MAX_WORDS}")

    # -- PII ----------------------------------------------------------------
    body = strip_tags(script)
    if SSN_RE.search(body):
        errors.append("contains a Social Security number pattern; never include it")
    if EMAIL_RE.search(body):
        errors.append("contains an email address; remove it")
    if ADDRESS_RE.search(body):
        errors.append("contains a street address; remove it")

    # -- numbers ------------------------------------------------------------
    amounts_ok = allowed_amounts(extraction)
    pcts_ok = allowed_percents(extraction)
    years_ok = allowed_years(extraction)
    seen_amounts: list[int] = []
    for tok, value in find_amount_tokens(body):
        has_dollar = "$" in tok
        has_comma = "," in tok
        if not has_dollar and not has_comma:
            continue  # bare numbers are handled below
        seen_amounts.append(value)
        if abs(value) not in amounts_ok:
            errors.append(f"amount {tok} does not appear in the extracted return figures")
    for m in PCT_RE.finditer(body):
        v = float(m.group(1))
        res.percents.append(v)
        if not _pct_matches(abs(v), pcts_ok):
            errors.append(f"percentage {m.group(0).strip()} is not one of the computed figures")
    for m in BARE_NUM_RE.finditer(body):
        tok = m.group(1)
        if "," in tok:
            continue  # already checked as an amount
        n = int(tok)
        if n < 100:
            continue
        if n in years_ok or n == 1040:
            continue
        if n in amounts_ok:
            continue
        errors.append(f"number {tok} does not appear in the extracted return figures")
    res.amounts = seen_amounts
    res.errors = errors
    res.ok = not errors
    return res


def format_errors_for_model(result: ValidationResult) -> str:
    lines = ["The script was rejected by the validator. Fix every point below and return the full script again:"]
    for e in result.errors:
        lines.append(f"- {e}")
    if any(e.startswith("too short") for e in result.errors):
        lines.append(
            "To lengthen it: give every section 3 or 4 full sentences, explain what each figure means for the client, "
            "and keep every number exactly as it is. Do not add new numbers."
        )
    return "\n".join(lines)
