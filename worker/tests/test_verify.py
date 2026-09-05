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


def test_state_balance_due_without_state_name_is_not_federal_direction():
    """HOH two-state fixture: federal refund, Kansas refund, Missouri balance due $120."""
    case = "hoh-refund-two-states"
    script = golden(case).replace(
        "Missouri went the other way, with a small state balance due of $120.",
        "Missouri went the other way. You also owe a small balance due of $120 there.",
    )
    v = verify(script, str(FIXTURES / f"cch-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert not any(k == "direction" for k, _, _ in flagged(v)), flagged(v)
    # but a federal-looking balance-due sentence with a federal amount is still caught
    bad = golden(case).replace("the return shows a federal refund of $4,900", "the return shows a federal balance due of $4,900")
    v = verify(bad, str(FIXTURES / f"cch-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert any(k == "direction" for k, _, _ in flagged(v)), flagged(v)


def test_negated_direction_phrases_are_not_direction_claims():
    """'You don't owe anything' on a refund return states the same direction, not the opposite."""
    case = "mfj-refund-mo"
    script = golden(case).replace(
        "[[slide:next]]",
        "Your total tax owed was $14,153. You do not owe anything to the IRS this year, and there is no balance due. [[slide:next]]",
    )
    v = verify(script, str(FIXTURES / f"ultratax-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert not any(k == "direction" for k, _, _ in flagged(v)), flagged(v)
    # an actual claim of a balance due is still caught, and the reason quotes the sentence
    bad = golden(case).replace("[[slide:next]]", "That leaves a balance due to the IRS. [[slide:next]]")
    v = verify(bad, str(FIXTURES / f"ultratax-1040-2025-{case}.pdf"), None, str(PROFILES))
    reasons = [r for k, _, r in flagged(v) if k == "direction"]
    assert reasons and "That leaves a balance due" in reasons[0], flagged(v)


def test_zero_amount_and_owed_a_refund_phrasing_and_capitalised_names():
    """A return with a zero total tax prints "0" in the amount column; "you're owed a refund" is the
    refund direction; names printed in capitals on the return match Title-case names in the script."""
    case = "mfj-refund-mo"
    script = golden(case).replace("[[slide:next]]", "This means you're owed a refund, not a balance due. [[slide:next]]")
    v = verify(script, str(FIXTURES / f"ultratax-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert not any(k == "direction" for k, _, _ in flagged(v)), flagged(v)
    # "$0" must trace to a printed zero: the fixture prints 0 on line 10 (adjustments) via Schedule 1? No:
    # every fixture prints "0" for blank IRA/pension lines, so a script saying $0 is supported.
    script0 = golden(case).replace("[[slide:next]]", "You had $0 of pension income this year. [[slide:next]]")
    v = verify(script0, str(FIXTURES / f"ultratax-1040-2025-{case}.pdf"), None, str(PROFILES))
    assert not any(k == "amount" and t == "$0" for k, t, _ in flagged(v)), flagged(v)
