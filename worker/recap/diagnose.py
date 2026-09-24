"""Profile diagnosis for one job: which PDF row each 1040 figure came from, and the raw rows around it.

Run inside the worker container when a return fails recon and the PDF cannot leave the box:

    docker compose exec worker python -m recap.diagnose <jobId>

Prints form text (IRS line numbers, line labels), amounts, and word positions. Prints only rows
that carry an IRS line number or amounts alone, so the header rows with names and addresses never
appear; anything shaped like an SSN or EIN is masked anyway. Reads the stored source PDF, writes
nothing, and keeps the decrypted copy in a temporary file it deletes on exit.
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

import pdfplumber

from recap.config import Config
from recap.db import Db
from recap.extract.identify import identify
from recap.extract.mapper import PageInfo, _row_number, map_lines, read_pages
from recap.extract.profiles import load_profile
from recap.numbers import looks_like_amount
from recap.storage import Storage

TIN_RE = re.compile(r"\d{3}-\d{2}-\d{4}|\d{2}-\d{7}|X{3}-X{2}-\d{4}", re.I)
DEFAULT_KINDS = ("f1040_1", "f1040_2", "comparison")
ROW_MIN_X = 300.0  # show amounts right of this x, wider than any profile's value zone


def _mask(text: str) -> str:
    return TIN_RE.sub("###-##-####", text)


def _rows(page: PageInfo, geometry: dict, comparison_labels: list[str]) -> list[str]:
    position = geometry.get("number_position", "auto")
    out: list[str] = []
    for ln in page.lines:
        number, label_words, amounts = _row_number(ln, position, ROW_MIN_X)
        label = " ".join(w.text for w in label_words)
        # Amounts, including the line number UltraTax repeats beside the amount column, with x.
        vals = [w for w in ln.words if w.x0 >= ROW_MIN_X and (looks_like_amount(w.text) or w in amounts)]
        amount_only = bool(amounts) and all(w.x1 < 75 for w in label_words)
        on_comparison = page.kind == "comparison" and amounts and any(re.search(p, label, re.I) for p in comparison_labels)
        year_header = page.kind == "comparison" and len(ln.words) <= 4 and all(re.fullmatch(r"20\d\d|Differences?|Diff\.?", w.text, re.I) for w in ln.words)
        if not (number or amount_only or on_comparison or year_header):
            continue
        shown = " ".join(f"{w.text}@{w.x0:.0f}" for w in vals)
        text = f"{number or '':>4} {label[:62]:<62}" if not year_header else f"{'':>4} {ln.text[:62]:<62}"
        out.append(_mask(f"  y={ln.top:7.1f} | {text} | {shown}"))
    return out


def diagnose_job(job_id: str, kinds: tuple[str, ...], all_copies: bool) -> int:
    cfg = Config.from_env()
    rows = Db(cfg.database_url).list_files(job_id, "source")
    if not rows:
        print(f"job {job_id}: no source PDF (purged, or wrong id)", file=sys.stderr)
        return 1
    data = Storage(cfg.data_dir, cfg.master_key_passphrase).get(rows[0]["path"], rows[0]["key_path"])
    with tempfile.TemporaryDirectory(prefix="recap-diag-") as tmp:
        pdf_path = Path(tmp) / "source.pdf"
        pdf_path.write_bytes(data)
        return diagnose_pdf(str(pdf_path), cfg.profiles_dir, kinds, all_copies)


def diagnose_pdf(pdf_path: str, profiles_dir: str, kinds: tuple[str, ...], all_copies: bool) -> int:
    ident = identify(pdf_path, profiles_dir)
    profile = load_profile(profiles_dir, "1040", ident.tax_year, ident.software)
    with pdfplumber.open(pdf_path) as pdf:
        pages = read_pages(pdf, profile)
    geometry = profile.get("geometry", {})
    print(f"software={ident.software} year={ident.tax_year} pages={len(pages)} profile={profile.get('_file')} geometry={geometry}")
    by_kind: dict[str, list[int]] = {}
    for p in pages:
        if p.kind:
            by_kind.setdefault(p.kind, []).append(p.number)
    print("page kinds: " + ", ".join(f"{k}={v}" for k, v in by_kind.items()))

    print("\n== Figures as mapped (path, IRS line, page, y, label -> value)")
    mapped = map_lines(pages, profile)
    for spec in profile.get("lines", []):
        key = f"{spec['path']}@{spec.get('line', '')}"
        f = mapped.evidence.get(key)
        line = spec.get("line")
        line = "/".join(line) if isinstance(line, list) else str(line)
        if f:
            print(_mask(f"  {spec['path']:<34} {line:<8} p{f.page:<3} y={f.y:7.1f} {f.label[:50]!r} -> {f.value}"))
        else:
            print(f"  {spec['path']:<34} {line:<8} NOT FOUND (0)")

    comparison_labels = [r["label"] for r in profile.get("comparison", {}).get("rows", [])]
    for kind in kinds:
        numbers = by_kind.get(kind, [])
        for n in numbers if all_copies else numbers[:1]:
            page = pages[n - 1]
            print(f"\n== Page {n} ({kind}): rows with an IRS line number or amounts; amounts as text@x")
            for r in _rows(page, geometry, comparison_labels):
                print(r)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("job_id", nargs="?")
    ap.add_argument("--pdf", help="diagnose a local PDF instead of a job's stored source")
    ap.add_argument("--kinds", default=",".join(DEFAULT_KINDS), help="page kinds to dump (default: %(default)s)")
    ap.add_argument("--all-copies", action="store_true", help="dump every page of each kind, not just the first")
    a = ap.parse_args(argv)
    kinds = tuple(k for k in a.kinds.split(",") if k)
    if a.pdf:
        return diagnose_pdf(a.pdf, Config.from_env().profiles_dir, kinds, a.all_copies)
    if not a.job_id:
        ap.error("a job id or --pdf is required")
    return diagnose_job(a.job_id, kinds, a.all_copies)


if __name__ == "__main__":
    sys.exit(main())
