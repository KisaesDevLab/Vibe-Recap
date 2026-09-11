"""Render tests. Narration uses a fake synthesizer; Kokoro, Chromium, and ffmpeg run when present."""

from __future__ import annotations

import json
import logging
import os
import shutil
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from recap.render import mux, slides, tts

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
GOLDEN = FIXTURES / "scripts"
MODELS = Path(os.environ.get("MODELS_DIR", ROOT / "worker" / "models"))


def extraction(case: str, software: str = "ultratax") -> dict:
    return json.loads((FIXTURES / f"{software}-1040-2025-{case}.expected.json").read_text())


def fake_synth(text: str):
    """0.02 s of tone per word so durations are proportional to length."""
    words = max(1, len(text.split()))
    sr = 24000
    t = np.linspace(0, 0.02 * words, int(0.02 * words * sr), endpoint=False)
    return (0.1 * np.sin(2 * np.pi * 440 * t)).astype(np.float32), sr


def test_split_and_narrate_with_fake_synth():
    script = (GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")
    pieces = tts.split_script(script)
    assert pieces[0][0] == "greeting" and pieces[-1][0] == "next"
    n = tts.narrate(script, fake_synth)
    assert len(n.sentences) == len(pieces)
    assert set(n.slide_wavs) == {"greeting", "income", "deductions", "tax", "result", "observations", "next"}
    assert abs(sum(n.slide_durations.values()) - n.total) < 0.01
    # sentence starts are cumulative
    for a, b in zip(n.sentences, n.sentences[1:]):
        assert abs(a.start + a.duration - b.start) < 1e-6
    with wave.open(__import__("io").BytesIO(n.slide_wavs["income"]), "rb") as w:
        assert w.getframerate() == 24000 and w.getnchannels() == 1
    vtt = tts.to_vtt(n.sentences)
    assert vtt.startswith("WEBVTT") and vtt.count("-->") == len(pieces)
    assert "[[slide" not in tts.to_txt(script)


def test_speakable_moves_the_dollar_sign_after_the_number():
    # espeak says "dollar one thousand" for "$1,000"; the narration text must say it the other way.
    assert tts.speakable("Your refund is $1,000.") == "Your refund is 1,000 dollars."
    assert tts.speakable("You paid $1 more.") == "You paid 1 dollar more."
    assert tts.speakable("A $1.01 credit.") == "A 1 dollar and 1 cent credit."
    assert tts.speakable("A $1,234.56 balance.") == "A 1,234 dollars and 56 cents balance."
    assert tts.speakable("About $1.2 million.") == "About 1 point 2 million dollars."
    assert tts.speakable("We show ($500) and -$500.") == "We show negative 500 dollars and negative 500 dollars."
    assert tts.speakable("Your rate was 22%.") == "Your rate was 22%."  # espeak already says "percent"
    assert tts.speakable("(see $1,200) today") == "(see 1,200 dollars) today"  # unrelated parens survive


def test_speakable_spells_out_decimals():
    # espeak takes the decimal point for the end of the sentence when the number ends it:
    # "Your rate was 11.7%." comes out as "eleven. seven percent".
    assert tts.speakable("Your effective rate was 11.7%.") == "Your effective rate was 11 point 7%."
    assert tts.speakable("Withholding covered 126.5% of your tax.") == "Withholding covered 126 point 5% of your tax."
    assert tts.speakable("It rose 0.5%.") == "It rose 0 point 5%."
    assert tts.speakable("It was 12.25%.") == "It was 12 point 2 5%."  # each fraction digit on its own
    assert tts.speakable("Your rate was 22%.") == "Your rate was 22%."  # whole percentages are left alone
    assert tts.speakable("A $1,234.56 balance.") == "A 1,234 dollars and 56 cents balance."  # cents, not "point"
    assert tts.speakable("We filed on 1.2.3 lines.") == "We filed on 1.2.3 lines."  # not a number we write


def test_narration_is_spoken_but_captions_keep_the_written_form():
    script = "[[slide:greeting]]\nYour refund is $1,000.\n[[slide:next]]\nWe will talk soon.\n"
    seen: list[str] = []

    def spy(text: str):
        seen.append(text)
        return fake_synth(text)

    n = tts.narrate(script, spy)
    assert seen[0] == "Your refund is 1,000 dollars."
    assert n.sentences[0].text == "Your refund is $1,000."
    assert "$1,000" in tts.to_vtt(n.sentences)


@pytest.mark.skipif(not (MODELS / "kokoro-v1.0.onnx").exists(), reason="Kokoro model files not present")
def test_kokoro_synthesizes_a_sentence():
    synth = tts.kokoro_synth(str(MODELS), "af_heart")
    samples, sr = synth("Your total income for the year was one hundred fifty thousand dollars.")
    assert sr == 24000 and len(samples) / sr > 2.0


def test_slide_html_uses_extraction_numbers_only():
    ex = extraction("single-owed-itemized")
    settings = {"firm_name": "Test CPA", "color_primary": "#123456", "signoff_sentence": "See you soon."}
    html = slides.render_html("result", ex, settings)
    assert "Balance due" in html and "$1,640" in html and "#123456" in html
    html = slides.render_html("income", ex, settings)
    assert "$107,310" in html and "-$3,000" in html  # capital loss rendered as negative
    html = slides.render_html("greeting", extraction("mfj-refund-mo"), settings)
    assert "Alex &amp; Jordan" in html and "Married filing jointly" in html
    html = slides.render_html("greeting", extraction("mfj-refund-mo"), {**settings, "greeting_use_first_names": False})
    assert "Alex" not in html
    html = slides.render_html("next", ex, settings)
    assert "See you soon." in html
    for s in slides.SLIDES:
        assert "{{" not in slides.render_html(s, ex, settings)


def _chromium_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch(args=["--no-sandbox"])
            b.close()
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not _chromium_available(), reason="Playwright Chromium not installed")
def test_slides_render_to_1920x1080_png(tmp_path):
    ex = extraction("hoh-refund-two-states", "drake")
    htmls = [slides.render_html(s, ex, {"firm_name": "Test CPA"}) for s in slides.SLIDES]
    paths = slides.render_pngs(htmls, tmp_path / "slides")
    assert len(paths) == 7
    from PIL import Image

    for p in paths:
        with Image.open(p) as im:
            assert im.size == (1920, 1080)
    # the result slide is not blank
    with Image.open(paths[4]) as im:
        assert len(set(im.convert("L").getdata())) > 10


