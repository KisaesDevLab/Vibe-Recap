"""Whole pipeline: fixture PDF -> needs_review with an MP4, VTT, and TXT (needs Postgres, Chromium, ffmpeg).

Narration uses the fake synthesizer so the test does not depend on the Kokoro model files.
"""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from recap import pipeline
from recap.render import mux, tts
from recap.script import generate as gen
from recap.script.ollama import ChatResult

from test_pipeline import FIXTURES, db_available, env, make_job  # noqa: F401
from test_render import _chromium_available, fake_synth

GOLDEN = FIXTURES / "scripts"
pytestmark = pytest.mark.skipif(
    not (db_available() and mux.ffmpeg_available() and _chromium_available()),
    reason="needs test Postgres, ffmpeg, and Playwright Chromium",
)


class Stub:
    def __init__(self, text: str):
        self.text = text

    def chat(self, messages, **_):
        return ChatResult(content=self.text, model="stub", eval_count=1, prompt_eval_count=1, total_ms=1)


def test_fixture_to_video(env, monkeypatch):
    cfg, storage, db, *_ = env
    monkeypatch.setattr(gen, "_client_for", lambda ctx: Stub((GOLDEN / "hoh-refund-two-states.md").read_text(encoding="utf-8")))
    monkeypatch.setattr(tts, "kokoro_synth", lambda models_dir, voice=None, speed=1.0: fake_synth)
    job_id = make_job(env, "proseries-1040-2025-hoh-refund-two-states.pdf")
    pipeline.run_job(cfg, storage, job_id)
    job = db.get_job(job_id)
    assert job["status"] == "needs_review", job["error_message"]
    kinds = {f["kind"]: f for f in db.list_files(job_id)}
    assert {"source", "extraction", "script", "verification", "audio", "slide", "video", "vtt", "txt"} <= set(kinds)
    assert len(db.list_files(job_id, "slide")) == 7
    assert len(db.list_files(job_id, "audio")) == 7

    video = storage.get(kinds["video"]["path"], kinds["video"]["key_path"])
    assert video[4:8] == b"ftyp"
    vtt = storage.get(kinds["vtt"]["path"], kinds["vtt"]["key_path"]).decode("utf-8")
    txt = storage.get(kinds["txt"]["path"], kinds["txt"]["key_path"]).decode("utf-8")
    sentences = tts.split_script((GOLDEN / "hoh-refund-two-states.md").read_text(encoding="utf-8"))
    assert vtt.count("-->") == len(sentences)
    assert "[[slide" not in txt and "$4,900" in txt

    # duration within 10% of the sum of the narration WAVs
    events = [e for e in _events(db, job_id) if e["step"] in ("tts", "mux")]
    tts_seconds = next(e["meta"]["seconds"] for e in events if e["step"] == "tts" and e["meta"].get("seconds"))
    if shutil.which("ffprobe"):
        tmp = job_id + ".mp4"
        with open(tmp, "wb") as fh:
            fh.write(video)
        try:
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", tmp], capture_output=True, text=True).stdout.strip())
        finally:
            import os

            os.unlink(tmp)
        assert abs(dur - tts_seconds) / tts_seconds < 0.10, (dur, tts_seconds)


def _events(db, job_id):
    with db.conn() as c:
        return c.execute("select * from job_events where job_id = %s order by id", (job_id,)).fetchall()
