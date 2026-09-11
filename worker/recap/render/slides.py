"""Slides: Jinja2/HTML rendered to 1920x1080 PNG with Playwright (Chromium).

Every number on a slide comes from extraction.json, never from the script text. Charts are
inline SVG built here. Chromium runs with --no-sandbox and needs shm_size: 1g in compose.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

SLIDES = ["greeting", "income", "deductions", "tax", "result", "observations", "next"]
WIDTH, HEIGHT = 1920, 1080

_env = Environment(loader=FileSystemLoader(str(Path(__file__).parent / "templates")), autoescape=select_autoescape(["html"]))


def money(n: Any) -> str:
    try:
        v = int(n)
    except (TypeError, ValueError):
        return ""
    return f"-${abs(v):,}" if v < 0 else f"${v:,}"


def pct(p: Any) -> str:
    try:
        return f"{abs(float(p)) * 100:.1f}%"
    except (TypeError, ValueError):
        return ""


_env.filters["money"] = money
_env.filters["pct"] = pct

FILING_STATUS_TEXT = {
    "S": "Single",
    "MFJ": "Married filing jointly",
    "MFS": "Married filing separately",
    "HOH": "Head of household",
    "QSS": "Qualifying surviving spouse",
}
OBS_LABEL = {
    "yoy_agi": "Adjusted gross income vs. last year",
    "yoy_total_tax": "Total tax vs. last year",
    "yoy_result": "Bottom line vs. last year",
    "withholding_ratio": "Withholding as a share of total tax",
    "std_itemized_proximity": "Itemized vs. standard deduction gap",
    "underpayment_penalty": "Estimated tax underpayment penalty",
}


def income_bars(ex: dict[str, Any]) -> list[dict[str, Any]]:
    inc = ex.get("income", {})
    rows = [
        ("Wages", inc.get("wages", 0)),
        ("Interest", inc.get("interest", 0)),
        ("Dividends", inc.get("dividends", 0)),
        ("IRA & pensions", inc.get("ira_pensions", 0)),
        ("Social security", inc.get("social_security_taxable", 0)),
        ("Capital gain", inc.get("capital_gain", 0)),
        ("Other (Sch. 1)", inc.get("schedule_1_total", 0)),
    ]
    rows = [(k, int(v or 0)) for k, v in rows if int(v or 0) != 0]
    top = max((abs(v) for _k, v in rows), default=1) or 1
    return [{"label": k, "value": v, "text": money(v), "width": round(abs(v) / top * 100, 1), "negative": v < 0} for k, v in rows]


def build_context(ex: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    meta, tp, res, tax, pay, ded, adj = (ex.get(k, {}) for k in ("meta", "taxpayer", "result", "tax", "payments", "deductions", "adjustments"))
    names = None
    if settings.get("greeting_use_first_names", True) is not False and tp.get("first_name"):
        names = tp["first_name"] + (f" & {tp['spouse_first_name']}" if tp.get("spouse_first_name") else "")
    refund = int(res.get("refund", 0) or 0)
    owed = int(res.get("amount_owed", 0) or 0)
    total_tax = int(tax.get("total_tax", 0) or 0)
    total_pay = int(pay.get("total_payments", 0) or 0)
    top = max(total_tax, total_pay, 1)
    return {
        "firm_name": settings.get("firm_name") or "",
        "firm_logo": settings.get("firm_logo") or None,
        "primary": settings.get("color_primary") or "#1f3a5f",
        "secondary": settings.get("color_secondary") or "#e8b04b",
        "signoff": settings.get("signoff_sentence") or "Please contact us with any questions.",
        "tax_year": meta.get("tax_year"),
        "filing_status": FILING_STATUS_TEXT.get(meta.get("filing_status"), ""),
        "names": names,
        "states": meta.get("state_returns", []),
        "ex": ex,
        "income_bars": income_bars(ex),
        "deduction_type": (ded.get("type") or "standard").capitalize(),
        "result_kind": "refund" if refund > 0 else "owed" if owed > 0 else "zero",
        "result_amount": refund if refund > 0 else owed,
        "tax_bar": round(total_tax / top * 100, 1),
        "pay_bar": round(total_pay / top * 100, 1),
        "observations": [
            {"label": OBS_LABEL.get(o.get("id"), o.get("id")), "delta": o.get("delta", 0), "pct": o.get("pct", 0), "id": o.get("id")}
            for o in ex.get("observations", [])
        ],
        "state_rows": ex.get("state", []),
        "effective_rate": tax.get("effective_rate", 0),
        "agi": adj.get("agi", 0),
    }


def render_html(slide: str, ex: dict[str, Any], settings: dict[str, Any]) -> str:
    ctx = build_context(ex, settings)
    ctx["slide"] = slide
    ctx["slide_index"] = SLIDES.index(slide) + 1
    ctx["slide_count"] = len(SLIDES)
    return _env.get_template("slides.html").render(**ctx)


def render_pngs(htmls: list[str], out_dir: Path) -> list[Path]:
    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
        try:
            page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
            for i, html in enumerate(htmls):
                page.set_content(html, wait_until="load")
                path = out_dir / f"slide-{i:02d}.png"
                page.screenshot(path=str(path), type="png", full_page=False)
                paths.append(path)
        finally:
            browser.close()
    return paths


# ---------------------------------------------------------------------------
# Pipeline step body
# ---------------------------------------------------------------------------


def render_slides(ctx: Any) -> None:
    from ..pipeline import StepFailed, replace_files

    if ctx.extraction is None:
        raise StepFailed("slides", "extraction missing")
    htmls = [render_html(s, ctx.extraction, ctx.settings or {}) for s in SLIDES]
    try:
        paths = render_pngs(htmls, ctx.workdir / "slides")
    except Exception as exc:  # noqa: BLE001
        raise StepFailed("slides", f"slide rendering failed ({type(exc).__name__}: {exc})") from exc
    ctx.slides = paths
    replace_files(ctx, "slide", [p.read_bytes() for p in paths])
    ctx.db.add_event(ctx.job_id, "processing", "slides", f"{len(paths)} slides rendered")
