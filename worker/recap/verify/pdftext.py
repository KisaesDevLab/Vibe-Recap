"""The verifier's own PDF text pass. Deliberately separate from recap.extract.pdf.

Different tolerances and a different clustering strategy are fine here; the point is that an
extraction bug cannot be mirrored into the verifier by shared code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pdfplumber


@dataclass(frozen=True)
class VWord:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float


@dataclass
class VLine:
    page: int
    top: float
    words: list[VWord]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


@dataclass
class VPage:
    number: int
    lines: list[VLine]
    text: str


def read_pdf(path: str) -> list[VPage]:
    pages: list[VPage] = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            raw = page.extract_words(use_text_flow=True, x_tolerance=2, y_tolerance=2.5)
            words = [VWord(w["text"], float(w["x0"]), float(w["x1"]), float(w["top"]), float(w["bottom"])) for w in raw]
            words.sort(key=lambda w: (round(w.top / 2.5), w.x0))
            lines: list[VLine] = []
            for w in words:
                if lines and abs(lines[-1].top - w.top) <= 3.5:
                    lines[-1].words.append(w)
                else:
                    lines.append(VLine(i + 1, w.top, [w]))
            for ln in lines:
                ln.words.sort(key=lambda w: w.x0)
            pages.append(VPage(i + 1, lines, "\n".join(ln.text for ln in lines)))
    return pages


def page_kind(page: VPage) -> str:
    """Coarse page role for the verifier, from header text only."""
    head = "\n".join(ln.text for ln in page.lines[:4]).lower()
    if "two-year comparison" in head or "two year comparison" in head or "comparison" in head:
        return "comparison"
    if "schedule a (form 1040" in head:
        return "schedule_a"
    if "schedule 1 (form 1040" in head:
        return "schedule_1"
    if "form 2210" in head:
        return "form_2210"
    if "form 1040" in head:
        return "f1040"
    if "income tax return" in head and "u.s. individual" not in head:
        return "state"
    return "other"


def rightmost_amount(line: VLine, parse: Any) -> int | None:
    for w in sorted(line.words, key=lambda w: -w.x1):
        v = parse(w.text)
        if v is not None and any(ch.isdigit() for ch in w.text):
            return v
    return None
