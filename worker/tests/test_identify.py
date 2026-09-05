from pathlib import Path

import pytest

from recap.extract.identify import detect_tax_year, identify

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
PROFILES = Path(__file__).resolve().parents[2] / "form-profiles"
SOFTWARE = ["ultratax", "lacerte", "cch", "gosystem", "drake", "proseries"]


@pytest.mark.parametrize("software", SOFTWARE)
def test_identify_each_layout(software):
    ident = identify(str(FIXTURES / f"{software}-1040-2025-mfj-refund-mo.pdf"), str(PROFILES))
    assert ident.software == software
    assert ident.form == "1040"
    assert ident.tax_year == 2025
    assert ident.first_name == "Alex"
    assert ident.last_name == "Fixture"
    assert ident.spouse_first_name == "Jordan"
    assert ident.page_count == 5
    assert ident.text_coverage == 1.0


def test_identify_single_and_prior_year():
    ident = identify(str(FIXTURES / "drake-1040-2025-single-owed-itemized.pdf"), str(PROFILES))
    assert (ident.first_name, ident.last_name, ident.spouse_first_name) == ("Casey", "Sample", None)
    prior = identify(str(FIXTURES / "drake-1040-2024-mfj-refund-mo-prior.pdf"), str(PROFILES))
    assert prior.tax_year == 2024


def test_detect_tax_year_prefers_header():
    assert detect_tax_year("Form 1040 (2025) ... 2026 estimated tax ... 2024 return") == 2025
    assert detect_tax_year("no years here") is None
