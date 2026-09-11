"""Narration with Kokoro-82M (kokoro-onnx, CPU).

Each sentence is synthesized on its own so its duration is known exactly; slide transitions are
driven from those durations, never from word counts. Model files live in MODELS_DIR (baked into
the image; the worker has no internet). Four bundled voices; the firm picks one in settings.
"""

from __future__ import annotations

import io
import re
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

VOICES = {
    "af_heart": "Heart (female, American)",
    "af_bella": "Bella (female, American)",
    "am_michael": "Michael (male, American)",
    "am_adam": "Adam (male, American)",
}
DEFAULT_VOICE = "af_heart"
SAMPLE_RATE = 24000
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
TAG_RE = re.compile(r"\[\[slide:([a-z_]+)\]\]")
GAP_S = 0.35  # silence appended after each sentence

# espeak (inside Kokoro's phonemizer) reads "$1,000" as "dollar one thousand": it speaks the
# symbol where it stands instead of moving it after the number. Rewrite money into words before
# synthesis. Only the audio is rewritten; captions and the transcript keep the written form.
# The paren group is a conditional: the closing ")" is only consumed when the match opened one.
MONEY_RE = re.compile(
    r"(?P<paren>\()?(?P<neg>-)?\$\s?(?P<num>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<cents>\d{1,2}))?"
    r"(?P<scale>\s+(?:thousand|million|billion))?(?(paren)\))"
)

# espeak also mistakes the decimal point for the end of the sentence when the number is the last
# thing in it: "Your rate was 11.7%." comes out as "eleven. seven percent", while the same number
# mid-sentence is read correctly. Narration is synthesized one sentence at a time and a sentence
# often ends on a percentage, so every decimal is spelled out instead ("11 point 7%").
DECIMAL_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})*|\d+)\.(\d+)(?![\w.])")


def speakable(text: str) -> str:
    """Narration form of a sentence: '$1,000' -> '1,000 dollars', '11.7%' -> '11 point 7%'."""

    def repl(m: re.Match[str]) -> str:
        num, cents, scale = m.group("num"), m.group("cents"), (m.group("scale") or "").strip()
        c = int(cents.ljust(2, "0")) if cents else 0
        if scale:
            said = f"{num}.{cents} {scale} dollars" if cents else f"{num} {scale} dollars"
        elif c:
            said = f"{num} {'dollar' if num == '1' else 'dollars'} and {c} {'cent' if c == 1 else 'cents'}"
        else:
            said = f"{num} {'dollar' if num == '1' else 'dollars'}"
        return ("negative " if m.group("neg") or m.group("paren") else "") + said

    def decimal(m: re.Match[str]) -> str:
        # "11.7" -> "11 point 7", "12.25" -> "12 point 2 5"; each fraction digit is said on its own.
        return f"{m.group(1)} point " + " ".join(m.group(2))

    return DECIMAL_RE.sub(decimal, MONEY_RE.sub(repl, text))


@dataclass
class Sentence:
    slide: str
    index: int
    text: str
    start: float  # seconds from the beginning of the narration
    duration: float


@dataclass
class Narration:
    sentences: list[Sentence]
    slide_wavs: dict[str, bytes]  # slide -> WAV bytes for that slide's sentences
    slide_durations: dict[str, float]
    total: float


Synth = Callable[[str], tuple[np.ndarray, int]]


def split_script(script: str) -> list[tuple[str, str]]:
    """[(slide, sentence)] in narration order."""
    parts = TAG_RE.split(script)
    out: list[tuple[str, str]] = []
    for i in range(1, len(parts) - 1, 2):
        slide = parts[i]
        text = " ".join(parts[i + 1].split())
        for s in SENTENCE_RE.split(text):
            s = s.strip()
            if s:
                out.append((slide, s))
    return out


