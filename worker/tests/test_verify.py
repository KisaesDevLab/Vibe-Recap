"""Verifier tests: golden scripts trace to the return; corrupted extractions and wrong facts fail."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from recap.validate import validate_script
from recap.verify.verify import verify

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
GOLDEN = FIXTURES / "scripts"
PROFILES = ROOT / "form-profiles"
SOFTWARE = ["ultratax", "lacerte", "cch", "gosystem", "drake", "proseries"]
CASES = ["mfj-refund-mo", "single-owed-itemized", "hoh-refund-two-states"]


def golden(case: str) -> str:
    return (GOLDEN / f"{case}.md").read_text(encoding="utf-8")


def flagged(v):
    return [(i.kind, i.text, i.reason) for i in v.items if i.status == "flagged"]


def test_verifier_does_not_import_extract():
    """Independence rule: verify/ may share only recap.numbers with extract/."""
    for py in (ROOT / "worker" / "recap" / "verify").glob("*.py"):
        src = py.read_text(encoding="utf-8")
        for m in re.finditer(r"^\s*(?:from|import)\s+([\w.]+)", src, re.M):
            mod = m.group(1)
            assert "extract" not in mod, f"{py.name} imports {mod}"
            if mod.startswith("recap.") or mod.startswith(".."):
                assert mod in ("..numbers", "recap.numbers", ".pdftext", "..pipeline"), f"{py.name} imports {mod}"


@pytest.mark.parametrize("software", SOFTWARE)
@pytest.mark.parametrize("case", CASES)
def test_golden_scripts_trace_to_every_layout(software, case):
    pdf = FIXTURES / f"{software}-1040-2025-{case}.pdf"
    v = verify(golden(case), str(pdf), None, str(PROFILES))
    assert v.passed, flagged(v)
    amounts = [i for i in v.items if i.kind == "amount"]
    assert amounts and all(i.page and i.label for i in amounts)
    assert any(i.kind == "direction" and i.status == "verified" for i in v.items)
    assert any(i.kind == "names" and i.status == "verified" for i in v.items)


def test_prior_year_pdf_supports_yoy_sentences():
    pdf = FIXTURES / "drake-1040-2025-mfj-refund-mo.pdf"
    prior = FIXTURES / "drake-1040-2024-mfj-refund-mo-prior.pdf"
    v = verify(golden("mfj-refund-mo"), str(pdf), str(prior), str(PROFILES))
    assert v.passed, flagged(v)
    assert any(i.kind == "yoy" and i.status == "verified" for i in v.items)


def test_corrupted_extraction_passes_validate_but_fails_verify():
    """AGI swapped with taxable income: internally consistent JSON, wrong against the return."""
    case = "mfj-refund-mo"
    ex = json.loads((FIXTURES / f"ultratax-1040-2025-{case}.expected.json").read_text())
    agi, ti = ex["adjustments"]["agi"], ex["deductions"]["taxable_income"]
    ex["adjustments"]["agi"], ex["deductions"]["taxable_income"] = ti, agi
    script = golden(case).replace("$147,300", "$TMP").replace("$117,300", "$147,300").replace("$TMP", "$117,300")
    assert validate_script(script, ex).ok  # every number still exists in the (corrupted) JSON
    v = verify(script, str(FIXTURES / f"ultratax-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert not v.passed
    reasons = [r for k, _, r in flagged(v) if k == "amount"]
    assert any("adjusted gross income" in (r or "") for r in reasons), flagged(v)
    assert any("taxable income" in (r or "") for r in reasons), flagged(v)


def test_percent_recomputed_from_the_return():
    case = "mfj-refund-mo"
    pdf = str(FIXTURES / f"ultratax-1040-2025-{case}.pdf")
    assert verify(golden(case).replace("12.1%", "9.6%"), pdf, None, str(PROFILES)).passed  # tax / AGI
    v3 = verify(golden(case).replace("12.1%", "11.2%"), pdf, None, str(PROFILES))
    assert not v3.passed and any(k == "percent" for k, _, _ in flagged(v3))


def test_wrong_amount_is_flagged_with_reason():
    case = "hoh-refund-two-states"
    script = golden(case).replace("$4,900", "$4,950")
    v = verify(script, str(FIXTURES / f"cch-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert not v.passed
    assert ("amount", "$4,950", "not found on any page of the return") in flagged(v)
    assert any(k == "coverage" and t == "result" for k, t, _ in flagged(v))


def test_direction_refund_vs_owed_is_a_hard_check():
    case = "single-owed-itemized"
    script = golden(case).replace("the return shows a balance due of $1,640", "the return shows a refund of $1,640")
    v = verify(script, str(FIXTURES / f"gosystem-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert any(k == "direction" for k, _, _ in flagged(v)), flagged(v)


def test_yoy_without_prior_source_fails():
    case = "hoh-refund-two-states"  # no comparison page, no prior PDF
    script = golden(case).replace(
        "Your withholding covered 206.5% of your total tax, which is why the federal refund was so large.",
        "Compared with last year your refund grew by $1,000, and withholding covered 206.5% of your total tax.",
    )
    v = verify(script, str(FIXTURES / f"lacerte-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert any(k == "yoy" and "no prior-year" in (r or "") for k, _, r in flagged(v)), flagged(v)


def test_bank_account_and_address_and_name_checks():
    case = "mfj-refund-mo"
    pdf = str(FIXTURES / f"proseries-1040-2025-{case}.pdf")
    with_acct = golden(case).replace("We look forward", "Your account 123456789 is on file. We look forward")
    v = verify(with_acct, pdf, None, str(PROFILES))
    assert any(k == "absence" for k, _, _ in flagged(v))
    with_addr = golden(case).replace("We look forward", "We have 123 Example Street on file. We look forward")
    v = verify(with_addr, pdf, None, str(PROFILES))
    assert any(k == "absence" and t == "address" for k, t, _ in flagged(v))
    wrong_name = golden(case).replace("Hi Alex and Jordan.", "Hi Taylor and Jordan.")
    v = verify(wrong_name, pdf, None, str(PROFILES))
    assert any(k == "names" for k, _, _ in flagged(v))


def test_filing_status_state_and_deduction_mismatches():
    pdf = str(FIXTURES / f"ultratax-1040-2025-mfj-refund-mo.pdf")
    v = verify(golden("mfj-refund-mo").replace("filed jointly", "filed as head of household"), pdf, None, str(PROFILES))
    assert any(k == "filing_status" for k, _, _ in flagged(v))
    v = verify(golden("mfj-refund-mo").replace("Missouri also came out in your favor", "Kansas also came out in your favor"), pdf, None, str(PROFILES))
    assert any(k == "state" and t == "KS" for k, t, _ in flagged(v))
    v = verify(golden("mfj-refund-mo").replace("You used the standard deduction of $30,000", "You itemized deductions of $30,000"), pdf, None, str(PROFILES))
    assert any(k == "deduction_type" for k, _, _ in flagged(v))
    v = verify(golden("mfj-refund-mo").replace("your 2025 federal", "your 2024 federal"), pdf, None, str(PROFILES))
    assert any(k == "tax_year" for k, _, _ in flagged(v))
