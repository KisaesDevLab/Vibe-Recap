"""Video assembly with ffmpeg: slides + narration -> recap.mp4, recap.vtt, recap.txt.

Each slide is shown for its narration length plus the 0.4 s crossfade into the next one, so
transitions start exactly when a slide's audio ends and the narration stays in sync. The
narration WAVs (one per slide) are concatenated with the concat demuxer. Video: libx264
CRF 23, yuv420p, 24 fps; audio AAC 128k; +faststart.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

XFADE_S = 0.4
TAIL_S = 1.0
FPS = 24


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _run(cmd: list[str], timeout_s: int = 900) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if proc.returncode != 0:
        tail = proc.stderr[-1500:]
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {tail}")


def concat_audio(wavs: list[Path], out: Path) -> None:
    listing = out.with_suffix(".txt")
    listing.write_text("".join(f"file '{w.as_posix()}'\n" for w in wavs), encoding="utf-8")
    _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(out)])


def build_video(slides: list[Path], durations: list[float], narration: Path, out: Path) -> None:
    """Crossfaded slideshow muxed with the narration. `durations` are per-slide audio lengths."""
    if len(slides) != len(durations) or not slides:
        raise ValueError("slides and durations must be non-empty and the same length")
    n = len(slides)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    shown: list[float] = []
    for i, (png, d) in enumerate(zip(slides, durations)):
        t = d + (XFADE_S if i < n - 1 else TAIL_S)
        shown.append(t)
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{t:.3f}", "-i", str(png)]
    cmd += ["-i", str(narration)]
    if n == 1:
        filt = f"[0:v]format=yuv420p,setsar=1[vout]"
    else:
        parts = []
        prev = "[0:v]"
        acc = 0.0
        for i in range(1, n):
            acc += durations[i - 1]  # transition i starts when slide i-1's audio ends
            label = "[vout]" if i == n - 1 else f"[v{i}]"
            parts.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XFADE_S}:offset={acc:.3f}{label}")
            prev = label
        filt = ";".join(parts) + ";[vout]format=yuv420p,setsar=1[vfinal]"
    out_label = "[vfinal]" if n > 1 else "[vout]"
    cmd += [
        "-filter_complex", filt,
        "-map", out_label, "-map", f"{n}:a",
        "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-r", str(FPS), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest", "-movflags", "+faststart",
        str(out),
    ]
    _run(cmd)


def probe_duration(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    return float(proc.stdout.strip() or 0)


# ---------------------------------------------------------------------------
# Pipeline step body
# ---------------------------------------------------------------------------


def mux(ctx: Any) -> None:
    from ..pipeline import StepFailed, load_file, replace_file
    from .tts import Sentence, to_txt, to_vtt

    if not ffmpeg_available():
        raise StepFailed("mux", "ffmpeg is not installed in the worker image")
    audio = getattr(ctx, "audio", None) or []
    slides = getattr(ctx, "slides", None) or []
    if not audio or not slides:
        raise StepFailed("mux", "audio or slides missing; re-render from tts")
    by_slide = {a["slide"]: a for a in audio}
    from .slides import SLIDES

    work = ctx.workdir / "mux"
    work.mkdir(parents=True, exist_ok=True)
    wavs: list[Path] = []
    durations: list[float] = []
    pngs: list[Path] = []
    for i, slide in enumerate(SLIDES):
        a = by_slide.get(slide)
        if not a or i >= len(slides):
            continue
        p = work / f"{slide}.wav"
        p.write_bytes(a["wav"])
        wavs.append(p)
        durations.append(float(a["duration"]))
        pngs.append(slides[i])
    narration = work / "narration.wav"
    video = work / "recap.mp4"
    try:
        concat_audio(wavs, narration)
        build_video(pngs, durations, narration, video)
    except (RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
        raise StepFailed("mux", str(exc)[:1500]) from exc
    sentences = [Sentence(**s) for s in (getattr(ctx, "sentences", None) or [])]
    script = ctx.script
    if script is None:
        raw = load_file(ctx, "script")
        script = raw.decode("utf-8") if raw else ""
    replace_file(ctx, "video", video.read_bytes())
    replace_file(ctx, "vtt", to_vtt(sentences).encode("utf-8"))
    replace_file(ctx, "txt", to_txt(script).encode("utf-8"))
    total = probe_duration(video) if shutil.which("ffprobe") else sum(durations)
    ctx.db.add_event(ctx.job_id, "processing", "mux", f"video {total:.1f}s", {"seconds": total, "slides": len(pngs)})
