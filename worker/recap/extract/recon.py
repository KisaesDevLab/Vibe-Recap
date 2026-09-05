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
        _check("taxable_income_foots", max(0, g(adj, "agi") - g(ded, "amount") - g(ded, "qbi")), g(ded, "taxable_income"), ex),
        _check("total_tax_foots", g(tax, "tax") + g(tax, "schedule_2_total") - g(tax, "nonrefundable_credits") + g(tax, "other_taxes"), g(tax, "total_tax"), ex),
        _check("total_payments_foots", g(pay, "withholding") + g(pay, "estimates") + g(pay, "refundable_credits"), g(pay, "total_payments"), ex),
        _check(
            "result_foots",
            g(pay, "total_payments") - g(tax, "total_tax") - g(res, "applied_to_next_year"),
            g(res, "refund") - g(res, "amount_owed"),
            ex,
        ),
    ]
    for st in doc.get("state", []):
        code = st.get("code", "??")
        checks.append(_check(f"state_{code}_result_foots", g(st, "payments") - g(st, "tax"), g(st, "refund") - g(st, "amount_owed"), ex))
    passed = all(c["ok"] or c.get("warning") for c in checks)
    return {"passed": passed, "checks": checks}


def failures(recon: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in recon["checks"] if not c["ok"] and not c.get("warning")]
