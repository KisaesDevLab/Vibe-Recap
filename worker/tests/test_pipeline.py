"""Pipeline tests against the throwaway Postgres from compose.test.yml (npm run test:services).

Skipped when the database is unreachable. The API's migrations are applied by running the SQL
files under apps/api/drizzle so the worker sees the real schema.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest
from pyrage import x25519

from recap import pipeline
from recap.config import Config
from recap.db import Db
from recap.storage import Storage

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
PROFILES = ROOT / "form-profiles"
DB_URL = os.environ.get("TEST_DATABASE_URL", "postgres://recap:recap@localhost:55432/recap_test")


def db_available() -> bool:
    try:
        with psycopg.connect(DB_URL, connect_timeout=2):
            return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not db_available(), reason="test Postgres not reachable; run `npm run test:services`")


def apply_migrations(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as c:
        c.execute("drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade;")
        for sql_file in sorted((ROOT / "apps" / "api" / "drizzle").glob("*.sql")):
            for stmt in re.split(r"-->\s*statement-breakpoint", sql_file.read_text(encoding="utf-8")):
                if stmt.strip():
                    c.execute(stmt)


@pytest.fixture
def env(tmp_path):
    apply_migrations(DB_URL)
    (tmp_path / "keys").mkdir()
    (tmp_path / "keys" / "master.key").write_text(str(x25519.Identity.generate()) + "\n")
    storage = Storage(str(tmp_path))
    storage.init()
    cfg = Config.from_env({"DATABASE_URL": DB_URL, "DATA_DIR": str(tmp_path), "FORM_PROFILES_DIR": str(PROFILES)})
    db = Db(DB_URL)
    with db.conn() as c:
        user = c.execute(
            "insert into users (email, name, role, password_hash) values ('t@example.com', 'T', 'preparer', 'x') returning id"
        ).fetchone()["id"]
        client = c.execute("insert into clients (name, normalized_name) values ('Fixture, Alex', 'fixture, alex') returning id").fetchone()["id"]
    return cfg, storage, db, str(user), str(client)


def make_job(env, pdf_name: str, prior_name: str | None = None, **cols) -> str:
    cfg, storage, db, user, client = env
    pdf = (FIXTURES / pdf_name).read_bytes()
    job_id = str(uuid.uuid4())
    with db.conn() as c:
        c.execute(
            "insert into jobs (id, status, client_id, uploaded_by, source_sha256, tax_year) values (%s, 'queued', %s, %s, %s, 2025)",
            (job_id, client, user, "0" * 64),
        )
        for k, v in cols.items():
            c.execute(f"update jobs set {k} = %s where id = %s", (json.dumps(v) if isinstance(v, (list, dict)) else v, job_id))
    blob = storage.put(job_id, pdf)
    db.add_file(job_id, "source", blob.path, blob.key_path, blob.sha256, blob.size, file_id=blob.id)
    if prior_name:
        pb = storage.put(job_id, (FIXTURES / prior_name).read_bytes())
        db.add_file(job_id, "prior", pb.path, pb.key_path, pb.sha256, pb.size, file_id=pb.id)
    return job_id


def stop_after_recon(monkeypatch):
    """Later phases are exercised by their own tests; here every step after recon is a no-op."""
    for step in ("script", "validate", "verify", "tts", "slides", "mux"):
        monkeypatch.setitem(pipeline.STEP_FUNCS, step, lambda ctx: None)


def test_ingest_to_recon_stores_extraction(env, monkeypatch):
    cfg, storage, db, *_ = env
    stop_after_recon(monkeypatch)
    job_id = make_job(env, "ultratax-1040-2025-mfj-refund-mo.pdf", "ultratax-1040-2024-mfj-refund-mo-prior.pdf")
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "needs_review", job
    assert job["software"] == "ultratax" and job["tax_year"] == 2025 and job["page_count"] == 5
    files = db.list_files(job_id, "extraction")
    assert len(files) == 1 and files[0]["sha256"] == job["extraction_sha256"]
    doc = json.loads(storage.get(files[0]["path"], files[0]["key_path"]))
    assert doc["recon"]["passed"] is True
    assert doc["prior_year"]["source"] == "prior_pdf"
    steps = [e["step"] for e in _events(db, job_id)]
    assert steps[:5] == ["ingest", "ingest", "identify", "extract", "ocr"]


def _events(db, job_id):
    with db.conn() as c:
        return c.execute("select * from job_events where job_id = %s order by id", (job_id,)).fetchall()


def test_recon_failure_then_exception_downgrade(env, monkeypatch, tmp_path):
    cfg, storage, db, *_ = env
    stop_after_recon(monkeypatch)
    # A return whose total income is $500 more than its components: one wrong line, recon must name it.
    import dataclasses
    import runpy

    mf = runpy.run_path(str(ROOT / "scripts" / "make-fixture.py"), run_name="fixture_module")
    Case = mf["Case"]

    class BadCase(Case):
        @property
        def total_income(self):  # type: ignore[override]
            return super().total_income + 500

    case = BadCase(**dataclasses.asdict(mf["CASES"][0]))
    bad = FIXTURES / "_tmp_bad.pdf"
    mf["render"](case, "drake", bad)
    try:
        job_id = make_job(env, "_tmp_bad.pdf")
    finally:
        bad.unlink(missing_ok=True)
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "failed" and job["error_step"] == "recon"
    assert "total_income_foots" in job["error_message"]

    # preparer downgrades that check; API would do this, here we write the column directly
    db.update_job(job_id, status="queued", resume_from="recon", recon_exceptions=[{"check": "total_income_foots", "reason": "wages line intentionally off in fixture", "by": "t@example.com", "at": "now"}])
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "needs_review"
    doc = json.loads(storage.get(*[(f["path"], f["key_path"]) for f in db.list_files(job_id, "extraction")][0]))
    row = next(c for c in doc["recon"]["checks"] if c["name"] == "total_income_foots")
    assert row["ok"] is False and row.get("warning") is True  # still reports the mismatch


def test_interrupted_job_is_failed_not_rerun(env):
    cfg, storage, db, *_ = env
    job_id = make_job(env, "cch-1040-2025-single-owed-itemized.pdf", status="processing", step="extract")
    out = pipeline.run_job(cfg, storage, job_id)
    assert out == {"ok": False, "error": "interrupted"}
    job = db.get_job(job_id)
    assert job["status"] == "failed" and job["error_step"] == "extract"
    assert "restarted" in job["error_message"]


def test_unsupported_form_fails_at_extract(env, monkeypatch, tmp_path):
    cfg, storage, db, *_ = env
    stop_after_recon(monkeypatch)
    from reportlab.pdfgen import canvas
    p = tmp_path / "s.pdf"
    c = canvas.Canvas(str(p))
    c.drawString(72, 700, "Form 1120-S (2025) U.S. Income Tax Return for an S Corporation")
    c.drawString(72, 680, "Drake Software")
    c.save()
    (FIXTURES / "_tmp_1120s.pdf").write_bytes(p.read_bytes())
    try:
        job_id = make_job(env, "_tmp_1120s.pdf")
    finally:
        (FIXTURES / "_tmp_1120s.pdf").unlink(missing_ok=True)
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "failed" and job["error_step"] == "extract"
    assert "1120-S" in job["error_message"]
