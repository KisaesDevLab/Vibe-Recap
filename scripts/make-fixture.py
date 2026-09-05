#!/usr/bin/env python
"""Generate synthetic 1040 packages for tests.

Every fixture is fake: made-up names, SSNs of the form 000-00-xxxx, a fake bank
account, and figures that foot by construction. Each PDF gets a matching
`.expected.json` holding the extraction the worker must produce (docs/PLAN.md §5).

Usage:
    python scripts/make-fixture.py                  # regenerate tests/fixtures/*.pdf
    python scripts/make-fixture.py --out /tmp/fx    # elsewhere
    python scripts/make-fixture.py --list           # print case ids

Layouts mimic the label/value geometry of each supported package well enough to
exercise the form profiles: UltraTax (labels and values in separate text runs),
Lacerte (overlapping words on some lines), CCH Axcess (dotted leaders), GoSystem
(upper-case labels), Drake (compact two-column), ProSeries (line numbers right of
the label). The IRS line text itself is the same everywhere, as it is in the real
software, which is what the profiles key on.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))

PAGE_W, PAGE_H = letter

SOFTWARE_SIGNATURES = {
    "ultratax": "UltraTax CS",
    "lacerte": "Lacerte Tax",
    "cch": "CCH Axcess Tax",
    "gosystem": "GoSystem Tax RS",
    "drake": "Drake Software",
    "proseries": "Intuit ProSeries",
}

STATE_NAMES = {"MO": "Missouri", "KS": "Kansas", "IL": "Illinois", "CA": "California", "NY": "New York"}
STATE_FORMS = {"MO": "MO-1040", "KS": "K-40", "IL": "IL-1040", "CA": "Form 540", "NY": "IT-201"}

FILING_STATUS_TEXT = {
    "S": "Single",
    "MFJ": "Married filing jointly",
    "MFS": "Married filing separately",
    "HOH": "Head of household",
    "QSS": "Qualifying surviving spouse",
}


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


@dataclass
class Case:
    id: str
    first_name: str
    last_name: str
    filing_status: str
    tax_year: int = 2025
    spouse_first_name: str | None = None
    wages: int = 0
    interest: int = 0
    dividends: int = 0
    ira_distributions: int = 0
    pensions: int = 0
    social_security_taxable: int = 0
    capital_gain: int = 0
    schedule_1_total: int = 0
    schedule_1_adjustments: int = 0
    deduction_type: str = "standard"
    deduction_amount: int = 30000
    qbi: int = 0
    tax: int = 0
    schedule_2_total: int = 0
    nonrefundable_credits: int = 0
    other_taxes: int = 0
    withholding: int = 0
    estimates: int = 0
    refundable_credits: int = 0
    applied_to_next_year: int = 0
    estimated_tax_penalty: int = 0
    states: list[dict] = field(default_factory=list)
    prior_year: dict | None = None  # {"agi":..,"total_tax":..,"refund":..,"amount_owed":..}
    comparison_page: bool = False
    form_2210: bool = False
    bank_account: str = "123456789"
    routing: str = "000000000"
    ssn: str = "000-00-1234"
    spouse_ssn: str = "000-00-5678"

    # -- derived -----------------------------------------------------------
    @property
    def ira_pensions(self) -> int:
        return self.ira_distributions + self.pensions

    @property
    def total_income(self) -> int:
        return (
            self.wages + self.interest + self.dividends + self.ira_pensions
            + self.social_security_taxable + self.capital_gain + self.schedule_1_total
        )

    @property
    def agi(self) -> int:
        return self.total_income - self.schedule_1_adjustments

    @property
    def taxable_income(self) -> int:
        return max(0, self.agi - self.deduction_amount - self.qbi)

    @property
    def total_tax(self) -> int:
        return self.tax + self.schedule_2_total - self.nonrefundable_credits + self.other_taxes

    @property
    def total_payments(self) -> int:
        return self.withholding + self.estimates + self.refundable_credits

    @property
    def overpaid(self) -> int:
        return max(0, self.total_payments - self.total_tax)

    @property
    def refund(self) -> int:
        return max(0, self.overpaid - self.applied_to_next_year)

    @property
    def amount_owed(self) -> int:
        return max(0, self.total_tax - self.total_payments)

    @property
    def effective_rate(self) -> float:
        return round(self.total_tax / self.taxable_income, 4) if self.taxable_income else 0.0


def state_result(st: dict) -> dict:
    payments = st["withholding"] + st.get("estimates", 0)
    diff = payments - st["tax"]
    return {
        "code": st["code"],
        "taxable_income": st["taxable_income"],
        "tax": st["tax"],
        "payments": payments,
        "refund": max(0, diff),
        "amount_owed": max(0, -diff),
    }


def observations(case: Case, with_prior: bool | None = None) -> list[dict]:
    """Deterministic observations, mirroring worker/recap/extract/observations.py."""
    obs: list[dict] = []
    py = case.prior_year if (with_prior if with_prior is not None else case.comparison_page) else None
    if py:
        if py.get("agi") is not None:
            d = case.agi - py["agi"]
            obs.append({"id": "yoy_agi", "delta": d, "pct": round(d / py["agi"], 4) if py["agi"] else 0.0})
        if py.get("total_tax") is not None:
            d = case.total_tax - py["total_tax"]
            obs.append({"id": "yoy_total_tax", "delta": d, "pct": round(d / py["total_tax"], 4) if py["total_tax"] else 0.0})
        prior_result = py.get("refund", 0) - py.get("amount_owed", 0)
        cur_result = case.refund - case.amount_owed
        obs.append({"id": "yoy_result", "delta": cur_result - prior_result, "pct": 0.0})
    if case.total_tax:
        obs.append({"id": "withholding_ratio", "delta": case.withholding - case.total_tax, "pct": round(case.withholding / case.total_tax, 4)})
    if case.form_2210 or case.estimated_tax_penalty:
        obs.append({"id": "underpayment_penalty", "delta": case.estimated_tax_penalty, "pct": 0.0})
    return obs


def expected_json(case: Case, software: str) -> dict:
    recon_checks = [
        {"name": "total_income_foots", "expected": case.total_income, "actual": case.total_income, "ok": True},
        {"name": "agi_foots", "expected": case.agi, "actual": case.agi, "ok": True},
        {"name": "taxable_income_foots", "expected": case.taxable_income, "actual": case.taxable_income, "ok": True},
        {"name": "total_tax_foots", "expected": case.total_tax, "actual": case.total_tax, "ok": True},
        {"name": "total_payments_foots", "expected": case.total_payments, "actual": case.total_payments, "ok": True},
        {"name": "result_foots", "expected": case.refund - case.amount_owed, "actual": case.refund - case.amount_owed, "ok": True},
    ]
    states = [state_result(s) for s in case.states]
    for s in states:
        recon_checks.append({"name": f"state_{s['code']}_result_foots", "expected": s["refund"] - s["amount_owed"], "actual": s["refund"] - s["amount_owed"], "ok": True})
    # The PDF alone only reveals prior-year figures when a comparison page is printed.
    py = case.prior_year if (case.prior_year and case.comparison_page) else {}
    return {
        "meta": {
            "software": software,
            "tax_year": case.tax_year,
            "form": "1040",
            "filing_status": case.filing_status,
            "state_returns": [s["code"] for s in case.states],
        },
        "taxpayer": {
            "first_name": case.first_name,
            "last_name": case.last_name,
            "spouse_first_name": case.spouse_first_name,
        },
        "income": {
            "wages": case.wages,
            "interest": case.interest,
            "dividends": case.dividends,
            "ira_pensions": case.ira_pensions,
            "social_security_taxable": case.social_security_taxable,
            "capital_gain": case.capital_gain,
            "schedule_1_total": case.schedule_1_total,
            "total_income": case.total_income,
        },
        "adjustments": {"schedule_1_adjustments": case.schedule_1_adjustments, "agi": case.agi},
        "deductions": {
            "type": case.deduction_type,
            "additional": 0,
            "amount": case.deduction_amount,
            "qbi": case.qbi,
            "taxable_income": case.taxable_income,
        },
        "tax": {
            "tax": case.tax,
            "schedule_2_total": case.schedule_2_total,
            "nonrefundable_credits": case.nonrefundable_credits,
            "other_taxes": case.other_taxes,
            "total_tax": case.total_tax,
            "effective_rate": case.effective_rate,
        },
        "payments": {
            "withholding": case.withholding,
            "estimates": case.estimates,
            "refundable_credits": case.refundable_credits,
            "total_payments": case.total_payments,
        },
        "result": {
            "refund": case.refund,
            "amount_owed": case.amount_owed,
            "applied_to_next_year": case.applied_to_next_year,
        },
        "state": states,
        "prior_year": {
            "present": bool(py),
            "agi": py.get("agi", 0),
            "total_tax": py.get("total_tax", 0),
            "refund": py.get("refund", 0),
            "amount_owed": py.get("amount_owed", 0),
        },
        "observations": observations(case, bool(py)),
        "recon": {"passed": True, "checks": recon_checks},
    }


CASES: list[Case] = [
    Case(
        id="mfj-refund-mo",
        first_name="Alex", last_name="Fixture", spouse_first_name="Jordan", filing_status="MFJ",
        wages=142_500, interest=1_240, dividends=3_860, pensions=0, capital_gain=4_200,
        schedule_1_total=2_000, schedule_1_adjustments=6_500,
        deduction_type="standard", deduction_amount=30_000, qbi=0,
        tax=15_870, nonrefundable_credits=2_000, other_taxes=283,
        withholding=17_900, estimates=0,
        states=[{"code": "MO", "taxable_income": 118_000, "tax": 5_310, "withholding": 5_900}],
        prior_year={"agi": 139_800, "total_tax": 14_220, "refund": 2_150, "amount_owed": 0},
        comparison_page=True,
    ),
    Case(
        id="single-owed-itemized",
        first_name="Casey", last_name="Sample", filing_status="S",
        wages=98_000, interest=310, dividends=0, ira_distributions=12_000, capital_gain=-3_000,
        deduction_type="itemized", deduction_amount=21_400, qbi=1_800,
        tax=13_240, schedule_2_total=1_100, other_taxes=0,
        withholding=11_200, estimates=1_500,
        states=[],
        prior_year=None,
        form_2210=True, estimated_tax_penalty=42,
    ),
    Case(
        id="hoh-refund-two-states",
        first_name="Morgan", last_name="Placeholder", filing_status="HOH",
        wages=71_300, interest=95, dividends=410, social_security_taxable=0,
        schedule_1_total=0, schedule_1_adjustments=0,
        deduction_type="standard", deduction_amount=22_500,
        tax=5_100, nonrefundable_credits=2_000, other_taxes=0,
        withholding=6_400, refundable_credits=1_600,
        states=[
            {"code": "KS", "taxable_income": 48_000, "tax": 2_150, "withholding": 2_400},
            {"code": "MO", "taxable_income": 12_000, "tax": 420, "withholding": 300},
        ],
        prior_year={"agi": 68_900, "total_tax": 3_400, "refund": 1_900, "amount_owed": 0},
        comparison_page=False,
    ),
]


def prior_year_case(case: Case) -> Case | None:
    """A prior-year return for the same taxpayer, used to test prior-year pairing."""
    if not case.prior_year:
        return None
    py = copy.deepcopy(case)
    py.id = case.id + "-prior"
    py.tax_year = case.tax_year - 1
    py.prior_year = None
    py.comparison_page = False
    # scale figures so the prior-year AGI / tax match the comparison numbers exactly
    target_agi = case.prior_year["agi"]
    py.wages = target_agi + py.schedule_1_adjustments - (py.interest + py.dividends + py.ira_pensions + py.social_security_taxable + py.capital_gain + py.schedule_1_total)
    py.tax = case.prior_year["total_tax"] - py.schedule_2_total + py.nonrefundable_credits - py.other_taxes
    want_refund = case.prior_year.get("refund", 0)
    want_owed = case.prior_year.get("amount_owed", 0)
    py.estimates = 0
    py.refundable_credits = 0
    py.withholding = py.total_tax + want_refund - want_owed
    return py


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------


def money(n: int) -> str:
    if n < 0:
        return f"({abs(n):,})"
    return f"{n:,}"


class Layout:
    name = "generic"
    signature = "Generic Tax"
    label_font = "Helvetica"
    value_font = "Helvetica"
    label_x = 54
    value_x = 540  # right edge of value column
    line_h = 16
    leaders = False
    upper = False
    number_after_label = False
    separate_runs = False
    overlap = False

    def __init__(self, c: canvas.Canvas):
        self.c = c

    # -- primitives ----------------------------------------------------------
    def label(self, x: float, y: float, text: str, size: float = 9, max_right: float | None = None):
        # Real software shrinks long IRS line text so it never runs into the amount column.
        limit = (max_right if max_right is not None else self.value_x - 70) - x
        while size > 5.5 and pdfmetrics.stringWidth(text, self.label_font, size) > limit:
            size -= 0.5
        self.c.setFont(self.label_font, size)
        self.c.drawString(x, y, text.upper() if self.upper else text)
        if self.overlap:
            # Lacerte-style artifact: the same word drawn twice, offset by a hair.
            self.c.drawString(x + 0.15, y, text.split(" ")[0].upper() if self.upper else text.split(" ")[0])

    def value(self, y: float, text: str, size: float = 9, right: float | None = None):
        self.c.setFont(self.value_font, size)
        self.c.drawRightString(right or self.value_x, y, text)

    def line(self, y: float, number: str, text: str, amount: int | str | None, right: float | None = None):
        num = number
        if self.number_after_label:
            lbl = f"{text} {num}"
        else:
            lbl = f"{num} {text}"
        self.label(self.label_x, y, lbl)
        if self.leaders:
            self.c.setFont(self.label_font, 7)
            self.c.drawString(self.label_x + 300, y, ". . . . . . . . . . .")
        if amount is not None:
            s = money(amount) if isinstance(amount, int) else amount
            if self.separate_runs:
                # UltraTax: value drawn as its own text object at a fixed column, possibly on a slightly different baseline.
                self.c.saveState()
                self.c.translate(0, -0.6)
                self.value(y, s, right=right)
                self.c.restoreState()
            else:
                self.value(y, s, right=right)

    def header(self, text: str, y: float, size: float = 12):
        self.c.setFont("Helvetica-Bold", size)
        self.c.drawString(self.label_x, y, text)

    def footer(self, page_no: int, total: int, case: Case):
        self.c.setFont("Helvetica", 7)
        self.c.drawString(self.label_x, 28, f"{self.signature}  {case.tax_year} Form 1040  Page {page_no} of {total}")
        self.c.drawRightString(PAGE_W - 54, 28, f"{case.last_name}, {case.first_name}  {case.ssn}")


class UltraTaxLayout(Layout):
    name = "ultratax"
    signature = SOFTWARE_SIGNATURES["ultratax"]
    separate_runs = True
    value_x = 548


class LacerteLayout(Layout):
    name = "lacerte"
    signature = SOFTWARE_SIGNATURES["lacerte"]
    overlap = True
    value_x = 536


class CchLayout(Layout):
    name = "cch"
    signature = SOFTWARE_SIGNATURES["cch"]
    leaders = True
    value_x = 544


class GoSystemLayout(Layout):
    name = "gosystem"
    signature = SOFTWARE_SIGNATURES["gosystem"]
    upper = True
    label_font = "Courier"
    value_font = "Courier"
    value_x = 552


class DrakeLayout(Layout):
    name = "drake"
    signature = SOFTWARE_SIGNATURES["drake"]
    line_h = 14
    value_x = 530


class ProSeriesLayout(Layout):
    name = "proseries"
    signature = SOFTWARE_SIGNATURES["proseries"]
    number_after_label = True
    value_x = 546


LAYOUTS: dict[str, type[Layout]] = {
    "ultratax": UltraTaxLayout,
    "lacerte": LacerteLayout,
    "cch": CchLayout,
    "gosystem": GoSystemLayout,
    "drake": DrakeLayout,
    "proseries": ProSeriesLayout,
}


def page_count(case: Case) -> int:
    n = 2 + len(case.states)
    if case.schedule_1_total or case.schedule_1_adjustments:
        n += 1
    if case.deduction_type == "itemized":
        n += 1
    if case.comparison_page:
        n += 1
    if case.form_2210:
        n += 1
    return n


def draw_page1(L: Layout, case: Case, page: int, total: int):
    c = L.c
    y = PAGE_H - 60
    L.header(f"Form 1040 ({case.tax_year})", y, 13)
    c.setFont("Helvetica", 9)
    c.drawString(200, y, "U.S. Individual Income Tax Return")
    c.drawString(380, y, "OMB No. 1545-0074")
    c.drawRightString(PAGE_W - 54, y, f"Tax year {case.tax_year}")
    y -= 30
    # Name block: labels above values, as on the IRS form.
    L.label(L.label_x, y, "Your first name and middle initial", 7)
    L.label(260, y, "Last name", 7)
    L.label(420, y, "Your social security number", 7)
    y -= 13
    c.setFont("Helvetica", 10)
    c.drawString(L.label_x, y, case.first_name)
    c.drawString(260, y, case.last_name)
    c.drawString(420, y, case.ssn)
    if case.filing_status in ("MFJ", "MFS") and case.spouse_first_name:
        y -= 16
        L.label(L.label_x, y, "If joint return, spouse's first name and middle initial", 7)
        L.label(260, y, "Last name", 7)
        L.label(420, y, "Spouse's social security number", 7)
        y -= 13
        c.setFont("Helvetica", 10)
        c.drawString(L.label_x, y, case.spouse_first_name)
        c.drawString(260, y, case.last_name)
        c.drawString(420, y, case.spouse_ssn)
    y -= 16
    L.label(L.label_x, y, "Home address (number and street)", 7)
    y -= 13
    c.setFont("Helvetica", 10)
    c.drawString(L.label_x, y, "123 Example Street")
    c.drawString(300, y, "Springfield, MO 65801")
    y -= 24
    L.header("Filing Status", y, 10)
    y -= 14
    x = L.label_x
    for code, text in FILING_STATUS_TEXT.items():
        mark = "X" if code == case.filing_status else " "
        c.setFont("Helvetica", 8)
        c.drawString(x, y, f"[{mark}] {text}")
        x += 108
    y -= 26
    L.header("Income", y, 10)
    y -= L.line_h
    rows = [
        ("1a", "Total amount from Form(s) W-2, box 1", case.wages),
        ("1z", "Add lines 1a through 1h", case.wages),
        ("2a", "Tax-exempt interest", 0),
        ("2b", "Taxable interest", case.interest),
        ("3a", "Qualified dividends", 0),
        ("3b", "Ordinary dividends", case.dividends),
        ("4a", "IRA distributions", case.ira_distributions),
        ("4b", "Taxable amount", case.ira_distributions),
        ("5a", "Pensions and annuities", case.pensions),
        ("5b", "Taxable amount", case.pensions),
        ("6a", "Social security benefits", case.social_security_taxable),
        ("6b", "Taxable amount", case.social_security_taxable),
        ("7a", "Capital gain or (loss). Attach Schedule D if required", case.capital_gain),
        ("8", "Additional income from Schedule 1, line 10", case.schedule_1_total),
        ("9", "Add lines 1z, 2b, 3b, 4b, 5b, 6b, 7a, and 8. This is your total income", case.total_income),
        ("10", "Adjustments to income from Schedule 1, line 26", case.schedule_1_adjustments),
        ("11a", "Subtract line 10 from line 9. This is your adjusted gross income", case.agi),
    ]
    for num, text, amt in rows:
        L.line(y, num, text, amt)
        y -= L.line_h
    L.footer(page, total, case)


def draw_page2(L: Layout, case: Case, page: int, total: int):
    c = L.c
    y = PAGE_H - 60
    L.header(f"Form 1040 ({case.tax_year})", y, 11)
    c.setFont("Helvetica", 8)
    c.drawString(300, y, f"{case.first_name} {case.last_name}  {case.ssn}")
    c.drawRightString(PAGE_W - 54, y, "Page 2")
    y -= 26
    L.header("Tax and Credits", y, 10)
    y -= L.line_h
    ded_label = "Standard deduction or itemized deductions (from Schedule A)"
    rows = [
        ("11b", "Amount from line 11a (adjusted gross income)", case.agi),
        ("12e", ded_label, case.deduction_amount),
        ("13a", "Qualified business income deduction from Form 8995 or Form 8995-A", case.qbi),
        ("13b", "Additional deductions from Schedule 1-A, line 38", 0),
        ("14", "Add lines 12e, 13a, and 13b", case.deduction_amount + case.qbi),
        ("15", "Subtract line 14 from line 11b. This is your taxable income", case.taxable_income),
        ("16", "Tax", case.tax),
        ("17", "Amount from Schedule 2, line 3", case.schedule_2_total),
        ("18", "Add lines 16 and 17", case.tax + case.schedule_2_total),
        ("19", "Child tax credit or credit for other dependents from Schedule 8812", case.nonrefundable_credits),
        ("20", "Amount from Schedule 3, line 8", 0),
        ("21", "Add lines 19 and 20", case.nonrefundable_credits),
        ("22", "Subtract line 21 from line 18. If zero or less, enter -0-", max(0, case.tax + case.schedule_2_total - case.nonrefundable_credits)),
        ("23", "Other taxes, including self-employment tax, from Schedule 2, line 21", case.other_taxes),
        ("24", "Add lines 22 and 23. This is your total tax", case.total_tax),
    ]
    for num, text, amt in rows:
        L.line(y, num, text, amt)
        y -= L.line_h
    y -= 8
    L.header("Payments", y, 10)
    y -= L.line_h
    rows = [
        ("25d", "Federal income tax withheld", case.withholding),
        ("26", f"{case.tax_year} estimated tax payments and amount applied from {case.tax_year - 1} return", case.estimates),
        ("27a", "Earned income credit (EIC)", 0),
        ("28", "Additional child tax credit from Schedule 8812", case.refundable_credits),
        ("29", "American opportunity credit from Form 8863, line 8", 0),
        ("31", "Amount from Schedule 3, line 15", 0),
        ("32", "Add lines 27a, 28, 29, 30, and 31. These are your total other payments and refundable credits", case.refundable_credits),
        ("33", "Add lines 25d, 26, and 32. These are your total payments", case.total_payments),
    ]
    for num, text, amt in rows:
        L.line(y, num, text, amt)
        y -= L.line_h
    y -= 8
    L.header("Refund", y, 10)
    y -= L.line_h
    rows = [
        ("34", "If line 33 is more than line 24, subtract line 24 from line 33. This is the amount you overpaid", case.overpaid),
        ("35a", "Amount of line 34 you want refunded to you", case.refund),
        ("36", f"Amount of line 34 you want applied to your {case.tax_year + 1} estimated tax", case.applied_to_next_year),
    ]
    for num, text, amt in rows:
        L.line(y, num, text, amt)
        y -= L.line_h
    c.setFont("Helvetica", 7)
    c.drawString(L.label_x + 20, y, f"b Routing number {case.routing}   c Type: Checking   d Account number {case.bank_account}")
    y -= L.line_h + 4
    L.header("Amount You Owe", y, 10)
    y -= L.line_h
    L.line(y, "37", "Subtract line 33 from line 24. This is the amount you owe", case.amount_owed)
    y -= L.line_h
    L.line(y, "38", "Estimated tax penalty", case.estimated_tax_penalty)
    y -= L.line_h * 2
    L.header("Sign Here", y, 10)
    y -= L.line_h
    c.setFont("Helvetica", 8)
    c.drawString(L.label_x, y, "Your signature ______________________   Date __________   Your occupation: Analyst")
    L.footer(page, total, case)


def draw_schedule1(L: Layout, case: Case, page: int, total: int):
    y = PAGE_H - 60
    L.header(f"Schedule 1 (Form 1040) {case.tax_year}", y, 12)
    L.c.setFont("Helvetica", 9)
    L.c.drawString(300, y, "Additional Income and Adjustments to Income   OMB No. 1545-0074")
    y -= 26
    L.header("Part I  Additional Income", y, 10)
    y -= L.line_h
    L.line(y, "3", "Business income or (loss). Attach Schedule C", case.schedule_1_total)
    y -= L.line_h
    L.line(y, "10", "Combine lines 1 through 7 and 9. This is your additional income", case.schedule_1_total)
    y -= L.line_h * 2
    L.header("Part II  Adjustments to Income", y, 10)
    y -= L.line_h
    L.line(y, "20", "IRA deduction", case.schedule_1_adjustments)
    y -= L.line_h
    L.line(y, "26", "Add lines 11 through 23 and 25. These are your adjustments to income", case.schedule_1_adjustments)
    L.footer(page, total, case)


def draw_schedule_a(L: Layout, case: Case, page: int, total: int):
    y = PAGE_H - 60
    L.header(f"Schedule A (Form 1040) {case.tax_year}", y, 12)
    L.c.setFont("Helvetica", 9)
    L.c.drawString(230, y, "Itemized Deductions   OMB No. 1545-0074")
    y -= 26
    taxes = min(10_000, case.deduction_amount // 2)
    interest = case.deduction_amount - taxes - 1_500
    rows = [
        ("5e", "State and local taxes", taxes),
        ("10", "Home mortgage interest and points", interest),
        ("14", "Gifts to charity", 1_500),
        ("17", "Total itemized deductions. Add lines 4, 7, 10, 14, 15, and 16", case.deduction_amount),
    ]
    for num, text, amt in rows:
        L.line(y, num, text, amt)
        y -= L.line_h
    L.footer(page, total, case)


def draw_state(L: Layout, case: Case, st: dict, page: int, total: int):
    c = L.c
    code = st["code"]
    res = state_result(st)
    y = PAGE_H - 60
    L.header(f"{STATE_FORMS.get(code, code + '-1040')} {case.tax_year}", y, 12)
    c.setFont("Helvetica", 9)
    c.drawString(220, y, f"{STATE_NAMES.get(code, code)} Individual Income Tax Return")
    y -= 26
    c.setFont("Helvetica", 9)
    c.drawString(L.label_x, y, f"{case.first_name} {case.last_name}   {case.ssn}   Filing status: {FILING_STATUS_TEXT[case.filing_status]}")
    y -= 26
    rows = [
        ("1", "Federal adjusted gross income", case.agi),
        ("8", f"{STATE_NAMES.get(code, code)} taxable income", res["taxable_income"]),
        ("12", f"{STATE_NAMES.get(code, code)} income tax", res["tax"]),
        ("20", f"{STATE_NAMES.get(code, code)} tax withheld", st["withholding"]),
        ("21", "Estimated tax payments", st.get("estimates", 0)),
        ("24", "Total payments and credits", res["payments"]),
        ("30", "Overpayment / Refund", res["refund"]),
        ("33", "Amount due", res["amount_owed"]),
    ]
    for num, text, amt in rows:
        L.line(y, num, text, amt)
        y -= L.line_h
    c.setFont("Helvetica", 7)
    c.drawString(L.label_x, 28, f"{L.signature}  {STATE_FORMS.get(code, code)}  Page {page} of {total}")


def draw_comparison(L: Layout, case: Case, page: int, total: int):
    c = L.c
    py = case.prior_year or {}
    y = PAGE_H - 60
    L.header("Two-Year Comparison", y, 12)
    y -= 26
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(400, y, str(case.tax_year - 1))
    c.drawRightString(500, y, str(case.tax_year))
    c.drawRightString(580, y, "Difference")
    y -= L.line_h
    rows = [
        ("Adjusted gross income", py.get("agi", 0), case.agi),
        ("Taxable income", py.get("taxable_income", max(0, py.get("agi", 0) - case.deduction_amount)), case.taxable_income),
        ("Total tax", py.get("total_tax", 0), case.total_tax),
        ("Total payments", py.get("total_tax", 0) + py.get("refund", 0) - py.get("amount_owed", 0), case.total_payments),
        ("Refund", py.get("refund", 0), case.refund),
        ("Amount owed", py.get("amount_owed", 0), case.amount_owed),
    ]
    for text, prior, cur in rows:
        L.label(L.label_x, y, text)
        L.value(y, money(prior), right=400)
        L.value(y, money(cur), right=500)
        L.value(y, money(cur - prior), right=580)
        y -= L.line_h
    L.footer(page, total, case)


def draw_2210(L: Layout, case: Case, page: int, total: int):
    y = PAGE_H - 60
    L.header(f"Form 2210 ({case.tax_year})", y, 12)
    L.c.setFont("Helvetica", 9)
    L.c.drawString(200, y, "Underpayment of Estimated Tax by Individuals, Estates, and Trusts")
    y -= 26
    L.line(y, "19", "Penalty", case.estimated_tax_penalty)
    L.footer(page, total, case)


def render(case: Case, software: str, out_pdf: Path) -> None:
    c = canvas.Canvas(str(out_pdf), pagesize=letter)
    c.setTitle(f"{case.tax_year} Form 1040")
    c.setAuthor(SOFTWARE_SIGNATURES[software])
    L = LAYOUTS[software](c)
    total = page_count(case)
    page = 1
    draw_page1(L, case, page, total)
    c.showPage()
    page += 1
    draw_page2(L, case, page, total)
    c.showPage()
    page += 1
    if case.schedule_1_total or case.schedule_1_adjustments:
        draw_schedule1(L, case, page, total)
        c.showPage()
        page += 1
    if case.deduction_type == "itemized":
        draw_schedule_a(L, case, page, total)
        c.showPage()
        page += 1
    if case.form_2210:
        draw_2210(L, case, page, total)
        c.showPage()
        page += 1
    for st in case.states:
        draw_state(L, case, st, page, total)
        c.showPage()
        page += 1
    if case.comparison_page:
        draw_comparison(L, case, page, total)
        c.showPage()
        page += 1
    c.save()


def write_fixture(case: Case, software: str, out_dir: Path) -> Path:
    stem = f"{software}-1040-{case.tax_year}-{case.id}"
    pdf = out_dir / f"{stem}.pdf"
    render(case, software, pdf)
    (out_dir / f"{stem}.expected.json").write_text(json.dumps(expected_json(case, software), indent=2) + "\n", encoding="utf-8")
    return pdf


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "tests" / "fixtures"))
    ap.add_argument("--software", choices=list(LAYOUTS) + ["all"], default="all")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)
    if args.list:
        for c in CASES:
            print(c.id)
        return 0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    softwares = list(LAYOUTS) if args.software == "all" else [args.software]
    written = []
    for sw in softwares:
        for case in CASES:
            written.append(write_fixture(case, sw, out))
            prior = prior_year_case(case)
            if prior:
                written.append(write_fixture(prior, sw, out))
    print(f"wrote {len(written)} fixtures to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
