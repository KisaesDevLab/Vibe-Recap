"""`python -m recap.diagnose` shows where each figure was read and never prints names or SSNs."""

import json
from pathlib import Path

from recap.diagnose import diagnose_pdf

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
PROFILES = Path(__file__).resolve().parents[2] / "form-profiles"


def test_diagnose_prints_rows_but_no_identity(capsys):
    stem = "ultratax-1040-2025-mfj-refund-mo"
    assert diagnose_pdf(str(FIXTURES / f"{stem}.pdf"), str(PROFILES), ("f1040_1", "f1040_2", "comparison"), False) == 0
    out = capsys.readouterr().out
    assert "income.total_income" in out and "NOT FOUND" not in out.split("income.total_income")[1].splitlines()[0]
    assert "== Page" in out
    taxpayer = json.loads((FIXTURES / f"{stem}.expected.json").read_text())["taxpayer"]
    for name in (taxpayer["first_name"], taxpayer["last_name"], taxpayer["spouse_first_name"]):
        assert name and name not in out
    assert "000-00-" not in out
