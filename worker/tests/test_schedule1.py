"""Schedule 1 by kind of income (Q69): named only when the lines foot to Form 1040 line 8."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from recap import schedule1
from recap.extract.overrides import is_overridable
from recap.extract.recon import failures, reconcile
from recap.extract.run import extract_return
from recap.render import slides
from recap.script.generate import build_facts
from recap.validate import validate_script
from recap.verify.verify import verify

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
PROFILES = ROOT / "form-profiles"
SOFTWARE = ["ultratax", "lacerte", "cch", "gosystem", "drake", "proseries"]
CASE = "mfj-refund-mo"  # line 8 of $2,000: business income of $3,200 less a Schedule E loss of $1,200

LUMP = "other income of $2,000 reported on Schedule 1"
BY_KIND = "business income of $3,200, and a combined loss of $1,200 from rental real estate and partnerships"


def extraction(case: str = CASE) -> dict:
    return json.loads((FIXTURES / f"ultratax-1040-2025-{case}.expected.json").read_text())


def script_by_kind(business: str = "$3,200") -> str:
    golden = (FIXTURES / "scripts" / f"{CASE}.md").read_text(encoding="utf-8")
    assert LUMP in golden
    return golden.replace(LUMP, BY_KIND.replace("$3,200", business))


@pytest.mark.parametrize("software", SOFTWARE)
def test_schedule_1_lines_are_read_on_every_layout(software):
    doc = extract_return(str(FIXTURES / f"{software}-1040-2025-{CASE}.pdf"), str(PROFILES))
    assert schedule1.parts(doc) == [("business", 3_200), ("rental_partnership", -1_200)]
    row = next(c for c in doc["recon"]["checks"] if c["name"] == "schedule_1_foots")
    assert row["ok"] and row["expected"] == row["actual"] == 2_000


def test_package_without_schedule_1_has_no_check_and_no_kinds():
    ex = extraction("single-owed-itemized")
    assert schedule1.breakdown(ex) == []
    assert "schedule_1_foots" not in [c["name"] for c in reconcile(ex)["checks"]]


def test_facts_name_the_kinds_in_place_of_other_income():
    facts = build_facts(extraction())
    assert "Business income or loss (Schedule C): $3,200" in facts
    assert any(f.startswith("Rental real estate") and f.endswith(": -$1,200") for f in facts)
    assert not any("Other income from Schedule 1" in f for f in facts)


def test_kinds_that_do_not_foot_fail_recon_and_are_never_named():
    ex = extraction()
    ex["schedule_1"]["farm"] = 900  # a line read from the wrong row
    recon = reconcile(ex)
    assert [c["name"] for c in failures(recon)] == ["schedule_1_foots"]
    # Downgraded by a preparer, the check still reports, and the narration says "other income".
    assert reconcile(ex, {"schedule_1_foots"})["passed"] is True
    assert schedule1.breakdown(ex) == []
    facts = build_facts(ex)
    assert "Other income from Schedule 1: $2,000" in facts
    assert not any("Farm" in f or "Business" in f for f in facts)
    assert [b["label"] for b in slides.income_bars(ex)][-1] == "Other (Sch. 1)"


def test_income_slide_shows_a_bar_per_kind():
    bars = {b["label"]: b for b in slides.income_bars(extraction())}
    assert bars["Business"]["text"] == "$3,200" and not bars["Business"]["negative"]
    assert bars["Rental & partnerships"]["text"] == "-$1,200" and bars["Rental & partnerships"]["negative"]
    assert "Other (Sch. 1)" not in bars
    html = slides.render_html("income", extraction(), {})
    assert "Rental &amp; partnerships" in html and 'class="bars"' in html


def test_schedule_1_lines_are_overridable_and_allowed_in_the_script():
    assert is_overridable("schedule_1.business") and is_overridable("schedule_1.rental_partnership")
    assert validate_script(script_by_kind(), extraction()).ok


@pytest.mark.parametrize("software", SOFTWARE)
def test_verifier_traces_kinds_to_schedule_1(software):
    pdf = str(FIXTURES / f"{software}-1040-2025-{CASE}.pdf")
    v = verify(script_by_kind(), pdf, None, str(PROFILES))
    assert v.passed, [(i.kind, i.text, i.reason) for i in v.items if i.status == "flagged"]
    # $4,200 is on the return (the capital gain), but it is not Schedule 1 line 3.
    wrong = verify(script_by_kind("$4,200"), pdf, None, str(PROFILES))
    reasons = [i.reason or "" for i in wrong.items if i.status == "flagged"]
    assert any("business income" in r for r in reasons), reasons


def test_qualified_business_income_is_not_schedule_1_business_income():
    script = script_by_kind().replace("[[slide:tax]]", "Your qualified business income deduction was $4,200. [[slide:tax]]")
    v = verify(script, str(FIXTURES / f"ultratax-1040-2025-{CASE}.pdf"), None, str(PROFILES))
    assert not any("business income" in (i.reason or "") for i in v.items if i.status == "flagged")
