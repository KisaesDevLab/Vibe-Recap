"""Number normalization shared by extract/ and verify/.

This is the ONLY module both packages may import from each other's side; it has its own
tests. It turns the ways tax software prints amounts into integers, and amounts back into
the token forms a verifier should search for.
"""

from __future__ import annotations

import re

_AMOUNT_RE = re.compile(
    r"""^\(?\s*-?\$?\s*(?P<num>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<cents>\d{1,2}))?\s*\)?-?$"""
)
_TOKEN_RE = re.compile(r"\(?-?\$?\d[\d,]*(?:\.\d{1,2})?\)?-?")


def parse_amount(token: str) -> int | None:
    """'1,234' -> 1234; '(1,234)' -> -1234; '1,234-' -> -1234; '-' or '' -> 0; text -> None.

    Cents are rounded to the nearest dollar, matching how returns print whole dollars.
    """
    t = token.strip()
    if t in ("", "-", "--", "0-", "-0-", "$-", "$0"):
        return 0 if t else None
    if t in ("-0-",):
        return 0
    m = _AMOUNT_RE.match(t)
    if not m:
        return None
    n = int(m.group("num").replace(",", ""))
    if m.group("cents"):
        n = int(n + int(m.group("cents").ljust(2, "0")) / 100 + 0.5)  # half-up, not banker's rounding
    negative = t.startswith("(") or t.startswith("-") or t.endswith("-") or t.startswith("$-")
    return -n if negative else n


def looks_like_amount(token: str) -> bool:
    return parse_amount(token) is not None and any(ch.isdigit() for ch in token)


def amount_variants(n: int) -> list[str]:
    """Token forms a value can appear as on a return or in a script: with/without $ and commas, parentheses for negatives."""
    a = abs(int(n))
    with_commas = f"{a:,}"
    plain = str(a)
    if n < 0:
        return [f"({with_commas})", f"-{with_commas}", f"({plain})", f"-{plain}", f"-${with_commas}", f"(${with_commas})", f"{with_commas}-"]
    return [with_commas, plain, f"${with_commas}", f"${plain}"]


def find_amount_tokens(text: str) -> list[tuple[str, int]]:
    """All (token, value) pairs in free text, e.g. a script. Percentages are excluded."""
    out: list[tuple[str, int]] = []
    for m in _TOKEN_RE.finditer(text):
        tok = m.group(0)
        end = m.end()
        if end < len(text) and text[end] == "%":
            continue
        # skip things like years embedded in words or line numbers ("line 11", "2025") unless dollar/comma
        v = parse_amount(tok)
        if v is None:
            continue
        out.append((tok, v))
    return out


def normalize_pct(token: str) -> float | None:
    """'12.3%' -> 0.123"""
    m = re.match(r"^\(?(-?\d+(?:\.\d+)?)\s*%\)?$", token.strip())
    return float(m.group(1)) / 100 if m else None
