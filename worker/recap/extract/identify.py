"""Identify software, form, tax year, and text coverage from a PDF's first pages.

Also finds the taxpayer names on Form 1040 page 1 by geometry: the value printed
directly under the "Your first name and middle initial" / "Last name" labels.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from .pdf import Word, page_words

YEAR_RE = re.compile(r"\b(20[1-3]\d)\b")
FORM_PAGE_RE = re.compile(r"U\.S\. Individual Income Tax Return", re.I)
OMB_RE = re.compile(r"OMB No\.? 1545-0074", re.I)


@dataclass
class Identification:
    software: str = "unknown"
    form: str | None = None
    tax_year: int | None = None
    form_page: int | None = None  # 1-based page where the IRS form itself starts
    page_count: int = 0
    text_coverage: float = 0.0  # 0..1 share of pages with usable text
    first_name: str | None = None
    last_name: str | None = None
    spouse_first_name: str | None = None
    pages_without_text: list[int] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@lru_cache(maxsize=4)
def load_signatures(profiles_dir: str) -> dict[str, dict[str, list[str]]]:
    p = Path(profiles_dir) / "signatures.yaml"
    with open(p, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def detect_software(text: str, signatures: dict[str, list[str]]) -> str:
    low = text.lower()
    for name, needles in signatures.items():
        if any(n.lower() in low for n in needles):
            return name
    return "unknown"


def detect_form(text: str, signatures: dict[str, list[str]]) -> str | None:
    low = text.lower()
    # more specific forms first (1040-SR before 1040)
    for name in sorted(signatures, key=lambda n: -len(n)):
        if any(n.lower() in low for n in signatures[name]):
            return name
    return None


def detect_tax_year(text: str) -> int | None:
    """Most frequent plausible year near a form header; ties go to the larger year."""
    counts: dict[int, int] = {}
    for m in re.finditer(r"(?:form\s+1040[^\n]{0,20}?\(?\s*(20[1-3]\d)\)?|tax\s+year\s+(20[1-3]\d))", text, re.I):
        y = int(m.group(1) or m.group(2))
        counts[y] = counts.get(y, 0) + 3
    for m in YEAR_RE.finditer(text):
        y = int(m.group(1))
        counts[y] = counts.get(y, 0) + 1
    if not counts:
        return None
    return max(counts, key=lambda y: (counts[y], y))


def _label_words(words: list[Word], phrase: str) -> list[Word] | None:
    """Find consecutive words matching the phrase (case-insensitive) on one line band."""
    parts = phrase.lower().split()
    n = len(parts)
    for i in range(len(words) - n + 1):
        seq = words[i : i + n]
        if [w.text.lower().strip(",:") for w in seq] == parts and max(w.top for w in seq) - min(w.top for w in seq) < 3:
            return seq
    return None


def find_names(words: list[Word]) -> tuple[str | None, str | None, str | None]:
    """Names printed under the IRS name labels on page 1."""
    first_lbl = _label_words(words, "Your first name and middle initial")
    if not first_lbl:
        return None, None, None
    top = max(w.bottom for w in first_lbl)
    last_lbl = _label_words([w for w in words if abs(w.top - first_lbl[0].top) < 3], "Last name")
    ssn_lbl = _label_words([w for w in words if abs(w.top - first_lbl[0].top) < 3], "Your social security number")
    first_x0 = first_lbl[0].x0 - 4
    last_x0 = last_lbl[0].x0 - 4 if last_lbl else 10_000
    ssn_x0 = ssn_lbl[0].x0 - 4 if ssn_lbl else 10_000
    band = [w for w in words if top - 1 <= w.top <= top + 20]
    first = " ".join(w.text for w in band if first_x0 <= w.x0 < last_x0)
    last = " ".join(w.text for w in band if last_x0 <= w.x0 < ssn_x0)
    first = _clean_name(first)
    last = _clean_name(last)
    # optional spouse row
    spouse = None
    sp_lbl = _label_words(words, "If joint return, spouse's first name and middle initial") or _label_words(words, "Spouse's first name and middle initial")
    if sp_lbl:
        sp_top = max(w.bottom for w in sp_lbl)
        sp_band = [w for w in words if sp_top - 1 <= w.top <= sp_top + 20 and first_x0 <= w.x0 < last_x0]
        spouse = _clean_name(" ".join(w.text for w in sp_band)) or None
    return first or None, last or None, spouse


def _clean_name(s: str) -> str:
    s = re.sub(r"[^A-Za-z' .-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    # drop a trailing middle initial ("Alex J" -> "Alex")
    parts = s.split(" ")
    if len(parts) > 1 and len(parts[-1].rstrip(".")) == 1:
        parts = parts[:-1]
    return " ".join(parts)


def identify(pdf_path: str, profiles_dir: str | None = None, max_pages: int = 3) -> Identification:
    import pdfplumber

    profiles_dir = profiles_dir or os.environ.get("FORM_PROFILES_DIR") or str(Path(__file__).resolve().parents[3] / "form-profiles")
    sigs = load_signatures(profiles_dir)
    ident = Identification()
    with pdfplumber.open(pdf_path) as pdf:
        ident.page_count = len(pdf.pages)
        texts: list[str] = []
        empty: list[int] = []
        form_idx: int | None = None
        for i, page in enumerate(pdf.pages):
            t = page.extract_text() or ""
            texts.append(t)
            if len(t.strip()) < 40:
                empty.append(i + 1)
            # Client copies open with letters, invoices, and summaries; the return itself can start
            # a dozen pages in. The form page is the one with the IRS title and its OMB number.
            if form_idx is None and FORM_PAGE_RE.search(t) and OMB_RE.search(t):
                form_idx = i
        ident.pages_without_text = empty
        ident.text_coverage = round(1 - len(empty) / max(1, ident.page_count), 3)
        head = "\n".join(texts[:max_pages])
        form_text = texts[form_idx] if form_idx is not None else ""
        ident.form_page = form_idx + 1 if form_idx is not None else None
        # Vendor signatures can sit anywhere: a footer code, a report title, a cover page.
        ident.software = detect_software("\n".join(texts), sigs.get("software", {}))
        ident.form = detect_form(form_text or head, sigs.get("form", {}))
        ident.tax_year = detect_tax_year(form_text or head)
        if pdf.pages:
            words = page_words(pdf.pages[form_idx if form_idx is not None else 0])
            ident.first_name, ident.last_name, ident.spouse_first_name = find_names(words)
    return ident
