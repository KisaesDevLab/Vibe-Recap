"""Real client returns, when present on this machine (tests/fixtures/real/, gitignored).

Skipped in CI. On a box that has them, every PDF must identify, extract, reconcile, and be read
by the verifier with the same year, filing status, and states. Nothing from a return is printed:
assertion messages carry file index, page counts, and check names only.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from recap.extract.identify import identify
from recap.extract.run import extract_return
from recap.verify.pdftext import read_pdf
from recap.verify.verify import read_return

ROOT = Path(__file__).resolve().parents[2]
REAL = ROOT / "tests" / "fixtures" / "real"
PROFILES = ROOT / "form-profiles"
PDFS = sorted(REAL.glob("*.pdf")) if REAL.exists() else []

pytestmark = pytest.mark.skipif(not PDFS, reason="no real returns under tests/fixtures/real/")


@pytest.mark.parametrize("idx", range(len(PDFS)), ids=[f"return-{i}" for i in range(len(PDFS))])
def test_real_return_extracts_and_reconciles(idx):
    pdf = PDFS[idx]
    ident = identify(str(pdf), str(PROFILES))
    assert ident.software != "unknown", f"return-{idx}: software not identified"
    assert ident.form == "1040" and ident.tax_year, f"return-{idx}: form/year not identified"
    assert ident.form_page and ident.form_page > 1 or ident.page_count < 5, f"return-{idx}: form page not located"
    assert ident.first_name and ident.last_name, f"return-{idx}: names not found"
    assert ident.first_name == ident.first_name.title() or not ident.first_name.isupper(), f"return-{idx}: name left in capitals"

    ex = extract_return(str(pdf), str(PROFILES), ident)
    failed = [c["name"] for c in ex["recon"]["checks"] if not c["ok"]]
    assert ex["recon"]["passed"], f"return-{idx}: recon failed {failed}"
    assert ex["income"]["total_income"] > 0 and ex["adjustments"]["agi"] > 0, f"return-{idx}: empty income"
    assert ex["deductions"]["amount"] > 0 and ex["deductions"]["taxable_income"] >= 0, f"return-{idx}: deductions"
    assert (ex["result"]["refund"] > 0) != (ex["result"]["amount_owed"] > 0) or (ex["result"]["refund"] == 0 == ex["result"]["amount_owed"]), f"return-{idx}: direction"
    assert "extras" in ex, f"return-{idx}: extras missing"
    for st in ex["state"]:
        assert st["tax"] > 0 and st["payments"] > 0, f"return-{idx}: state {st['code']} figures missing"

    facts = read_return(read_pdf(str(pdf)), None, str(PROFILES))
    assert facts.tax_year == ident.tax_year, f"return-{idx}: verifier year differs"
    assert facts.filing_status == ex["meta"]["filing_status"], f"return-{idx}: verifier filing status differs"
    assert facts.states == ex["meta"]["state_returns"], f"return-{idx}: verifier states differ"
    assert facts.first_name and facts.first_name.casefold() == ident.first_name.casefold(), f"return-{idx}: verifier first name differs"
    for key in ("total_income", "agi", "taxable_income", "total_tax"):
        assert key in facts.lines, f"return-{idx}: verifier missing {key}"
    assert facts.lines["agi"] == ex["adjustments"]["agi"], f"return-{idx}: verifier AGI differs from extraction"
    assert facts.lines["total_tax"] == ex["tax"]["total_tax"], f"return-{idx}: verifier total tax differs"
    if ex["prior_year"]["present"]:
        assert facts.prior.get("agi") == ex["prior_year"]["agi"], f"return-{idx}: verifier prior AGI differs"
