"""Prior-year figures: from a supplied prior-year PDF, or from a two-year comparison page."""

from __future__ import annotations

import re
from typing import Any

from ..numbers import looks_like_amount, parse_amount
from .mapper import LINE_NO_RE, MARGIN_MAX_X, PUNCT_RE, PageInfo
from .pdf import Line, Word

EMPTY = {"present": False, "agi": 0, "total_tax": 0, "refund": 0, "amount_owed": 0}


def from_extraction(prior_doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "present": True,
        "agi": int(prior_doc.get("adjustments", {}).get("agi", 0)),
        "total_tax": int(prior_doc.get("tax", {}).get("total_tax", 0)),
        "refund": int(prior_doc.get("result", {}).get("refund", 0)),
        "amount_owed": int(prior_doc.get("result", {}).get("amount_owed", 0)),
    }


def from_comparison_page(pages: list[PageInfo], profile: dict[str, Any], tax_year: int) -> dict[str, Any]:
    """Read the (tax_year - 1) column of a two-year comparison page, if the software printed one."""
    rows = profile.get("comparison", {}).get("rows", [])
    prior_year = str(tax_year - 1)

    orphan_tol = float(profile.get("geometry", {}).get("orphan_y_tolerance", 0))

    def header_x(page: PageInfo) -> float | None:
        # The column header is a short row ("2024 2025 Differences"); a report title that happens to
        # name both years ("Two Year Comparison Report - Page 1 2024 & 2025") is not it.
        for ln in page.lines:
            years = [w for w in ln.words if w.text in (prior_year, str(tax_year))]
            if len(years) >= 2 and len(ln.words) <= 4:
                return next(w.xc for w in years if w.text == prior_year)
        return None

    def row_amounts(page: PageInfo, ln: Line) -> list[Word]:
        """Amounts on the row, or on a values-only row just above it (separate text runs)."""
        amounts = [w for w in ln.words if looks_like_amount(w.text) and not LINE_NO_RE.match(w.text)]
        if amounts or not orphan_tol:
            return amounts
        for other in page.lines:
            d = ln.top - other.top
            if 0 < d <= orphan_tol and all(looks_like_amount(w.text) or PUNCT_RE.match(w.text) or w.x1 < MARGIN_MAX_X for w in other.words):
                cand = [w for w in other.words if looks_like_amount(w.text) and w.x1 >= MARGIN_MAX_X]
                if cand:
                    return cand
        return []

    # The federal comparison can run to two pages (income and AGI on the first, tax, payments and
    # the result on the second). Only directly consecutive comparison pages join the first one, so
    # a state or Schedule C comparison printed later in the package never supplies a federal figure.
    start = next((i for i, p in enumerate(pages) if p.kind == "comparison" and header_x(p) is not None), None)
    if start is None:
        return dict(EMPTY)
    group: list[PageInfo] = [pages[start]]
    for p in pages[start + 1 :]:
        if p.kind == "comparison" and p.number == group[-1].number + 1:
            group.append(p)
        else:
            break
    col_x = header_x(group[0])
    out: dict[str, Any] = dict(EMPTY)
    out["present"] = True
    signed_net: int | None = None
    for spec in rows:
        if spec["path"] not in EMPTY and not spec.get("signed"):
            continue
        if spec.get("signed") and signed_net is not None:
            continue  # an earlier, preferred signed row already answered
        found = False
        for page in group:
            page_col = header_x(page) or col_x
            for ln in page.lines:
                label = " ".join(w.text for w in ln.words if not looks_like_amount(w.text) or LINE_NO_RE.match(w.text))
                label = re.sub(r"^\s*\d{1,2}[a-z]?\.?\s*", "", label)  # "30. Adjusted gross income 30." -> label text
                if not re.search(spec["label"], label, re.I):
                    continue
                amounts = row_amounts(page, ln)
                if not amounts:
                    continue
                nearest = min(amounts, key=lambda w: abs(w.xc - page_col))
                v = parse_amount(nearest.text)
                if v is not None:
                    if spec.get("signed"):
                        signed_net = v
                    else:
                        # "Refund received" rows are sometimes printed negative; the schema keeps magnitudes.
                        out[spec["path"]] = abs(v) if spec["path"] in ("refund", "amount_owed") else v
                    found = True
                break
            if found:
                break
    if signed_net is not None and not out["refund"] and not out["amount_owed"]:
        if signed_net > 0:
            out["amount_owed"] = signed_net
        elif signed_net < 0:
            out["refund"] = -signed_net
    return out
