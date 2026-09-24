"""Preparer overrides of extracted figures (Q66): applied before recon, recorded, never loosening a gate."""

import shutil
from pathlib import Path

import pytest

from recap.extract.mapper import ExtractionError
from recap.extract.overrides import apply_overrides, is_overridable
from recap.extract.run import extract_return
from recap.validate import allowed_amounts

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
PROFILES = Path(__file__).resolve().parents[2] / "form-profiles"
PDF = str(FIXTURES / "ultratax-1040-2025-mfj-refund-mo.pdf")


def test_overridable_paths():
    assert is_overridable("income.dividends")
    assert is_overridable("result.applied_to_next_year")
    assert is_overridable("prior_year.refund")
    assert is_overridable("state.MO.refund")
    assert not is_overridable("state.mo.refund")
    assert not is_overridable("state.MO.code")
    assert not is_overridable("tax.effective_rate")
    assert not is_overridable("deductions.type")
    assert not is_overridable("meta.filing_status")
    assert not is_overridable("taxpayer.first_name")
    assert not is_overridable("recon.passed")


def test_override_lands_before_recon_and_observations():
    plain = extract_return(PDF, str(PROFILES))
    assert plain["recon"]["passed"]
    wages = plain["income"]["wages"]
    doc = extract_return(PDF, str(PROFILES), overrides=[{"id": "o1", "path": "income.wages", "value": wages + 500}])
    assert doc["income"]["wages"] == wages + 500
    # A wrong override is caught by recon exactly like a misread line would be.
    assert [c["name"] for c in doc["recon"]["checks"] if not c["ok"]] == ["total_income_foots"]
    assert doc["overrides"] == [{"id": "o1", "path": "income.wages", "extracted": wages, "value": wages + 500, "matches_extracted": False}]


def test_override_recomputes_effective_rate_and_observations():
    plain = extract_return(PDF, str(PROFILES))
    total_tax = plain["tax"]["total_tax"]
    doc = extract_return(PDF, str(PROFILES), overrides=[{"id": "o1", "path": "tax.total_tax", "value": total_tax + 100}])
    assert doc["tax"]["effective_rate"] == round((total_tax + 100) / doc["deductions"]["taxable_income"], 4)
    if plain["prior_year"]["present"]:
        yoy = next(o for o in doc["observations"] if o["id"] == "yoy_total_tax")
        assert yoy["delta"] == total_tax + 100 - plain["prior_year"]["total_tax"]


def test_matching_override_is_flagged_redundant():
    plain = extract_return(PDF, str(PROFILES))
    doc = extract_return(PDF, str(PROFILES), overrides=[{"id": "o1", "path": "income.wages", "value": plain["income"]["wages"]}])
    assert doc["overrides"][0]["matches_extracted"] is True
    assert doc["recon"]["passed"]


def test_misread_figure_never_becomes_an_allowed_amount():
    # The validator reads only the figure sections, so the mapper's misread value, which the
    # extraction keeps under `overrides`, can never justify a number in the script.
    doc = extract_return(PDF, str(PROFILES), overrides=[{"id": "o1", "path": "income.wages", "value": 987_654}])
    doc["overrides"][0]["extracted"] = 13_579  # a value that appears nowhere else in the extraction
    doc["evidence"]["income.wages"][0]["page"] = 24_680
    allowed = allowed_amounts(doc)
    assert 987_654 in allowed
    assert 13_579 not in allowed and 24_680 not in allowed


def test_state_override_can_add_a_missed_state():
    doc = {"meta": {"state_returns": []}, "state": []}
    applied = apply_overrides(doc, [{"id": "o1", "path": "state.AR.refund", "value": 4239}])
    assert doc["state"] == [{"code": "AR", "taxable_income": 0, "tax": 0, "payments": 0, "refund": 4239, "amount_owed": 0, "penalty": 0}]
    assert doc["meta"]["state_returns"] == ["AR"]
    assert applied[0]["extracted"] is None


def test_unknown_paths_are_ignored_and_reported():
    doc = {"meta": {"filing_status": "MFJ"}}
    applied = apply_overrides(doc, [{"id": "o1", "path": "meta.filing_status", "value": 1}, {"id": "o2", "path": "income.wages", "value": True}])
    assert doc["meta"]["filing_status"] == "MFJ"
    assert [a.get("ignored") for a in applied] == [True, True]


def test_override_supplies_a_required_line_the_mapper_could_not_find(tmp_path):
    profiles = tmp_path / "profiles"
    shutil.copytree(PROFILES, profiles)
    base = profiles / "_base-1040.yaml"
    base.write_text(base.read_text().replace("line: '24', label: 'total tax'", "line: '24', label: 'no such label'"))
    with pytest.raises(ExtractionError, match="tax.total_tax"):
        extract_return(PDF, str(profiles))
    total_tax = extract_return(PDF, str(PROFILES))["tax"]["total_tax"]
    doc = extract_return(PDF, str(profiles), overrides=[{"id": "o1", "path": "tax.total_tax", "value": total_tax}])
    assert doc["tax"]["total_tax"] == total_tax
    assert doc["overrides"][0]["extracted"] is None
    assert doc["recon"]["passed"]


def test_extraction_records_where_each_figure_was_read():
    doc = extract_return(PDF, str(PROFILES))
    ev = doc["evidence"]["income.total_income"][0]
    assert ev["line"] == "9" and ev["page"] >= 1 and "total income" in ev["label"].lower()
    assert len(doc["evidence"]["income.ira_pensions"]) <= 2  # 4b and 5b both feed one figure
