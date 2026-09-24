"""Real client returns, when present on this machine (tests/fixtures/real/, gitignored).

Skipped in CI. On a box that has them, every PDF must identify, extract, reconcile, and be read
by the verifier with the same year, filing status, and states; and every extracted figure must
agree with the return's own two-year comparison reports, read with a parser of their own (Q67). Nothing from a return is printed:
assertion messages carry file index, page counts, and check names only.
"""

from __future__ import annotations

import re
from pathlib import Path

import pdfplumber
import pytest

from recap.extract.identify import identify
from recap.extract.run import extract_return
from recap.verify.pdftext import read_pdf
from recap.verify.verify import read_return

ROOT = Path(__file__).resolve().parents[2]
REAL = ROOT / "tests" / "fixtures" / "real"
PROFILES = ROOT / "form-profiles"
PDFS = sorted(REAL.glob("*.pdf")) if REAL.exists() else []

pytestmark = pytest.mark.skipif(not PDFS, reason="no real returns under tests/fixtures/real/")


@pytest.mark.parametrize("idx", range(len(PDFS)), ids=[f"return-{i}" for i in range(len(PDFS))])
def test_real_return_extracts_and_reconciles(idx):
    pdf = PDFS[idx]
    ident = identify(str(pdf), str(PROFILES))
    assert ident.software != "unknown", f"return-{idx}: software not identified"
    assert ident.form == "1040" and ident.tax_year, f"return-{idx}: form/year not identified"
    assert ident.form_page and ident.form_page > 1 or ident.page_count < 5, f"return-{idx}: form page not located"
    assert ident.first_name and ident.last_name, f"return-{idx}: names not found"
    assert ident.first_name == ident.first_name.title() or not ident.first_name.isupper(), f"return-{idx}: name left in capitals"

    ex = extract_return(str(pdf), str(PROFILES), ident)
    failed = [c["name"] for c in ex["recon"]["checks"] if not c["ok"]]
    assert ex["recon"]["passed"], f"return-{idx}: recon failed {failed}"
    assert ex["income"]["total_income"] > 0 and ex["adjustments"]["agi"] > 0, f"return-{idx}: empty income"
    assert ex["deductions"]["amount"] > 0 and ex["deductions"]["taxable_income"] >= 0, f"return-{idx}: deductions"
    assert (ex["result"]["refund"] > 0) != (ex["result"]["amount_owed"] > 0) or (ex["result"]["refund"] == 0 == ex["result"]["amount_owed"]), f"return-{idx}: direction"
    assert "extras" in ex, f"return-{idx}: extras missing"
    for st in ex["state"]:
        assert st["tax"] > 0 and st["payments"] > 0, f"return-{idx}: state {st['code']} figures missing"

    facts = read_return(read_pdf(str(pdf)), None, str(PROFILES))
    assert facts.tax_year == ident.tax_year, f"return-{idx}: verifier year differs"
    assert facts.filing_status == ex["meta"]["filing_status"], f"return-{idx}: verifier filing status differs"
    # The extraction lists the resident state first (Q67); the verifier reads page order.
    assert sorted(facts.states) == sorted(ex["meta"]["state_returns"]), f"return-{idx}: verifier states differ"
    assert facts.first_name and facts.first_name.casefold() == ident.first_name.casefold(), f"return-{idx}: verifier first name differs"
    for key in ("total_income", "agi", "taxable_income", "total_tax", "withholding"):
        assert key in facts.lines, f"return-{idx}: verifier missing {key}"
    assert facts.lines["agi"] == ex["adjustments"]["agi"], f"return-{idx}: verifier AGI differs from extraction"
    assert facts.lines["total_tax"] == ex["tax"]["total_tax"], f"return-{idx}: verifier total tax differs"
    if ex["prior_year"]["present"]:
        assert facts.prior.get("agi") == ex["prior_year"]["agi"], f"return-{idx}: verifier prior AGI differs"


# -- cross-check against the comparison reports (Q67) --------------------------------------