@pytest.mark.skipif(not mux.ffmpeg_available() or not _chromium_available(), reason="ffmpeg or Chromium missing")
def test_end_to_end_mp4_duration_and_vtt_cues(tmp_path):
    script = (GOLDEN / "single-owed-itemized.md").read_text(encoding="utf-8")
    ex = extraction("single-owed-itemized", "lacerte")
    narration = tts.narrate(script, fake_synth)
    htmls = [slides.render_html(s, ex, {"firm_name": "Test CPA"}) for s in slides.SLIDES]
    pngs = slides.render_pngs(htmls, tmp_path / "slides")
    wavs = []
    durations = []
    for s in slides.SLIDES:
        p = tmp_path / f"{s}.wav"
        p.write_bytes(narration.slide_wavs[s])
        wavs.append(p)
        durations.append(narration.slide_durations[s])
    audio = tmp_path / "narration.wav"
    mux.concat_audio(wavs, audio)
    out = tmp_path / "recap.mp4"
    mux.build_video(pngs, durations, audio, out)
    assert out.exists() and out.stat().st_size > 10_000
    total = mux.probe_duration(out) if shutil.which("ffprobe") else sum(durations)
    expected = sum(durations)
    assert abs(total - expected) / expected < 0.10
    vtt = tts.to_vtt(narration.sentences)
    assert vtt.count("-->") == len(narration.sentences)


def test_voice_prefers_the_uploaders_choice_then_the_firm_setting():
    class FakeDb:
        def __init__(self, voice):
            self.voice = voice

        def user_voice(self, user_id):
            assert user_id == "u1"
            return self.voice

    def ctx(user_voice, firm_voice, job_voice=None):
        return SimpleNamespace(db=FakeDb(user_voice), job={"uploaded_by": "u1", "voice": job_voice}, settings={"voice": firm_voice}, log=logging.getLogger("t"))

    # a voice picked for this one job on a re-render beats both
    assert tts.resolve_voice(ctx("am_michael", "af_heart", job_voice="bm_george")) == "bm_george"
    assert tts.resolve_voice(ctx("am_michael", "af_heart")) == "am_michael"
    assert tts.resolve_voice(ctx(None, "am_adam")) == "am_adam"
    assert tts.resolve_voice(ctx(None, None)) == tts.DEFAULT_VOICE
    assert tts.resolve_voice(ctx("nope", None)) == tts.DEFAULT_VOICE  # a voice no longer bundled


def test_mux_step_refuses_without_audio():
    from recap.pipeline import StepFailed

    ctx = SimpleNamespace(audio=[], slides=[], workdir=Path("."), script="", db=None)
    if mux.ffmpeg_available():
        with pytest.raises(StepFailed, match="audio or slides missing"):
            mux.mux(ctx)
    else:
        with pytest.raises(StepFailed, match="ffmpeg"):
            mux.mux(ctx)


def test_tts_step_refuses_until_verification_passed():
    from recap.pipeline import StepFailed

    ctx = SimpleNamespace(script="[[slide:greeting]] Hi.", verification={"passed": False}, settings={}, cfg=SimpleNamespace(models_dir=str(MODELS)))
    with pytest.raises(StepFailed, match="verification has not passed"):
        tts.synthesize(ctx, synth=fake_synth)
