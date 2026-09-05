"""The verifier's own PDF text pass. Deliberately separate from recap.extract.pdf.

Different tolerances and a different clustering strategy are fine here; the point is that an
extraction bug cannot be mirrored into the verifier by shared code.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import pdfplumber

# Rows on a 1040 are 12 points apart. Words within LINE_BAND form a row; a row that is only an
# amount is then attached to the nearest labelled row within VALUE_ROW_REACH (some software
# prints amounts as separate text objects about 4 points above the label's baseline).
LINE_BAND = 3.0
VALUE_ROW_REACH = 6.0
_BARE_LINE_NO = re.compile(r"^\d{1,2}[a-z]?\.?$", re.I)


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
                if lines and abs(lines[-1].top - w.top) <= LINE_BAND:
                    lines[-1].words.append(w)
                else:
                    lines.append(VLine(i + 1, w.top, [w]))
            lines = _attach_value_rows(lines)
            for ln in lines:
                ln.words.sort(key=lambda w: w.x0)
            pages.append(VPage(i + 1, lines, "\n".join(ln.text for ln in lines)))
    return pages


_AMOUNT_TOKEN = re.compile(r"[\(\-\$]?[\d,]+\.?\d*[\)\-]?")
_FILLER_TOKEN = re.compile(r"[.…:\-_]+")


def _value_words(ln: VLine) -> list[VWord]:
    """The amounts of a row that holds nothing but amounts, dotted leaders, and sidebar text."""
    amounts: list[VWord] = []
    for w in ln.words:
        if w.x1 < 75 or _FILLER_TOKEN.fullmatch(w.text):
            continue
        if not _AMOUNT_TOKEN.fullmatch(w.text):
            return []
        amounts.append(w)
    return amounts


def _attach_value_rows(lines: list[VLine]) -> list[VLine]:
    """Merge rows that hold only an amount into the nearest labelled row within VALUE_ROW_REACH.

    Some software prints each amount as its own text object a few points above the label's
    baseline. Distance is measured from the amount itself (leader dots can start the row higher).
    Nearest labelled neighbour wins; a value exactly between two labels is left alone.
    """
    out: list[VLine] = []
    # Only rows with real label text can receive a value; rows of dotted leaders cannot.
    labelled = [ln for ln in lines if any(w.x1 >= 75 and not _FILLER_TOKEN.fullmatch(w.text) and not _AMOUNT_TOKEN.fullmatch(w.text) for w in ln.words)]
    for ln in lines:
        amounts = _value_words(ln)
        if not amounts:
            out.append(ln)
            continue
        anchor = sum(w.top for w in amounts) / len(amounts)
        near = sorted(((abs(o.top - anchor), o) for o in labelled if abs(o.top - anchor) <= VALUE_ROW_REACH), key=lambda t: t[0])
        if near and (len(near) == 1 or near[0][0] < near[1][0]):
            near[0][1].words.extend(ln.words)
        else:
            out.append(ln)
    return out


def page_kind(page: VPage) -> str:
    """Coarse page role for the verifier.

    Client copies quote form names in letters, summaries, worksheets and reports, so a federal
    form page must carry the IRS OMB number (page 1 and schedules) or the "Form 1040 (year) ...
    Page 2" header (page 2). State pages are resolved by the verifier from states.yaml.
    """
    head = "\n".join(ln.text for ln in page.lines[:6]).lower()
    text = page.text.lower()
    if "two-year comparison" in head or "two year comparison" in head or "comparison" in head:
        return "comparison"
    if "schedule a" in head and "(form 1040" in head and "omb no. 1545" in text:
        return "schedule_a"
    if "schedule 1" in head and "(form 1040" in head and "omb no. 1545" in text:
        return "schedule_1"
    if "form 2210" in head and "worksheet" not in head:
        return "form_2210"
    if "schedule" in head and "(form 1040" in head:
        return "other"  # any other schedule or attached form
    if "u.s. individual income tax return" in head and "omb no. 1545-0074" in text:
        return "f1040"
    if re.search(r"form 1040(?:-sr)? \(20\d\d\)", head) and "page 2" in text and "filing status" not in text:
        return "f1040"
    if "income tax return" in head and "u.s. individual" not in head:
        return "state"
    return "other"


def rightmost_amount(line: VLine, parse: Any) -> int | None:
    """The amount printed furthest right on a line.

    Amounts live in the right part of the page (x0 past 380 on a letter page); numbers inside the
    label text ("Form 8888", "line 33") do not count. A bare one- or two-digit token is an IRS line
    number unless it sits in the amount column itself (x0 past 500), so "37 ... amount you owe"
    with no value reads as None, not 37.
    """
    for w in sorted(line.words, key=lambda w: -w.x1):
        if not any(ch.isdigit() for ch in w.text) or w.x0 < 380:
            continue
        if _BARE_LINE_NO.match(w.text) and w.x0 < 500:
            continue
        v = parse(w.text)
        if v is not None:
            return v
    return None
