"""Deterministic observations. No LLM involvement: these are computed facts the script may phrase.

Ids are stable and referenced by the prompt template and the validator whitelist.
"""

from __future__ import annotations

from typing import Any


def _pct(delta: int, base: int) -> float:
    return round(delta / base, 4) if base else 0.0


def compute_observations(doc: dict[str, Any]) -> list[dict[str, Any]]:
    obs: list[dict[str, Any]] = []
    py = doc.get("prior_year") or {}
    adj, tax, pay, res, ded = (doc.get(k, {}) for k in ("adjustments", "tax", "payments", "result", "deductions"))
    extras = doc.get("_extras", {})
    if py.get("present"):
        d = int(adj.get("agi", 0)) - int(py.get("agi", 0))
        obs.append({"id": "yoy_agi", "delta": d, "pct": _pct(d, int(py.get("agi", 0)))})
        d = int(tax.get("total_tax", 0)) - int(py.get("total_tax", 0))
        obs.append({"id": "yoy_total_tax", "delta": d, "pct": _pct(d, int(py.get("total_tax", 0)))})
        prior_result = int(py.get("refund", 0)) - int(py.get("amount_owed", 0))
        cur_result = int(res.get("refund", 0)) - int(res.get("amount_owed", 0))
        obs.append({"id": "yoy_result", "delta": cur_result - prior_result, "pct": 0.0})
    total_tax = int(tax.get("total_tax", 0))
    if total_tax:
        wh = int(pay.get("withholding", 0))
        obs.append({"id": "withholding_ratio", "delta": wh - total_tax, "pct": round(wh / total_tax, 4)})
    itemized_total = extras.get("itemized_total")
    std_amount = extras.get("standard_deduction_amount")
    if ded.get("type") == "standard" and itemized_total and std_amount:
        gap = int(std_amount) - int(itemized_total)
        if abs(gap) <= 0.10 * int(std_amount):
            obs.append({"id": "std_itemized_proximity", "delta": gap, "pct": _pct(gap, int(std_amount))})
    penalty = int(extras.get("estimated_tax_penalty") or 0)
    if extras.get("has_form_2210") or penalty:
        obs.append({"id": "underpayment_penalty", "delta": penalty, "pct": 0.0})
    return obs
