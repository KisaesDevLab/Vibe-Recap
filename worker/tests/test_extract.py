import json
from pathlib import Path

import pytest

from recap.extract.mapper import ExtractionError
from recap.extract.recon import failures, reconcile
from recap.extract.run import extract_return

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
PROFILES = Path(__file__).resolve().parents[2] / "form-profiles"
SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
SOFTWARE = ["ultratax", "lacerte", "cch", "gosystem", "drake", "proseries"]
CASES = ["mfj-refund-mo", "single-owed-itemized", "hoh-refund-two-states"]


def load_expected(stem: str) -> dict:
    return json.loads((FIXTURES / f"{stem}.expected.json").read_text())


def strip_volatile(doc: dict) -> dict:
    d = json.loads(json.dumps(doc))
    d["meta"].pop("profile", None)
    d["prior_year"].pop("source", None)
    return d


@pytest.mark.parametrize("software", SOFTWARE)
@pytest.mark.parametrize("case", CASES)
def test_every_fixture_matches_expected(software, case):
    stem = f"{software}-1040-2025-{case}"
    doc = extract_return(str(FIXTURES / f"{stem}.pdf"), str(PROFILES))
    assert strip_volatile(doc) == load_expected(stem)


@pytest.mark.parametrize("software", ["ultratax", "proseries"])
def test_prior_year_pdf_beats_comparison_page(software):
    stem = f"{software}-1040-2025-mfj-refund-mo"
    doc = extract_return(
        str(FIXTURES / f"{stem}.pdf"), str(PROFILES), prior_pdf_path=str(FIXTURES / f"{software}-1040-2024-mfj-refund-mo-prior.pdf")
    )
    exp = load_expected(stem)
    assert doc["prior_year"]["source"] == "prior_pdf"
    assert {k: doc["prior_year"][k] for k in ("present", "agi", "total_tax", "refund", "amount_owed")} == exp["prior_year"]
    assert doc["observations"] == exp["observations"]


def test_mutated_fixture_fails_recon_with_the_right_check():
    stem = "drake-1040-2025-mfj-refund-mo"
    doc = extract_return(str(FIXTURES / f"{stem}.pdf"), str(PROFILES))
    doc["income"]["wages"] += 500  # one wrong line
    recon = reconcile(doc)
    assert recon["passed"] is False
    assert [c["name"] for c in failures(recon)] == ["total_income_foots"]
    downgraded = reconcile(doc, {"total_income_foots"})
    assert downgraded["passed"] is True
    row = next(c for c in downgraded["checks"] if c["name"] == "total_income_foots")
    assert row["ok"] is False and row["warning"] is True and row["actual"] != row["expected"]


def test_unknown_software_uses_generic_profile(tmp_path):
    import runpy

    mf = runpy.run_path(str(SCRIPTS / "make-fixture.py"), run_name="fixture_module")
    case = mf["CASES"][0]
    out = tmp_path / "generic.pdf"
    L = mf["LAYOUTS"]["drake"]
    orig = L.signature
    L.signature = "Some Other Tax Program"
    try:
        mf["render"](case, "drake", out)
    finally:
        L.signature = orig
    doc = extract_return(str(out), str(PROFILES))
    assert doc["meta"]["software"] == "unknown"
    assert doc["meta"]["profile"] == "1040-2025-generic.yaml"
    assert doc["recon"]["passed"] is True


def test_missing_required_line_is_a_clean_failure(tmp_path):
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(tmp_path / "bad.pdf"))
    c.drawString(72, 700, "Form 1040 (2025) U.S. Individual Income Tax Return")
    c.drawString(72, 680, "Filing Status [X] Single")
    c.drawString(72, 660, "UltraTax CS")
    c.save()
    with pytest.raises(ExtractionError, match="required lines missing"):
        extract_return(str(tmp_path / "bad.pdf"), str(PROFILES))
