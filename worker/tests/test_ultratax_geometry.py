"""Every Form 1040 line on the real UltraTax layout maps, including lines no real fixture fills.

tests/fixtures/ultratax-2025-1040-geometry.json is the printed form text and positions of a real
UltraTax 2025 client copy with every amount removed (scripts/make-geometry-template.py). This test
writes an amount on every line, in the column UltraTax prints it in, measured on real returns:

- main column, right edge x~584.5: 1a-1h, 1z, 2b-6b, 7a-11a, 11b-24, 25d, 26, 32-35a, 37
- inner column, right edge x~469.3: 1i, 25a-25c, 27a-31, 36, 38
- "a" column, right edge x~293.4: 2a-6a (printed beside the matching "b" amount)

and requires every figure the profile reads to come back exactly, with no inner-column amount
leaking into a main-column line. A blank line on one return says nothing about the next, so the
test fills them all, then empties the main column and checks nothing is borrowed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from recap.extract.mapper import PageInfo, _paired_number, _row_number, map_lines
from recap.extract.pdf import Word, cluster_lines
from recap.extract.profiles import load_profile

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = json.loads((ROOT / "tests" / "fixtures" / "ultratax-2025-1040-geometry.json").read_text())
PROFILE = load_profile(str(ROOT / "form-profiles"), "1040", 2025, "ultratax")

MAIN, INNER, A_COL = 584.5, 469.3, 293.4
CHAR_W = 7.1  # UltraTax's amount font, points per character
VALUE_RISE = 3.8  # an amount's top sits this far above its row's line-number baseline

PAGE1_LINES = {
    MAIN: ["1a", "1b", "1c", "1d", "1e", "1f", "1g", "1h", "1z", "2b", "3b", "4b", "5b", "6b", "7a", "8", "9", "10", "11a"],
    INNER: ["1i"],
    A_COL: ["2a", "3a", "4a", "5a", "6a"],
}
PAGE2_LINES = {
    MAIN: ["11b", "12e", "13a", "13b", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25d", "26", "32", "33", "34", "35a", "37"],
    INNER: ["25a", "25b", "25c", "27a", "28", "29", "30", "31", "36", "38"],
}

# Figure path -> the line(s) it reads (summed).
EXPECTED = {
    "income.wages": ["1z"],
    "income.interest": ["2b"],
    "income.dividends": ["3b"],
    "income.ira_pensions": ["4b", "5b"],
    "income.social_security_taxable": ["6b"],
    "income.capital_gain": ["7a"],
    "income.schedule_1_total": ["8"],
    "income.total_income": ["9"],
    "adjustments.schedule_1_adjustments": ["10"],
    "adjustments.agi": ["11a"],
    "deductions.amount": ["12e"],
    "deductions.qbi": ["13a"],
    "deductions.additional": ["13b"],
    "deductions.taxable_income": ["15"],
    "tax.tax": ["16"],
    "tax.schedule_2_total": ["17"],
    "tax.nonrefundable_credits": ["21"],
    "tax.other_taxes": ["23"],
    "tax.total_tax": ["24"],
    "payments.withholding": ["25d"],
    "payments.estimates": ["26"],
    "payments.refundable_credits": ["32"],
    "payments.total_payments": ["33"],
    "result.refund": ["35a"],
    "result.applied_to_next_year": ["36"],
    "result.amount_owed": ["37"],
    "extras.estimated_tax_penalty": ["38"],
}


def _template_words(kind: str) -> list[Word]:
    return [Word(w["text"], w["x0"], w["x1"], w["top"], w["bottom"]) for w in TEMPLATE["pages"][kind]]


def _anchor_top(words: list[Word], line: str) -> float:
    """Top of the row whose amount belongs to `line`: the row carrying its repeated number beside
    an amount column, else the row it opens. An "a" line shares the row of its "b" line."""
    if line[-1] == "a" and line[:-1] in "23456":
        line = line[:-1] + "b"
    rows = cluster_lines(words, 3)
    for ln in rows:
        _n, label_words, _a = _row_number(ln, "auto", 500)
        if (_paired_number(label_words) or "").lower() == line.lower():
            return ln.top
    for ln in rows:
        number, _l, _a = _row_number(ln, "auto", 500)
        if (number or "").lower() == line.lower():
            return ln.top
    raise AssertionError(f"line {line} not found in the geometry template")


def _amount_word(text: str, right: float, top: float) -> Word:
    return Word(text, right - CHAR_W * len(text), right, top, top + 7.5)


def _page(kind: str, lines: dict[float, list[str]], values: dict[str, int]) -> PageInfo:
    words = _template_words(kind)
    base = list(words)
    for right, names in lines.items():
        for name in names:
            if name in values:
                words.append(_amount_word(f"{values[name]:,}", right, _anchor_top(base, name) - VALUE_RISE))
    rows = cluster_lines(words, float(PROFILE["geometry"]["y_tolerance"]))
    return PageInfo(1 if kind == "f1040_1" else 2, kind, rows, words, "\n".join(r.text for r in rows))


def _all_lines() -> list[str]:
    return [n for group in (PAGE1_LINES, PAGE2_LINES) for names in group.values() for n in names]


def _map(values: dict[str, int]) -> dict:
    pages = [_page("f1040_1", PAGE1_LINES, values), _page("f1040_2", PAGE2_LINES, values)]
    return map_lines(pages, PROFILE).values


def _get(values: dict, path: str) -> int | None:
    section, key = path.split(".")
    return (values.get(section) or {}).get(key)


def test_template_has_every_line():
    for kind, group in (("f1040_1", PAGE1_LINES), ("f1040_2", PAGE2_LINES)):
        words = _template_words(kind)
        for names in group.values():
            for name in names:
                _anchor_top(words, name)


def test_every_line_filled_maps_exactly():
    # Distinct amounts, several digits long, so a borrowed neighbour can never pass by accident.
    values = {name: 10_000 + 1_117 * i for i, name in enumerate(_all_lines())}
    got = _map(values)
    wrong = {}
    for path, lines in EXPECTED.items():
        want = sum(values[n] for n in lines)
        if _get(got, path) != want:
            wrong[path] = (_get(got, path), want)
    assert not wrong, f"misread lines (got, want): {wrong}"


def test_small_amounts_are_not_taken_for_line_numbers():
    # One- and two-digit amounts look like IRS line numbers; they must still read as amounts.
    values = {name: (i % 9) + 1 for i, name in enumerate(_all_lines())}
    got = _map(values)
    wrong = {p: (_get(got, p), sum(values[n] for n in ls)) for p, ls in EXPECTED.items() if _get(got, p) != sum(values[n] for n in ls)}
    assert not wrong, f"misread small amounts (got, want): {wrong}"


@pytest.mark.parametrize("column", ["inner", "a"])
def test_inner_amounts_never_leak_into_blank_main_lines(column):
    names = PAGE1_LINES[INNER] + PAGE2_LINES[INNER] if column == "inner" else PAGE1_LINES[A_COL]
    values = {name: 50_000 + 1_117 * i for i, name in enumerate(names)}
    got = _map(values)
    leaked = {}
    for path, lines in EXPECTED.items():
        want = sum(values.get(n, 0) for n in lines)
        have = _get(got, path)
        if (have or 0) != want:
            leaked[path] = (have, want)
    assert not leaked, f"figures read from the wrong column (got, want): {leaked}"