def kokoro_synth(models_dir: str, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> Synth:
    from kokoro_onnx import Kokoro

    model = Path(models_dir) / "kokoro-v1.0.onnx"
    voices = Path(models_dir) / "voices-v1.0.bin"
    if not model.exists() or not voices.exists():
        raise FileNotFoundError(f"Kokoro model files missing under {models_dir}; the worker image should contain them")
    k = Kokoro(str(model), str(voices))
    v = voice if voice in VOICES else DEFAULT_VOICE

    def run(text: str) -> tuple[np.ndarray, int]:
        samples, sr = k.create(text, voice=v, speed=speed, lang="en-us")
        return np.asarray(samples, dtype=np.float32), int(sr)

    return run


def wav_bytes(samples: np.ndarray, sr: int) -> bytes:
    pcm = np.clip(samples, -1.0, 1.0)
    data = (pcm * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data)
    return buf.getvalue()


def narrate(script: str, synth: Synth) -> Narration:
    pieces = split_script(script)
    if not pieces:
        raise ValueError("script has no sentences")
    sentences: list[Sentence] = []
    per_slide: dict[str, list[np.ndarray]] = {}
    sr_seen: int | None = None
    t = 0.0
    for i, (slide, text) in enumerate(pieces):
        samples, sr = synth(speakable(text))
        sr_seen = sr_seen or sr
        if sr != sr_seen:
            raise ValueError("sample rate changed mid-narration")
        gap = np.zeros(int(GAP_S * sr), dtype=np.float32)
        chunk = np.concatenate([samples.astype(np.float32), gap])
        dur = len(chunk) / sr
        sentences.append(Sentence(slide, i, text, round(t, 3), round(dur, 3)))
        per_slide.setdefault(slide, []).append(chunk)
        t += dur
    sr = sr_seen or SAMPLE_RATE
    slide_wavs = {s: wav_bytes(np.concatenate(chunks), sr) for s, chunks in per_slide.items()}
    slide_durations = {s: round(sum(len(c) for c in chunks) / sr, 3) for s, chunks in per_slide.items()}
    return Narration(sentences, slide_wavs, slide_durations, round(t, 3))


def to_vtt(sentences: list[Sentence]) -> str:
    def ts(sec: float) -> str:
        h = int(sec // 3600)
        m = int(sec % 3600 // 60)
        s = sec % 60
        return f"{h:02d}:{m:02d}:{s:06.3f}"

    lines = ["WEBVTT", ""]
    for i, s in enumerate(sentences, 1):
        lines += [str(i), f"{ts(s.start)} --> {ts(s.start + s.duration - GAP_S)}", s.text, ""]
    return "\n".join(lines)


def to_txt(script: str) -> str:
    return "\n\n".join(" ".join(t.split()) for _s, t in _slide_texts(script)) + "\n"


def _slide_texts(script: str) -> list[tuple[str, str]]:
    parts = TAG_RE.split(script)
    return [(parts[i], parts[i + 1].strip()) for i in range(1, len(parts) - 1, 2)]


# ---------------------------------------------------------------------------
# Pipeline step body
# ---------------------------------------------------------------------------


def resolve_voice(ctx: Any) -> str:
    """The uploader's own voice preference, else the firm-wide setting, else the default."""
    chosen = None
    try:
        chosen = ctx.db.user_voice((ctx.job or {}).get("uploaded_by"))
    except Exception:  # noqa: BLE001 - a preference must never fail a job
        ctx.log.warning("could not read the uploader's voice preference; using the firm setting")
    chosen = chosen or (ctx.settings or {}).get("voice")
    return chosen if chosen in VOICES else DEFAULT_VOICE


def synthesize(ctx: Any, synth: Synth | None = None) -> None:
    from ..pipeline import StepFailed, load_file, replace_files

    if ctx.script is None:
        raw = load_file(ctx, "script")
        if raw is None:
            raise StepFailed("tts", "no script to narrate")
        ctx.script = raw.decode("utf-8")
    if ctx.verification is None or not ctx.verification.get("passed"):
        raise StepFailed("tts", "verification has not passed; no audio is produced until it does")
    voice = resolve_voice(ctx)
    try:
        fn = synth or kokoro_synth(ctx.cfg.models_dir, voice)
        narration = narrate(ctx.script, fn)
    except FileNotFoundError as exc:
        raise StepFailed("tts", str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise StepFailed("tts", f"narration failed ({type(exc).__name__}: {exc})") from exc
    ctx.audio = [
        {"slide": s, "duration": narration.slide_durations[s], "wav": narration.slide_wavs[s]}
        for s, _t in _slide_texts(ctx.script)
        if s in narration.slide_wavs
    ]
    ctx.sentences = [s.__dict__ for s in narration.sentences]
    replace_files(ctx, "audio", [a["wav"] for a in ctx.audio])
    ctx.db.add_event(ctx.job_id, "processing", "tts", f"{len(narration.sentences)} sentences, {narration.total:.1f}s", {"voice": voice, "seconds": narration.total})
