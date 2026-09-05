"""Top-level extraction: identify -> profile -> map -> prior -> observations -> recon."""

from __future__ import annotations

from typing import Any

import pdfplumber

from .identify import Identification, identify
from .mapper import ExtractionError, extract_document
from .observations import compute_observations
from .prior import EMPTY, from_comparison_page, from_extraction
from .profiles import load_profile
from .recon import reconcile


def _effective_rate(doc: dict[str, Any]) -> float:
    ti = int(doc["deductions"].get("taxable_income", 0))
    return round(int(doc["tax"].get("total_tax", 0)) / ti, 4) if ti else 0.0


def extract_return(
    pdf_path: str,
    profiles_dir: str,
    ident: Identification | None = None,
    prior_pdf_path: str | None = None,
    recon_exceptions: set[str] | None = None,
) -> dict[str, Any]:
    ident = ident or identify(pdf_path, profiles_dir)
    form = ident.form or "1040"
    if form not in ("1040", "1040-SR"):
        raise ExtractionError(f"unsupported form {form}; v1 handles Form 1040 packages only")
    profile = load_profile(profiles_dir, "1040", ident.tax_year, ident.software)
    with pdfplumber.open(pdf_path) as pdf:
        doc, pages, _mapped = extract_document(pdf, profile, profiles_dir)
    doc["meta"] = {
        "software": ident.software,
        "tax_year": ident.tax_year,
        "form": "1040",
        "filing_status": doc["meta"]["filing_status"],
        "state_returns": doc["meta"]["state_returns"],
        "profile": profile.get("_file"),
    }
    doc["tax"]["effective_rate"] = _effective_rate(doc)

    prior = dict(EMPTY)
    if prior_pdf_path:
        prior_ident = identify(prior_pdf_path, profiles_dir)
        prior_profile = load_profile(profiles_dir, "1040", prior_ident.tax_year, prior_ident.software)
        with pdfplumber.open(prior_pdf_path) as ppdf:
            prior_doc, _p, _m = extract_document(ppdf, prior_profile, profiles_dir)
        prior = from_extraction(prior_doc)
        prior["source"] = "prior_pdf"
    elif ident.tax_year:
        prior = from_comparison_page(pages, profile, ident.tax_year)
        if prior["present"]:
            prior["source"] = "comparison_page"
    doc["prior_year"] = prior
    doc["observations"] = compute_observations(doc)
    doc["recon"] = reconcile(doc, recon_exceptions)
    doc.pop("_extras", None)
    return doc
