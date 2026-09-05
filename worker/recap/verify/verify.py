"""Independent script-to-return verifier (docs/PLAN.md §5a).

Reads the uploaded PDF with its own text pass and checks every amount and fact the script
states against what the return itself prints. It never reads extraction.json, so an
extraction bug that produced a wrong-but-consistent JSON is still caught here.

Allowed shared code: recap.numbers (normalization) only. A test greps the imports.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

from ..numbers import amount_variants, find_amount_tokens, normalize_pct, parse_amount
from .pdftext import VPage, page_kind, read_pdf, rightmost_amount

TAG_RE = re.compile(r"\[\[slide:([a-z_]+)\]\]")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
PCT_RE = re.compile(r"(?<![\w.])(-?\d+(?:\.\d+)?)\s*%")
YEAR_RE = re.compile(r"\b(20[1-3]\d)\b")
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
EIN_RE = re.compile(r"\b\d{2}-\d{7}\b")
NINE_DIGITS_RE = re.compile(r"(?<!\d)\d{9}(?!\d)")
YOY_WORDS = re.compile(r"\b(last year|prior year|previous year|a year ago|compared (?:to|with)|year[- ]over[- ]year|up from|down from|increase[d]?|decrease[d]?|higher than|lower than|more than last|less than last)\b", re.I)

STATUS_PHRASES = {
    "S": ["single"],
    "MFJ": ["married filing jointly", "filing jointly", "joint return"],
    "MFS": ["married filing separately", "filing separately"],
    "HOH": ["head of household"],
    "QSS": ["qualifying surviving spouse", "surviving spouse", "qualifying widow"],
}
STATUS_LABELS = {
    "S": "Single",
    "MFJ": "Married filing jointly",
    "MFS": "Married filing separately",
    "HOH": "Head of household",
    "QSS": "Qualifying surviving spouse|Qualifying widow",
}

# Script phrases that name a specific Form 1040 line. An amount stated right after one of these
# must equal that line on the return; existence elsewhere on the return is not enough.
LABELED_PHRASES = [
    ("total income", "total_income"),
    ("adjusted gross income", "agi"),
    ("taxable income", "taxable_income"),
    ("total federal tax", "total_tax"),
    ("total tax", "total_tax"),
    ("refund", "refund"),
    ("balance due", "amount_owed"),
    ("amount due", "amount_owed"),
    ("withholding", "withholding"),
]

# Where the coverage figures live on Form 1040, by label (independent of the profiles).
# Page types that quote state names and form labels without being the return itself.
_NON_FORM_PAGE = re.compile(r"Return Summary|Filing Instructions|Worksheet|Report|Projection|Comparison|\bDear |Sincerely|Signature Authorization|Estimated Tax Voucher|Payment Voucher")

LINE_LABELS = {
    "total_income": r"total income",
    "agi": r"adjusted gross income",
    "taxable_income": r"taxable income",
    "total_tax": r"total tax",
    "overpaid": r"overpaid",
    "refund": r"refunded to you",
    "amount_owed": r"amount you owe",
    "withholding": r"withheld|lines 25a through 25c",  # the real form's 25d says "Add lines 25a through 25c"
}


@dataclass
class Item:
    kind: str
    text: str
    status: str  # verified | flagged
    slide: str | None = None
    page: int | None = None
    label: str | None = None
    reason: str | None = None


@dataclass
class Verification:
    passed: bool
    items: list[Item] = field(default_factory=list)
    source_sha256: str = ""
    script_sha256: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "items": [{k: v for k, v in asdict(i).items() if v is not None} for i in self.items],
            "source_sha256": self.source_sha256,
            "script_sha256": self.script_sha256,
        }


# ---------------------------------------------------------------------------
# Return facts, read independently
# ---------------------------------------------------------------------------


@dataclass
class ReturnFacts:
    tax_year: int | None = None
    filing_status: str | None = None
    first_name: str | None = None
    spouse_first_name: str | None = None
    address_line: str | None = None
    itemized: bool = False
    states: list[str] = field(default_factory=list)
    lines: dict[str, int] = field(default_factory=dict)
    prior: dict[str, int] = field(default_factory=dict)
    account_numbers: list[str] = field(default_factory=list)
    amount_index: dict[int, list[tuple[int, str]]] = field(default_factory=dict)  # value -> [(page, label)]
    state_amounts: set[int] = field(default_factory=set)  # amounts printed on state return pages


def _find_seq(words: list[Any], phrase: str) -> int | None:
    parts = [re.sub(r"[^a-z0-9]", "", p.lower()) for p in phrase.split()]
    n = len(parts)
    for i in range(len(words) - n + 1):
        if [re.sub(r"[^a-z0-9]", "", w.text.lower()) for w in words[i : i + n]] == parts:
            return i
    return None


def _first_line_amount(pages: list[VPage], label_re: str, kinds: tuple[str, ...] = ("f1040",)) -> tuple[int, int, str] | None:
    for p in pages:
        if page_kind(p) not in kinds:
            continue
        for i, ln in enumerate(p.lines):
            if not re.search(label_re, ln.text, re.I):
                continue
            v = rightmost_amount(ln, parse_amount)
            if v is not None:
                return v, p.number, ln.text[:80]
            # A two-row label ("37 ... amount you owe. / For details on how to pay ... 37  11,197"):
            # the amount sits on the continuation row that repeats the line number at the right.
            number = next((w.text for w in sorted(ln.words, key=lambda w: w.x0) if re.fullmatch(r"\d{1,2}[a-z]?", w.text)), None)
            if number:
                for nxt in p.lines[i + 1 : i + 3]:
                    if any(w.text == number and w.x0 >= 400 for w in nxt.words):
                        v = rightmost_amount(nxt, parse_amount)
                        if v is not None:
                            return v, p.number, ln.text[:80]
                        break
    return None


def read_return(pages: list[VPage], prior_pages: list[VPage] | None, profiles_dir: str | None) -> ReturnFacts:
    f = ReturnFacts()
    f1040 = [p for p in pages if page_kind(p) == "f1040"]
    # tax year from the header
    for p in f1040[:1]:
        m = re.search(r"form\s+1040[^\n]{0,15}?\(?\s*(20[1-3]\d)", p.text, re.I) or re.search(r"tax year\s+(20[1-3]\d)", p.text, re.I)
        if m:
            f.tax_year = int(m.group(1))
    # names and address from page 1 labels
    if f1040:
        p1 = f1040[0]
        allw = [w for ln in p1.lines for w in sorted(ln.words, key=lambda w: w.x0)]
        for ln in p1.lines:
            words = sorted(ln.words, key=lambda w: w.x0)
            i = _find_seq(words, "Your first name and middle initial")
            if i is not None:
                j = _find_seq(words, "Last name")
                x_first = words[i].x0 - 4
                x_last = words[j].x0 - 4 if j is not None else 10_000
                band = [w for w in allw if ln.top + 6 <= w.top <= ln.top + 26 and x_first <= w.x0 < x_last]
                if band:
                    f.first_name = band[0].text.strip(",")
            i = _find_seq(words, "spouse's first name and middle initial")
            if i is not None:
                j = _find_seq(words, "Last name")
                x_first = words[0].x0 - 4
                x_last = words[j].x0 - 4 if j is not None else 10_000
                band = [w for w in allw if ln.top + 6 <= w.top <= ln.top + 26 and x_first <= w.x0 < x_last]
                if band:
                    f.spouse_first_name = band[0].text.strip(",")
            i = _find_seq(words, "Home address")
            if i is not None:
                band = [w for w in allw if ln.top + 6 <= w.top <= ln.top + 26]
                if band:
                    f.address_line = " ".join(w.text for w in sorted(band, key=lambda w: w.x0))
        f.filing_status = _filing_status(p1)
    f.itemized = any(page_kind(p) == "schedule_a" for p in pages)
    # states: a state form starts on a non-federal page whose header names the state or its form id
    # and continues over following unclassified pages that still mention the state. Letters, filing
    # instructions, summaries, worksheets and reports never count, whatever they mention.
    state_of_page: dict[int, str] = {}
    if profiles_dir and Path(profiles_dir, "states.yaml").exists():
        with open(Path(profiles_dir, "states.yaml"), encoding="utf-8") as fh:
            states = yaml.safe_load(fh)["states"]
        current: str | None = None
        for p in pages:
            kind = page_kind(p)
            head = "\n".join(ln.text for ln in p.lines[:10])
            if kind not in ("state", "other") or _NON_FORM_PAGE.search(head) or "omb no. 1545" in p.text.lower():
                current = None
                continue
            code = next((c for c, needles in states.items() if any(re.search(rf"\b{re.escape(n)}\b", head, re.I) for n in needles)), None)
            if code is None and current and re.search(rf"\b{re.escape(states[current][0])}\b", p.text, re.I):
                code = current
            if code is None:
                current = None
                continue
            current = code
            state_of_page[p.number] = code
            if code not in f.states:
                f.states.append(code)
    # key lines
    for key, label in LINE_LABELS.items():
        hit = _first_line_amount(pages, label)
        if hit:
            f.lines[key] = hit[0]
    # bank numbers on the refund line area
    for p in f1040:
        for m in re.finditer(r"(?:routing|account)\s+number\s+(\d{6,17})", p.text, re.I):
            f.account_numbers.append(m.group(1))
    # prior year: prior PDF beats comparison page
    if prior_pages:
        for key in ("agi", "total_tax", "refund", "amount_owed"):
            hit = _first_line_amount(prior_pages, LINE_LABELS[key])
            if hit:
                f.prior[key] = hit[0]
        f.prior["source"] = 1  # marker only
    else:
        # The federal comparison may span two consecutive pages; a state or schedule comparison
        # printed elsewhere never joins it.
        cmp_pages: list[VPage] = []
        for p in pages:
            if page_kind(p) == "comparison" and (not cmp_pages or p.number == cmp_pages[-1].number + 1):
                cmp_pages.append(p)
            elif cmp_pages:
                break
        col_x = None
        if cmp_pages and f.tax_year:
            # The column header is a short row of years; a report title naming both years is not it.
            for ln in cmp_pages[0].lines:
                ys = [w for w in ln.words if w.text in (str(f.tax_year - 1), str(f.tax_year))]
                if len(ys) >= 2 and len(ln.words) <= 4:
                    col_x = next(w.x0 for w in ys if w.text == str(f.tax_year - 1))
                    break
        if col_x is not None:
            labels = (
                ("agi", r"adjusted gross income"),
                ("total_tax", r"total tax(?! from)"),
                ("refund", r"refund received|^refund\b(?! applied)|\brefund$"),
                ("amount_owed", r"amount owed|balance due|amount due|amount you owe|\btax due$"),
                ("_net", r"net tax due/-refund|net refund/-due|balance due/-refund"),
                ("_net2", r"^tax due/-refund"),
            )
            # Rows without a printed amount (a blank line in a report) are skipped, not treated as
            # the answer: a later row with the same label and a value wins.
            for key, label in labels:
                done = False
                for cp in cmp_pages:
                    for ln in cp.lines:
                        lab = " ".join(w.text for w in ln.words if parse_amount(w.text) is None or not any(c.isdigit() for c in w.text))
                        lab = re.sub(r"^\s*\d{1,2}[a-z]?\.\s*", "", lab)  # "70. Refund received" -> "Refund received"
                        if not re.search(label, lab, re.I):
                            continue
                        nums = [w for w in ln.words if parse_amount(w.text) is not None and any(c.isdigit() for c in w.text) and not re.fullmatch(r"\d{1,2}[a-z]?\.", w.text)]
                        if not nums:
                            continue
                        near = min(nums, key=lambda w: abs((w.x0 + w.x1) / 2 - col_x - 10))
                        v = parse_amount(near.text)
                        if v is not None:
                            f.prior[key] = abs(v) if key in ("refund", "amount_owed") else v
                            done = True
                            break
                    if done:
                        break
            # A single signed "net tax due/-refund" row stands in when the report has no separate rows.
            net2 = f.prior.pop("_net2", None)
            net = f.prior.pop("_net", None)
            net = net if net is not None else net2
            if net is not None and "refund" not in f.prior and "amount_owed" not in f.prior:
                if net > 0:
                    f.prior["amount_owed"] = net
                elif net < 0:
                    f.prior["refund"] = -net
    # amount index across every page: value -> (page, label)
    for p in pages:
        for ln in p.lines:
            for w in ln.words:
                if not any(c.isdigit() for c in w.text):
                    continue
                v = parse_amount(w.text)
                if v is None:
                    continue
                # A printed zero counts only in the amount column ("24 ... total tax 24  0"), so a
                # script's "$0" traces to a line that really shows zero, not to a stray digit.
                if v == 0 and not (w.text.strip("$") in ("0", "-0-", "0.00") and w.x0 >= 380):
                    continue
                label = " ".join(x.text for x in ln.words if x is not w)[:80]
                f.amount_index.setdefault(abs(v), []).append((p.number, label))
                if p.number in state_of_page:
                    f.state_amounts.add(abs(v))
    return f


def _load_states(profiles_dir: str | None) -> dict[str, list[str]]:
    if profiles_dir and Path(profiles_dir, "states.yaml").exists():
        with open(Path(profiles_dir, "states.yaml"), encoding="utf-8") as fh:
            return yaml.safe_load(fh)["states"]
    return {}


def _filing_status(p1: VPage) -> str | None:
    present: list[str] = []
    marked: list[str] = []
    allw = [w for ln in p1.lines for w in ln.words]
    for code, pat in STATUS_LABELS.items():
        for alt in pat.split("|"):
            for ln in p1.lines:
                words = sorted(ln.words, key=lambda w: w.x0)
                i = _find_seq(words, alt)
                if i is None:
                    continue
                present.append(code)
                before = " ".join(w.text for w in words[max(0, i - 3) : i] if words[i].x0 - w.x1 < 40)
                if re.search(r"\[\s*[xX✓☒]\s*\]\s*$", before) or (re.search(r"(^|\s)[xX✓☒](\s|$)", before) and not re.search(r"\[\s*\]\s*$", before)):
                    marked.append(code)
                    break
                # The mark can be its own text object on a slightly different baseline (UltraTax).
                anchor = words[i]
                if any(re.fullmatch(r"[xX✓☒]", w.text) and 0 <= anchor.x0 - w.x1 < 40 and abs(w.top - anchor.top) <= 6 for w in allw):
                    marked.append(code)
                break
            if code in present:
                break
    marked = list(dict.fromkeys(marked))
    if len(marked) == 1:
        return marked[0]
    if not marked and len(present) == 1:
        return present[0]
    return None


# ---------------------------------------------------------------------------
# Script facts
# ---------------------------------------------------------------------------


def _sentences_by_slide(script: str) -> list[tuple[str, str]]:
    parts = TAG_RE.split(script)
    out: list[tuple[str, str]] = []
    for i in range(1, len(parts) - 1, 2):
        slide = parts[i]
        for s in SENTENCE_RE.split(parts[i + 1].strip()):
            if s.strip():
                out.append((slide, s.strip()))
    if not out:
        out = [("", s.strip()) for s in SENTENCE_RE.split(script) if s.strip()]
    return out


def _mentions(sentence: str, words: list[str]) -> bool:
    low = sentence.lower()
    return any(w in low for w in words)


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify(script: str, source_pdf: str, prior_pdf: str | None = None, profiles_dir: str | None = None) -> Verification:
    pages = read_pdf(source_pdf)
    prior_pages = read_pdf(prior_pdf) if prior_pdf else None
    facts = read_return(pages, prior_pages, profiles_dir)
    items: list[Item] = []
    sentences = _sentences_by_slide(script)
    body = TAG_RE.sub(" ", script)

    # -- amounts ------------------------------------------------------------
    for slide, sent in sentences:
        for tok, value in find_amount_tokens(sent):
            if "$" not in tok and "," not in tok:
                continue
            hits = facts.amount_index.get(abs(value), [])
            if hits:
                page, label = hits[0]
                items.append(Item("amount", tok, "verified", slide, page, label))
            else:
                items.append(Item("amount", tok, "flagged", slide, reason="not found on any page of the return"))

    # -- labeled amounts: "adjusted gross income was $X" must equal line 11, and so on --------
    L = facts.lines
    state_word_early = re.compile(r"\bstate\b|" + "|".join(re.escape(n[0]) for n in _load_states(profiles_dir).values()), re.I)
    for slide, sent in sentences:
        if YOY_WORDS.search(sent) or state_word_early.search(sent):
            continue
        for phrase, key in LABELED_PHRASES:
            m = re.search(re.escape(phrase) + r"\b\W*(?:[\w'-]+\W+){0,6}?\$([\d,]{3,}(?<=\d))", sent, re.I)  # greedy, no trailing comma
            if not m:
                continue
            line_val = L.get(key)
            if line_val is None:
                continue
            # "the income tax on your taxable income was $13,240" names the tax, not the line.
            if re.search(r"\b(tax|taxes|rate|percent|%)\s+(on|of)\s+(?:your\s+|the\s+|that\s+)?$", sent[: m.start()], re.I):
                continue
            # The first amount within six words is the claim, but the rest of the same clause counts
            # too: "adjusted gross income, after $848 in adjustments, was $170,112" names the line's
            # value second. The clause ends at a period or semicolon.
            clause = re.split(r"[.;]", sent[m.end() :], maxsplit=1)[0][:60]
            before = sent[max(0, m.start() - 40) : m.start()]  # "paid in $6,400 through withholding"
            saids = [parse_amount(m.group(1))] + [parse_amount(a) for a in re.findall(r"\$([\d,]{3,}(?<=\d))", before + " " + clause)]
            saids = [s for s in saids if s is not None]
            if not any(abs(abs(s) - abs(line_val)) <= 1 for s in saids):
                items.append(Item("amount", f"${m.group(1)}", "flagged", slide, reason=f"script calls it the {phrase} but the return's {phrase} line shows {line_val:,}"))
            break

    # -- percentages --------------------------------------------------------
    allowed_pcts: dict[float, str] = {}
    if L.get("total_tax") is not None and L.get("taxable_income"):
        allowed_pcts[round(L["total_tax"] / L["taxable_income"] * 100, 1)] = "total tax / taxable income"
    if L.get("total_tax") is not None and L.get("agi"):
        allowed_pcts[round(L["total_tax"] / L["agi"] * 100, 1)] = "total tax / adjusted gross income"
    for key in ("agi", "total_tax"):
        cur, prior = L.get(key), facts.prior.get(key)
        if cur is not None and prior:
            allowed_pcts[round(abs(cur - prior) / abs(prior) * 100, 1)] = f"year-over-year {key} change"
    if L.get("withholding") is not None and L.get("total_tax"):
        allowed_pcts[round(L["withholding"] / L["total_tax"] * 100, 1)] = "withholding / total tax"
    for slide, sent in sentences:
        for m in PCT_RE.finditer(sent):
            v = abs(float(m.group(1)))
            match = next((lab for a, lab in allowed_pcts.items() if abs(a - v) <= 0.1 + 1e-6 or (v.is_integer() and round(a) == v)), None)
            if match:
                items.append(Item("percent", m.group(0).strip(), "verified", slide, label=f"recomputed: {match}"))
            else:
                items.append(Item("percent", m.group(0).strip(), "flagged", slide, reason="does not match any rate recomputed from the return"))

    # -- year-over-year deltas ------------------------------------------------
    for slide, sent in sentences:
        if not YOY_WORDS.search(sent):
            continue
        amounts = [v for tok, v in find_amount_tokens(sent) if "$" in tok or "," in tok]
        if not amounts:
            continue
        if not facts.prior:
            items.append(Item("yoy", sent[:80], "flagged", slide, reason="script compares to last year but the return has no prior-year figures"))
            continue
        deltas = {abs(L[k] - facts.prior[k]) for k in ("agi", "total_tax", "refund", "amount_owed") if k in L and k in facts.prior}
        deltas |= {abs(v) for v in facts.prior.values() if isinstance(v, int)}
        deltas |= {abs(L.get("refund", 0) - L.get("amount_owed", 0) - (facts.prior.get("refund", 0) - facts.prior.get("amount_owed", 0)))}
        # "unchanged": a figure that is the same both years, including one that is zero now and
        # blank (unprinted) in the prior-year column of the comparison
        if any(L.get(k, 0) == facts.prior.get(k, 0) for k in ("agi", "total_tax", "refund", "amount_owed") if k in L or k in facts.prior):
            deltas.add(0)
        for v in amounts:
            if any(abs(abs(v) - d) <= 1 for d in deltas) or abs(v) in facts.amount_index:
                items.append(Item("yoy", f"{v:,}", "verified", slide, label="recomputed from prior-year figures"))
            else:
                items.append(Item("yoy", f"{v:,}", "flagged", slide, reason="not a year-over-year difference the return supports"))

    # -- tax year -------------------------------------------------------------
    years = YEAR_RE.findall(body)
    if facts.tax_year is None:
        items.append(Item("tax_year", "?", "flagged", reason="tax year not found on the return"))
    else:
        n = years.count(str(facts.tax_year))
        others = [y for y in years if y != str(facts.tax_year)]
        # The return's year must be stated and no other year may appear (Q36 relaxes "exactly once").
        if n >= 1 and not others:
            items.append(Item("tax_year", str(facts.tax_year), "verified", page=1, label="Form 1040 header"))
        elif n == 0:
            items.append(Item("tax_year", str(facts.tax_year), "flagged", reason="script never states the tax year"))
        else:
            items.append(Item("tax_year", ", ".join(dict.fromkeys(years)), "flagged", reason=f"script mentions a year other than {facts.tax_year}"))

    # -- filing status --------------------------------------------------------
    said = [code for code, phrases in STATUS_PHRASES.items() if _mentions(body, phrases)]
    if "MFJ" in said and "MFS" in said and "separately" not in body.lower():
        said.remove("MFS")
    if "S" in said and re.search(r"\bsingle\b", body, re.I) is None:
        said.remove("S")
    if facts.filing_status is None:
        items.append(Item("filing_status", ", ".join(said) or "-", "flagged", reason="filing status not found on the return"))
    elif not said:
        items.append(Item("filing_status", "-", "verified", page=1, label="not mentioned in the script"))
    elif said == [facts.filing_status]:
        items.append(Item("filing_status", said[0], "verified", page=1, label=STATUS_LABELS[facts.filing_status].split("|")[0]))
    else:
        items.append(Item("filing_status", ", ".join(said), "flagged", reason=f"return is {STATUS_LABELS[facts.filing_status].split('|')[0]}"))

    # -- names ------------------------------------------------------------------
    greeting = next((s for sl, s in sentences if sl == "greeting"), sentences[0][1] if sentences else "")
    cap_words = re.findall(r"\b[A-Z][a-z]+\b", greeting)
    stop = {"Hi", "Hello", "Welcome", "Thanks", "Thank", "Here", "This", "Your", "The", "Let", "We", "It", "Good", "Dear", "For", "In", "On"}
    names_said = [w for w in cap_words if w not in stop and w != str(facts.tax_year)]
    allowed_names = {n.casefold() for n in (facts.first_name, facts.spouse_first_name) if n}
    if facts.filing_status not in ("MFJ", "MFS"):
        allowed_names.discard((facts.spouse_first_name or "").casefold())
    bad = [n for n in names_said if n.casefold() not in allowed_names]  # returns often print names in capitals
    if not names_said:
        items.append(Item("names", "-", "verified", "greeting", label="no name used"))
    elif not bad:
        items.append(Item("names", ", ".join(names_said), "verified", "greeting", page=1, label="name line on Form 1040"))
    else:
        items.append(Item("names", ", ".join(bad), "flagged", "greeting", reason="not the taxpayer name(s) on the return"))

    state_names: dict[str, list[str]] = {}
    if profiles_dir and Path(profiles_dir, "states.yaml").exists():
        with open(Path(profiles_dir, "states.yaml"), encoding="utf-8") as fh:
            state_names = yaml.safe_load(fh)["states"]

    # -- direction ------------------------------------------------------------
    refund_amt = L.get("refund", 0) or L.get("overpaid", 0)
    owed_amt = L.get("amount_owed", 0)
    # Only federal sentences count: a state balance due next to a federal refund is legitimate.
    state_word = re.compile(r"\bstate\b|" + "|".join(re.escape(n[0]) for n in state_names.values()) if state_names else r"\bstate\b", re.I)
    # A sentence is a state sentence when it names a state, says "state", or every amount in it
    # is printed on a state page and none on a federal page (e.g. "a small balance due of $120"
    # following the Missouri sentence).
    def _is_state_sentence(s: str) -> bool:
        if state_word.search(s):
            return True
        amts = [abs(v) for tok, v in find_amount_tokens(s) if "$" in tok or "," in tok]
        federal_pages = {p.number for p in pages if page_kind(p) == "f1040"}
        if not amts:
            return False
        for a in amts:
            on_federal = any(pg in federal_pages for pg, _l in facts.amount_index.get(a, []))
            if on_federal or a not in facts.state_amounts:
                return False
        return True

    federal_sentences = [s for _sl, s in sentences if not _is_state_sentence(s)]
    # "You don't owe anything" / "no balance due" / "no refund this year" are statements of the
    # opposite direction, not claims of a balance due or a refund.
    negated = re.compile(r"\b(no|not|n't|never|nothing|without|zero)\b(\W+\w+){0,3}?\W+(owe|owes|owed|owing|balance due|amount due|refund)", re.I)

    # "total tax owed" describes the liability line, not a balance due.
    liability = re.compile(r"\btax(es)? (owed|you owe|you owed)\b", re.I)

    def _asserts(pattern: str) -> str | None:
        for s in federal_sentences:
            stripped = liability.sub(" ", negated.sub(" ", s))
            if re.search(pattern, stripped, re.I):
                return s
        return None

    refund_sentence = _asserts(r"\brefund")
    # "you are owed a refund" / "owed money back" is the refund direction, not a balance due
    owe_sentence = _asserts(r"\b(owe|owes|owed|balance due|amount due)\b(?!\s+(?:a\s+|your\s+)?(?:refund|money back))")
    says_refund = refund_sentence is not None
    says_owe = owe_sentence is not None
    if says_refund and not refund_amt:
        items.append(Item("direction", "refund", "flagged", "result", reason=f"script says refund but the return shows no refund: \"{refund_sentence[:120]}\""))
    elif says_owe and not owed_amt:
        items.append(Item("direction", "balance due", "flagged", "result", reason=f"script says balance due but the return shows no amount owed: \"{owe_sentence[:120]}\""))
    elif not says_refund and not says_owe and (refund_amt or owed_amt):
        items.append(Item("direction", "-", "flagged", "result", reason="script never says whether this is a refund or a balance due"))
    else:
        items.append(Item("direction", "refund" if refund_amt else "balance due" if owed_amt else "zero", "verified", "result", page=2, label="Line 35a / Line 37"))

    # -- states ---------------------------------------------------------------
    for code, needles in state_names.items():
        name = needles[0]
        if re.search(rf"\b{re.escape(name)}\b", body, re.I) or re.search(rf"\b{code}\b", body):
            if code in facts.states:
                items.append(Item("state", code, "verified", label=f"{name} return in package"))
            elif re.search(rf"\b{re.escape(name)}\b", body, re.I):
                items.append(Item("state", code, "flagged", reason=f"script mentions {name} but no {name} return is in the package"))

    # -- deduction type -------------------------------------------------------
    says_item = re.search(r"\b(itemized deductions?|you itemized|itemizing your|your itemized)\b", body, re.I) is not None
    says_std = re.search(r"\bstandard deduction\b", body, re.I) is not None
    if says_item and not facts.itemized:
        items.append(Item("deduction_type", "itemized", "flagged", "deductions", reason="script says itemized but there is no Schedule A in the package"))
    elif says_std and facts.itemized:
        items.append(Item("deduction_type", "standard", "flagged", "deductions", reason="script says standard deduction but Schedule A is in the package"))
    else:
        items.append(Item("deduction_type", "itemized" if facts.itemized else "standard", "verified", "deductions"))

    # -- absence --------------------------------------------------------------
    if SSN_RE.search(body):
        items.append(Item("absence", "SSN", "flagged", reason="script contains a Social Security number pattern"))
    if EIN_RE.search(body):
        items.append(Item("absence", "EIN", "flagged", reason="script contains an EIN pattern"))
    if NINE_DIGITS_RE.search(body):
        items.append(Item("absence", "9-digit number", "flagged", reason="script contains a bank routing or account number pattern"))
    for acct in facts.account_numbers:
        if acct in body.replace(",", ""):
            items.append(Item("absence", "account number", "flagged", reason="script contains a bank account or routing number from the return"))
    if facts.address_line:
        street = " ".join(facts.address_line.split()[:3])
        if street and street.lower() in body.lower():
            items.append(Item("absence", "address", "flagged", reason="script contains the street address"))
    if not any(i.kind == "absence" for i in items):
        items.append(Item("absence", "PII", "verified", label="no SSN, EIN, account, or address"))

    # -- coverage -------------------------------------------------------------
    said_values = {abs(v) for tok, v in find_amount_tokens(body) if "$" in tok or "," in tok}
    for key, human in (("total_income", "total income"), ("total_tax", "total tax")):
        v = L.get(key)
        if v is None:
            items.append(Item("coverage", human, "flagged", reason=f"{human} line not found on the return"))
        elif abs(v) in said_values:
            items.append(Item("coverage", human, "verified", label=f"{human} {v:,} mentioned"))
        else:
            items.append(Item("coverage", human, "flagged", reason=f"script does not mention the {human} of {v:,}"))
    result_val = refund_amt or owed_amt
    if result_val and abs(result_val) not in said_values:
        items.append(Item("coverage", "result", "flagged", "result", reason=f"script does not state the result amount {result_val:,}"))
    else:
        items.append(Item("coverage", "result", "verified", "result"))

    passed = all(i.status == "verified" for i in items)
    return Verification(
        passed=passed,
        items=items,
        source_sha256=hashlib.sha256(Path(source_pdf).read_bytes()).hexdigest(),
        script_sha256=hashlib.sha256(script.encode("utf-8")).hexdigest(),
    )


# ---------------------------------------------------------------------------
# Pipeline step body
# ---------------------------------------------------------------------------


def verify_job(ctx: Any) -> None:
    from ..pipeline import StepFailed, load_file, replace_file

    if ctx.script is None:
        raw = load_file(ctx, "script")
        if raw is None:
            raise StepFailed("verify", "no script to verify")
        ctx.script = raw.decode("utf-8")
    if ctx.source_pdf is None:
        raise StepFailed("verify", "source PDF not loaded")
    v = verify(ctx.script, str(ctx.source_pdf), str(ctx.prior_pdf) if ctx.prior_pdf else None, ctx.cfg.profiles_dir)
    ctx.verification = v.as_dict()
    sha = replace_file(ctx, "verification", json.dumps(ctx.verification, indent=2).encode("utf-8"))
    ctx.db.update_job(ctx.job_id, verification_sha256=sha)
    flagged = [i for i in v.items if i.status == "flagged"]
    ctx.db.add_event(ctx.job_id, "processing", "verify", f"{len(v.items)} items, {len(flagged)} flagged", {"flagged": [f"{i.kind}: {i.text}" for i in flagged][:20]})
    if flagged:
        raise StepFailed("verify", "verification flagged: " + "; ".join(f"{i.kind} {i.text} ({i.reason})" for i in flagged[:5]))
