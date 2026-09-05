"""Revision requests: regenerate-with-instructions through the same gates (stub model; Postgres for the pipeline path)."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from recap import pipeline
from recap.script import generate as gen
from recap.script.generate import RevisionRejected, revise
from recap.script.ollama import ChatResult

from test_pipeline import FIXTURES, db_available, env, make_job  # noqa: F401

GOLDEN = FIXTURES / "scripts"


class Stub:
    def __init__(self, answers: list[str]):
        self.answers = list(answers)
        self.calls: list[list[dict]] = []

    def chat(self, messages, **_):
        self.calls.append([dict(m) for m in messages])
        return ChatResult(content=self.answers.pop(0), model="stub", eval_count=1, prompt_eval_count=1, total_ms=1)


def extraction(case: str, software: str = "drake") -> dict:
    return json.loads((FIXTURES / f"{software}-1040-2025-{case}.expected.json").read_text())


def test_revise_sends_current_script_and_instruction_then_validates():
    ex = extraction("mfj-refund-mo")
    golden = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")
    revised = golden.replace("Hi Alex and Jordan.", "Hello Alex and Jordan, and thank you for trusting us with your return this year.")
    model = Stub([revised])
    script, attempts = revise(ex, {}, None, model, golden, "Warmer greeting please", verifier=None)
    assert script == revised.strip() and attempts[0]["ok"]
    convo = model.calls[0]
    assert convo[2]["role"] == "assistant" and convo[2]["content"] == golden
    assert convo[3]["role"] == "user" and "Warmer greeting please" in convo[3]["content"]


def test_revise_rejects_invented_numbers_after_three_attempts():
    ex = extraction("mfj-refund-mo")
    golden = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")
    bad = golden.replace("$3,747", "$3,750")
    model = Stub([bad, bad, bad])
    with pytest.raises(RevisionRejected) as exc:
        revise(ex, {}, None, model, golden, "Round the refund", verifier=None)
    assert len(exc.value.attempts) == 3 and all(not a["ok"] for a in exc.value.attempts)
    assert any("$3,750" in e for e in exc.value.attempts[0]["errors"])


pytestmark_db = pytest.mark.skipif(not db_available(), reason="test Postgres not reachable")


def _seed_ready_job(env_, monkeypatch, case_pdf: str, golden_name: str) -> str:
    cfg, storage, db, *_ = env_
    for step in ("tts", "slides", "mux"):
        monkeypatch.setitem(pipeline.STEP_FUNCS, step, lambda ctx: None)
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub([(GOLDEN / golden_name).read_text(encoding="utf-8")]))
    job_id = make_job(env_, case_pdf)
    pipeline.run_job(cfg, storage, job_id)
    assert db.get_job(job_id)["status"] == "needs_review"
    return job_id


def _request_revision(db, job_id: str, message: str, previous_status: str) -> str:
    rid = str(uuid.uuid4())
    with db.conn() as c:
        user = c.execute("select id from users limit 1").fetchone()["id"]
        c.execute(
            "insert into job_revisions (id, job_id, requested_by, requested_by_label, message, previous_status, script_sha256_before) "
            "values (%s, %s, %s, 't@example.com', %s, %s, (select script_sha256 from jobs where id = %s))",
            (rid, job_id, user, message, previous_status, job_id),
        )
    db.update_job(job_id, status="queued", resume_from="script")
    return rid


@pytestmark_db
def test_pipeline_applies_a_revision_and_rerenders(env, monkeypatch):
    cfg, storage, db, *_ = env
    job_id = _seed_ready_job(env, monkeypatch, "drake-1040-2025-mfj-refund-mo.pdf", "mfj-refund-mo.md")
    before = db.get_job(job_id)["script_sha256"]
    golden = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")
    revised = golden.replace("Hi Alex and Jordan.", "Hello Alex and Jordan, and thank you for trusting us with your return this year.")
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub([revised]))
    rid = _request_revision(db, job_id, "Warmer greeting", "needs_review")
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "needs_review" and job["script_sha256"] != before
    with db.conn() as c:
        rev = c.execute("select * from job_revisions where id = %s", (rid,)).fetchone()
    assert rev["status"] == "applied" and rev["script_sha256_after"] == job["script_sha256"] and len(rev["attempts"]) == 1
    stored = storage.get(*[(f["path"], f["key_path"]) for f in db.list_files(job_id, "script")][0]).decode("utf-8")
    assert stored.startswith("[[slide:greeting]]\nHello Alex and Jordan")
    # the verification was redone for the new script
    ver = json.loads(storage.get(*[(f["path"], f["key_path"]) for f in db.list_files(job_id, "verification")][0]))
    assert ver["passed"] and ver["script_sha256"] == job["script_sha256"]


@pytestmark_db
def test_pipeline_keeps_previous_script_when_revision_is_rejected(env, monkeypatch):
    cfg, storage, db, *_ = env
    job_id = _seed_ready_job(env, monkeypatch, "cch-1040-2025-single-owed-itemized.pdf", "single-owed-itemized.md")
    before = db.get_job(job_id)["script_sha256"]
    golden = (GOLDEN / "single-owed-itemized.md").read_text(encoding="utf-8")
    bad = golden.replace("balance due of $1,640", "refund of $1,640")  # direction flips: verifier rejects
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub([bad, bad, bad]))
    rid = _request_revision(db, job_id, "Call it a refund", "needs_review")
    out = pipeline.run_job(cfg, storage, job_id)
    assert out == {"ok": False, "revision": "rejected"}
    job = db.get_job(job_id)
    assert job["status"] == "needs_review" and job["script_sha256"] == before
    with db.conn() as c:
        rev = c.execute("select * from job_revisions where id = %s", (rid,)).fetchone()
    assert rev["status"] == "rejected" and "direction" in (rev["error"] or "") and len(rev["attempts"]) == 3
