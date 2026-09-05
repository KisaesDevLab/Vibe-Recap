from pathlib import Path

from pyrage import x25519

from recap.config import Config
from recap.stage import stage_file
from recap.storage import Storage

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
PROFILES = Path(__file__).resolve().parents[2] / "form-profiles"


def make_storage(tmp_path):
    (tmp_path / "keys").mkdir()
    (tmp_path / "keys" / "master.key").write_text(str(x25519.Identity.generate()) + "\n")
    s = Storage(str(tmp_path))
    s.init()
    return s


def test_stage_reads_names_year_software(tmp_path):
    s = make_storage(tmp_path)
    cfg = Config.from_env({"DATA_DIR": str(tmp_path), "FORM_PROFILES_DIR": str(PROFILES)})
    pdf = (FIXTURES / "lacerte-1040-2025-mfj-refund-mo.pdf").read_bytes()
    blob = s.put("staging/st1", pdf, "f1")
    assert blob.path == "blobs/staging/st1/f1.age"
    out = stage_file(cfg, s, "st1", "f1")
    assert out["ok"] is True
    assert (out["firstName"], out["lastName"], out["spouseFirstName"]) == ("Alex", "Fixture", "Jordan")
    assert out["taxYear"] == 2025 and out["software"] == "lacerte" and out["form"] == "1040"
    assert out["pageCount"] == 5


def test_stage_reports_unreadable(tmp_path):
    s = make_storage(tmp_path)
    cfg = Config.from_env({"DATA_DIR": str(tmp_path), "FORM_PROFILES_DIR": str(PROFILES)})
    s.put("staging/st2", b"%PDF-1.4 garbage", "f2")
    out = stage_file(cfg, s, "st2", "f2")
    assert out["ok"] is False
    missing = stage_file(cfg, s, "st2", "nope")
    assert missing["ok"] is False
