import json
from pathlib import Path

import pytest

from recap.validate import MAX_WORDS, MIN_WORDS, allowed_amounts, allowed_percents, slide_sections, validate_script, word_count

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
GOLDEN = FIXTURES / "scripts"


def extraction(case: str, software: str = "ultratax") -> dict:
    return json.loads((FIXTURES / f"{software}-1040-2025-{case}.expected.json").read_text())


@pytest.mark.parametrize("case", ["mfj-refund-mo", "single-owed-itemized", "hoh-refund-two-states"])
def test_golden_scripts_pass(case):
    script = (GOLDEN / f"{case}.md").read_text(encoding="utf-8")
    v = validate_script(script, extraction(case))
    assert v.ok, v.errors
    assert MIN_WORDS <= v.word_count <= MAX_WORDS
    assert [s for s, _ in slide_sections(script)] == ["greeting", "income", "deductions", "tax", "result", "observations", "next"]


def test_rejects_number_not_in_json():
    ex = extraction("mfj-refund-mo")
    script = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8").replace("$153,800", "$153,900")
    v = validate_script(script, ex)
    assert not v.ok
    assert any("$153,900" in e for e in v.errors)


def test_rejects_invented_percent_and_bare_number():
    ex = extraction("mfj-refund-mo")
    base = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")
    v = validate_script(base.replace("12.1%", "13.4%"), ex)
    assert any("13.4%" in e for e in v.errors)
    v = validate_script(base.replace("[[slide:next]]", "[[slide:next]]\nYour lucky number is 4321."), ex)
    assert any("4321" in e for e in v.errors)


def test_rejects_bad_structure_and_pii():
    ex = extraction("single-owed-itemized")
    base = (GOLDEN / "single-owed-itemized.md").read_text(encoding="utf-8")
    v = validate_script(base.replace("[[slide:tax]]", ""), ex)
    assert any("slide tags" in e and "missing [[slide:tax]]" in e for e in v.errors)
    v = validate_script(base.replace("[[slide:next]]", "[[slide:next]]\nYour SSN 000-00-1234 and 123 Example Street and me@example.com."), ex)
    joined = " ".join(v.errors)
    assert "Social Security" in joined and "street address" in joined and "email" in joined
    v = validate_script("[[slide:greeting]] hi " + " ".join(["word"] * 10), ex)
    assert any("too short" in e for e in v.errors)
    long = base + "\n" + " ".join(["filler"] * 300)
    assert any("too long" in e for e in validate_script(long, ex).errors)


def test_allowed_sets_come_from_extraction_only():
    ex = extraction("mfj-refund-mo")
    amounts = allowed_amounts(ex)
    assert 153800 in amounts and 3747 in amounts and 590 in amounts and 7500 in amounts
    assert 999999 not in amounts
    pcts = allowed_percents(ex)
    assert 12.1 in pcts and 5.4 in pcts
    assert word_count("[[slide:greeting]]\nHi there, $1,234 is 5%.") == 5
