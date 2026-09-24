"""Build tests/fixtures/<software>-2025-1040-geometry.json from a real client copy.

The template keeps the Form 1040 pages' printed form text and its positions and nothing from the
return: every amount is dropped, and so is every row that carries no IRS line number, which is
where names, SSNs, addresses, dependents, bank details and signatures sit. Tokens with five or
more digits, masks (XXX, ***) and check marks are dropped from the rows that remain. The worker's
geometry test then places an amount on every line where the software prints it, so lines a real
return leaves blank are still proven to map.

    worker/.venv/Scripts/python scripts/make-geometry-template.py tests/fixtures/real/<return>.pdf

Review the output before committing it: it must read as blank IRS form text.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import pdfplumber  # noqa: E402

from recap.extract.identify import identify  # noqa: E402
from recap.extract.mapper import LINE_NO_RE, MARGIN_MAX_X, _paired_number, _row_number, read_pages  # noqa: E402
from recap.extract.profiles import load_profile  # noqa: E402
from recap.numbers import looks_like_amount  # noqa: E402

DROP_RE = re.compile(r"\d{5,}|[Xx*]{3,}|^[Xx✓✔☒]$|^\[?[Xx]\]?$")


def keep_word(text: str, x0: float) -> bool:
    if DROP_RE.search(text):
        return False
    if re.fullmatch(r"\d{4}", text):
        return True  # a tax year or form number in a label; UltraTax prints amounts >= 1,000 with commas
    if x0 >= 250 and looks_like_amount(text) and not LINE_NO_RE.match(text):
        return False  # an amount (a repeated IRS line number beside a column is kept)
    return not ("," in text and looks_like_amount(text))


def main(argv: list[str]) -> int:
    pdf_path = argv[1]
    ident = identify(pdf_path, str(ROOT / "form-profiles"))
    profile = load_profile(str(ROOT / "form-profiles"), "1040", ident.tax_year, ident.software)
    with pdfplumber.open(pdf_path) as pdf:
        pages = read_pages(pdf, profile)
    out: dict[str, list[dict]] = {}
    for kind in ("f1040_1", "f1040_2"):
        page = next(p for p in pages if p.kind == kind)
        words: list[dict] = []
        # Body of the form: page 1 from the income section down, page 2 above the signature block.
        # Unnumbered rows there keep only their left-margin sidebar words ("Married filing
        # jointly"), which share rows with amounts in the real layout; the header (names, SSNs,
        # address, dependents) and the signature block (preparer, firm, phone) are never read.
        lo, hi = (435.0, 760.0) if kind == "f1040_1" else (0.0, 590.0)
        for ln in page.lines:
            if not lo <= ln.top <= hi:
                continue
            number, label_words, _amounts = _row_number(ln, "auto", 500)
            numbered = bool(_paired_number(label_words) or number)
            for w in ln.words:
                if not numbered and w.x1 >= MARGIN_MAX_X:
                    continue
                if keep_word(w.text, w.x0):
                    words.append({"text": w.text, "x0": round(w.x0, 1), "x1": round(w.x1, 1), "top": round(w.top, 1), "bottom": round(w.bottom, 1)})
        out[kind] = words
    dest = ROOT / "tests" / "fixtures" / f"{ident.software}-{ident.tax_year}-1040-geometry.json"
    dest.write_text(json.dumps({"software": ident.software, "tax_year": ident.tax_year, "pages": out}, indent=1) + "\n")
    print(f"wrote {dest.relative_to(ROOT)}: " + ", ".join(f"{k} {len(v)} words" for k, v in out.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
