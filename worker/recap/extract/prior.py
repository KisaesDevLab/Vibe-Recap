"""Prior-year figures: from a supplied prior-year PDF, or from a two-year comparison page."""

from __future__ import annotations

import re
from typing import Any

from ..numbers import looks_like_amount, parse_amount
from .mapper import PageInfo

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
    for page in pages:
        if page.kind != "comparison":
            continue
        col_x: float | None = None
        for ln in page.lines:
            years = [w for w in ln.words if w.text in (prior_year, str(tax_year))]
            if len(years) >= 2:
                col_x = next(w.xc for w in years if w.text == prior_year)
                break
        if col_x is None:
            continue
        out: dict[str, Any] = dict(EMPTY)
        out["present"] = True
        for spec in rows:
            for ln in page.lines:
                label = " ".join(w.text for w in ln.words if not looks_like_amount(w.text))
                if not re.search(spec["label"], label, re.I):
                    continue
                amounts = [w for w in ln.words if looks_like_amount(w.text)]
                if not amounts:
                    continue
                nearest = min(amounts, key=lambda w: abs(w.xc - col_x))
                v = parse_amount(nearest.text)
                if v is not None and spec["path"] in EMPTY:
                    out[spec["path"]] = v
                break
        return out
    return dict(EMPTY)