AMOUNT_RE = re.compile(r"^-?\(?\$?\d{1,3}(,\d{3})*(\.\d+)?\)?-?$|^-?\d+(\.\d+)?$")

# Comparison-report row (label regex, matched in full after the row number) -> extraction path. Several
# rows summing into one path are listed under the same path.
ROWS: dict[str, list[str]] = {
    "income.wages": [r"Salaries and wages"],
    "income.interest": [r"Interest income"],
    "income.dividends": [r"Dividend income"],
    "income.ira_pensions": [r"Taxable IRA distributions", r"Taxable pensions"],
    "income.social_security_taxable": [r"Taxable social security"],
    "income.capital_gain": [r"Capital gain/loss"],
    "income.total_income": [r"Total income"],
    "adjustments.agi": [r"Adjusted gross income"],
    "deductions.amount": [r"Deduction taken"],
    "deductions.additional": [r"Additional deductions \(Sch 1-A\)"],
    "deductions.qbi": [r"Qualified business income deduction"],
    "deductions.taxable_income": [r"Taxable income"],
    "tax.tax": [r"Tax on taxable income"],
    "tax.nonrefundable_credits": [r"Total credits"],
    "tax.total_tax": [r"Total tax"],
    "payments.withholding": [r"Income tax withheld"],
    "payments.estimates": [r"Estimated tax payments"],
    "payments.refundable_credits": [r"Earned income credit", r"Additional Child tax credit", r"Other refundable tax credits", r"Other payments"],
    "payments.total_payments": [r"Total payments"],
    "result.applied_to_next_year": [r"Refund applied to estimated tax payments"],
    "result.refund": [r"Refund received"],
    "extras.estimated_tax_penalty": [r"Penalties and interest"],
}


def _amount(text: str) -> int | None:
    t = text.replace("$", "").replace(",", "")
    neg = t.startswith("-") or t.startswith("(") or t.endswith("-")
    t = t.strip("-()")
    try:
        v = round(float(t))
    except ValueError:
        return None
    return -v if neg else v


