"""pdfplumber word extraction with the quirks each package needs.

- `use_text_flow=True` keeps Lacerte's overlapping words from being interleaved.
- Words are clustered into lines by `top` (y-band) rather than stream order, because
  UltraTax prints labels and values as separate text runs.
- Duplicate words at (almost) the same position are collapsed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Word:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float

    @property
    def xc(self) -> float:
        return (self.x0 + self.x1) / 2


@dataclass
class Line:
    top: float
    words: list[Word]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def x0(self) -> float:
        return min(w.x0 for w in self.words)

    @property
    def x1(self) -> float:
        return max(w.x1 for w in self.words)


def _dedupe(words: Iterable[Word]) -> list[Word]:
    out: list[Word] = []
    for w in words:
        dup = False
        for o in out:
            if o.text == w.text and abs(o.x0 - w.x0) < 1.5 and abs(o.top - w.top) < 1.5:
                dup = True
                break
        if not dup:
            out.append(w)
    return out


def page_words(page: Any) -> list[Word]:
    raw = page.extract_words(use_text_flow=True, keep_blank_chars=False, x_tolerance=1.5, y_tolerance=2)
    words = [Word(w["text"], float(w["x0"]), float(w["x1"]), float(w["top"]), float(w["bottom"])) for w in raw]
    words = _dedupe(words)
    words.sort(key=lambda w: (round(w.top / 2), w.x0))
    return words


def cluster_lines(words: list[Word], tolerance: float = 3.0) -> list[Line]:
    """Group words into lines by y-band, then order words by x within each line."""
    lines: list[Line] = []
    for w in sorted(words, key=lambda w: (w.top, w.x0)):
        if lines and abs(lines[-1].top - w.top) <= tolerance:
            lines[-1].words.append(w)
        else:
            lines.append(Line(top=w.top, words=[w]))
    for ln in lines:
        ln.words.sort(key=lambda w: w.x0)
    return lines


def page_lines(page: Any, tolerance: float = 3.0) -> list[Line]:
    return cluster_lines(page_words(page), tolerance)
