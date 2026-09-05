"""Arithmetic reconciliation gate (docs/PLAN.md non-negotiable 2).

Every check recomputes a total from its components and compares within TOLERANCE.
Downgraded checks (per-job exceptions) still run and still report their mismatch; they
just do not block. The order of checks is fixed so output is stable across runs.
"""

from __future__ import annotations

from typing import Any

TOLERANCE = 1


def _check(name: str, expected: int, actual: int, exceptions: set[str]) -> dict[str, Any]:
    ok = abs(int(expected) - int(actual)) <= TOLERANCE
    row: dict[str, Any] = {"name": name, "expected": int(expected), "actual": int(actual), "ok": ok}
    if not ok and name in exceptions:
        row["warning"] = True
    return row


def _result_check(doc: dict[str, Any], ex: set[str]) -> dict[str, Any]:
    """payments - total tax - amount applied = refund - amount owed.

    The Form 1040 instructions fold the estimated tax penalty (line 38) into the amount you owe on
    line 37, or take it out of the refund on line 35a, so the check also accepts the identity with
    the penalty moved across. Which form footed is recorded on the check.
    """
    tax, pay, res = (doc.get(k, {}) for k in ("tax", "payments", "result"))
    extras = doc.get("_extras") or doc.get("extras") or {}
    penalty = int(extras.get("estimated_tax_penalty") or 0)
    expected = int(pay.get("total_payments") or 0) - int(tax.get("total_tax") or 0) - int(res.get("applied_to_next_year") or 0)
    actual = int(res.get("refund") or 0) - int(res.get("amount_owed") or 0)
    row = _check("result_foots", expected, actual, ex)
    if not row["ok"] and penalty:
        with_penalty = _check("result_foots", expected - penalty, actual, ex)
        if with_penalty["ok"]:
            with_penalty["penalty_included"] = penalty
            return with_penalty
    return row


def reconcile(doc: dict[str, Any], exceptions: set[str] | None = None) -> dict[str, Any]:
    ex = exceptions or set()
    inc, adj, ded, tax, pay, res = (doc.get(k, {}) for k in ("income", "adjustments", "deductions", "tax", "payments", "result"))

    def g(d: dict[str, Any], k: str) -> int:
        return int(d.get(k) or 0)

    checks = [
        _check(
            "total_income_foots",
            g(inc, "wages") + g(inc, "interest") + g(inc, "dividends") + g(inc, "ira_pensions")
            + g(inc, "social_security_taxable") + g(inc, "capital_gain") + g(inc, "schedule_1_total"),
            g(inc, "total_income"),
            ex,
        ),
        _check("agi_foots", g(inc, "total_income") - g(adj, "schedule_1_adjustments"), g(adj, "agi"), ex),
        # 2025 line 14 = 12e + 13a + 13b (Schedule 1-A deductions); earlier years have no 13b and `additional` is 0
        _check("taxable_income_foots", max(0, g(adj, "agi") - g(ded, "amount") - g(ded, "qbi") - g(ded, "additional")), g(ded, "taxable_income"), ex),
        _check("total_tax_foots", g(tax, "tax") + g(tax, "schedule_2_total") - g(tax, "nonrefundable_credits") + g(tax, "other_taxes"), g(tax, "total_tax"), ex),
        _check("total_payments_foots", g(pay, "withholding") + g(pay, "estimates") + g(pay, "refundable_credits"), g(pay, "total_payments"), ex),
        _result_check(doc, ex),
    ]
    for st in doc.get("state", []):
        code = st.get("code", "??")
        row = _check(f"state_{code}_result_foots", g(st, "payments") - g(st, "tax"), g(st, "refund") - g(st, "amount_owed"), ex)
        if not row["ok"] and g(st, "penalty"):
            with_penalty = _check(f"state_{code}_result_foots", g(st, "payments") - g(st, "tax") - g(st, "penalty"), g(st, "refund") - g(st, "amount_owed"), ex)
            if with_penalty["ok"]:
                with_penalty["penalty_included"] = g(st, "penalty")
                row = with_penalty
        checks.append(row)
    passed = all(c["ok"] or c.get("warning") for c in checks)
    return {"passed": passed, "checks": checks}


def failures(recon: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in recon["checks"] if not c["ok"] and not c.get("warning")]