def _lines(page) -> list[tuple[float, list[dict]]]:
    words = page.extract_words(use_text_flow=True, keep_blank_chars=False)
    out: list[tuple[float, list[dict]]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if out and abs(out[-1][0] - w["top"]) <= 2:
            out[-1][1].append(w)
        else:
            out.append((w["top"], [w]))
    return [(top, sorted(ws, key=lambda w: w["x0"])) for top, ws in out]


STATE_TITLES = {"MO": "Missouri Two Year Comparison", "AR": "Arkansas Nonresident Two Year Comparison"}


def comparison_current(pdf_path: Path, year: int, title: str = "1040 Two Year Comparison") -> dict[str, int] | None:
    """Label -> current-year value from a two-year comparison report (its first run of pages)."""
    rows: dict[str, int] = {}
    with pdfplumber.open(str(pdf_path)) as pdf:
        started = False
        for page in pdf.pages:
            text = page.extract_text() or ""
            if title not in text[:400]:
                if started:
                    break
                continue
            lines = _lines(page)
            header = next(
                (ws for _t, ws in lines if len(ws) <= 4 and {w["text"] for w in ws} >= {str(year - 1), str(year)}), None
            )
            if header is None:
                continue
            started = True
            cols = {w["text"]: (w["x0"] + w["x1"]) / 2 for w in header}
            diff_x = next(((w["x0"] + w["x1"]) / 2 for w in header if w["text"].startswith("Diff")), cols[str(year)] + 94)
            centers = {"prior": cols[str(year - 1)], "current": cols[str(year)], "diff": diff_x}
            for i, (top, ws) in enumerate(lines):
                # A section name printed vertically ("Income", a letter per row) sits left of x~40.
                ws = [w for w in ws if w["x0"] >= 40]
                if not ws:
                    continue
                m = re.match(r"^\d{1,2}\.?$", ws[0]["text"])
                if not m or len(ws) < 3:
                    continue
                label_words = [w["text"] for w in ws[1:] if not AMOUNT_RE.match(w["text"]) or w["x0"] < 300]
                label = re.sub(r"\s+\d{1,2}\.$", "", " ".join(label_words)).strip()
                amounts = [w for w in ws if w["x0"] >= 300 and AMOUNT_RE.match(w["text"])]
                if not amounts:
                    # UltraTax prints the values as their own row a few points above the label.
                    above = [(t, a) for t, a in lines[:i] if 0 < top - t <= 6]
                    if above:
                        amounts = [w for w in above[-1][1] if w["x0"] >= 300 and AMOUNT_RE.match(w["text"])]
                value = 0
                for w in amounts:
                    xc = (w["x0"] + w["x1"]) / 2
                    if min(centers, key=lambda k: abs(centers[k] - xc)) == "current":
                        value = _amount(w["text"]) or 0
                rows.setdefault(label, value)
    return rows or None


@pytest.mark.skipif(not PDFS, reason="no real returns in tests/fixtures/real")
@pytest.mark.parametrize("pdf_path", PDFS, ids=[f"return-{chr(65 + i)}" for i in range(len(PDFS))])
def test_extraction_agrees_with_comparison_report(pdf_path: Path):
    doc = extract_return(str(pdf_path), str(PROFILES))
    assert doc["recon"]["passed"], "recon failed: " + ", ".join(c["name"] for c in doc["recon"]["checks"] if not c["ok"])
    comp = comparison_current(pdf_path, doc["meta"]["tax_year"])
    if comp is None:
        pytest.skip("no two-year comparison report in this package")
    wrong: list[str] = []
    unchecked: list[str] = []
    for path, patterns in ROWS.items():
        found = [v for label, v in comp.items() if any(re.fullmatch(p, label, re.I) for p in patterns)]
        if not found:
            unchecked.append(path)
            continue
        section, key = path.split(".")
        got = int((doc.get(section) or {}).get(key) or 0)
        want = sum(found)
        if path == "result.refund":
            want = abs(want)  # the report prints refunds negative; the extraction keeps magnitudes
        if got != want:
            wrong.append(path)
    assert not wrong, f"extraction disagrees with the comparison report on: {', '.join(wrong)}"
    assert not unchecked, f"comparison report rows not found for: {', '.join(unchecked)}"


@pytest.mark.skipif(not PDFS, reason="no real returns in tests/fixtures/real")
@pytest.mark.parametrize("pdf_path", PDFS, ids=[f"return-{chr(65 + i)}" for i in range(len(PDFS))])
def test_state_results_agree_with_state_comparison_reports(pdf_path: Path):
    """Each state's refund or balance due is the one its own comparison report states.

    The report prints "Tax due/-refund" and, after penalties, "Net tax due/-refund". Missouri
    prints the refund on MO-1040 line 53 before the estimated tax penalty (the report's net figure
    subtracts it), and Arkansas and Missouri fold the penalty into the amount due, so a refund
    must match one of the two rows and a balance due must match the net row.
    """
    doc = extract_return(str(pdf_path), str(PROFILES))
    year = doc["meta"]["tax_year"]
    wrong: list[str] = []
    for st in doc["state"]:
        title = STATE_TITLES.get(st["code"])
        comp = comparison_current(pdf_path, year, title) if title else None
        if not comp:
            continue
        net = next((v for label, v in comp.items() if re.fullmatch(r"Net tax due/-refund", label, re.I)), None)
        due = next((v for label, v in comp.items() if re.fullmatch(r"Tax due/-refund", label, re.I)), None)
        if st["amount_owed"]:
            ok = net == st["amount_owed"]
        else:
            ok = -st["refund"] in (net, due)
        if not ok:
            wrong.append(st["code"])
    assert not wrong, f"state result disagrees with its comparison report: {', '.join(wrong)}"


@pytest.mark.skipif(not PDFS, reason="no real returns in tests/fixtures/real")
def test_nonresident_state_never_leads():
    for pdf_path in PDFS:
        doc = extract_return(str(pdf_path), str(PROFILES))
        codes = [s["code"] for s in doc["state"]]
        if "AR" in codes and "MO" in codes:
            assert codes[0] == "MO", "the AR1000NR return must not be narrated as the resident state"
