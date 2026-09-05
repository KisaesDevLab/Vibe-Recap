"""Pipeline through script -> validate -> verify with a stub language model (needs test Postgres)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from recap import pipeline
from recap.script import generate as gen
from recap.script.ollama import ChatResult

from test_pipeline import FIXTURES, db_available, env, make_job  # noqa: F401  (fixture re-export)

GOLDEN = FIXTURES / "scripts"
pytestmark = pytest.mark.skipif(not db_available(), reason="test Postgres not reachable; run `npm run test:services`")


class Stub:
    def __init__(self, text: str):
        self.text = text

    def chat(self, messages, **_):
        return ChatResult(content=self.text, model="stub", eval_count=1, prompt_eval_count=1, total_ms=1)


def no_render(monkeypatch):
    for step in ("tts", "slides", "mux"):
        monkeypatch.setitem(pipeline.STEP_FUNCS, step, lambda ctx: None)


def files_of(db, job_id):
    return {f["kind"]: f for f in db.list_files(job_id)}


def test_full_run_to_needs_review(env, monkeypatch):
    cfg, storage, db, *_ = env
    no_render(monkeypatch)
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub((GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")))
    job_id = make_job(env, "ultratax-1040-2025-mfj-refund-mo.pdf")
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "needs_review", job["error_message"]
    kinds = files_of(db, job_id)
    assert {"source", "extraction", "script", "verification"} <= set(kinds)
    assert job["script_sha256"] == kinds["script"]["sha256"]
    assert job["verification_sha256"] == kinds["verification"]["sha256"]
    ver = json.loads(storage.get(kinds["verification"]["path"], kinds["verification"]["key_path"]))
    assert ver["passed"] and ver["script_sha256"] == job["script_sha256"]
    assert any(i["kind"] == "amount" and i["page"] for i in ver["items"])


def test_script_that_fails_validation_three_times_fails_at_script(env, monkeypatch):
    cfg, storage, db, *_ = env
    no_render(monkeypatch)
    bad = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8").replace("$3,747", "$3,777")
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub(bad))
    job_id = make_job(env, "drake-1040-2025-mfj-refund-mo.pdf")
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "failed" and job["error_step"] == "script"
    assert "3 attempts" in job["error_message"] and "$3,777" in job["error_message"]
    assert "script" not in files_of(db, job_id)  # nothing stored, nothing rendered


def test_manual_edit_resumes_at_validate_and_verify_catches_wrong_fact(env, monkeypatch):
    cfg, storage, db, *_ = env
    no_render(monkeypatch)
    golden = (GOLDEN / "single-owed-itemized.md").read_text(encoding="utf-8")
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub(golden))
    job_id = make_job(env, "cch-1040-2025-single-owed-itemized.pdf")
    pipeline.run_job(cfg, storage, job_id)
    assert db.get_job(job_id)["status"] == "needs_review"

    # Preparer edits the script: says "refund" for an amount-owed return. Numbers still validate.
    edited = golden.replace("the return shows a balance due of $1,640", "the return shows a refund of $1,640")
    for f in db.list_files(job_id, "script"):
        storage.shred(f["path"], f["key_path"])
    db.delete_files(job_id, ["script"])
    blob = storage.put(job_id, edited.encode("utf-8"))
    db.add_file(job_id, "script", blob.path, blob.key_path, blob.sha256, blob.size, file_id=blob.id)
    db.update_job(job_id, status="queued", resume_from="validate", script_sha256=blob.sha256)
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "failed" and job["error_step"] == "verify"
    assert "direction" in job["error_message"]
    ver = json.loads(storage.get(*[(f["path"], f["key_path"]) for f in db.list_files(job_id, "verification")][0]))
    assert not ver["passed"]
    assert any(i["kind"] == "direction" and i["status"] == "flagged" for i in ver["items"])


def test_unreachable_model_fails_cleanly_at_script(env, monkeypatch):
    cfg, storage, db, *_ = env
    no_render(monkeypatch)
    from recap.script.ollama import Ollama

    monkeypatch.setattr(gen, "_client_for", lambda ctx: Ollama("http://127.0.0.1:9", "qwen3:8b", timeout_s=2))
    job_id = make_job(env, "proseries-1040-2025-hoh-refund-two-states.pdf")
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "failed" and job["error_step"] == "script"
    assert "Ollama" in job["error_message"]
