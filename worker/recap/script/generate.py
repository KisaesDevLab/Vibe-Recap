"""Script generation: facts -> prompt -> Ollama -> validator, up to three attempts.

The model only ever sees pre-formatted facts. It cannot invent a number that passes, because
the validator rejects any figure absent from extraction.json, and every rejection is fed back
into the next attempt verbatim.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from ..validate import format_errors_for_model, validate_script
from .ollama import Ollama, OllamaError

MAX_ATTEMPTS = 3
FILING_STATUS_TEXT = {
    "S": "single",
    "MFJ": "married filing jointly",
    "MFS": "married filing separately",
    "HOH": "head of household",
    "QSS": "qualifying surviving spouse",
}
OBS_TEXT = {
    "yoy_agi": "Adjusted gross income changed by {delta} ({pct}) compared with last year",
    "yoy_total_tax": "Total tax changed by {delta} ({pct}) compared with last year",
    "yoy_result": "The bottom-line result moved by {delta} compared with last year",
    "withholding_ratio": "Withholding covered {pct} of the total tax (difference {delta})",
    "std_itemized_proximity": "Itemized deductions came within {delta} of the standard deduction",
    "underpayment_penalty": "The return includes an estimated tax underpayment penalty of {delta}",
}

_env = Environment(loader=FileSystemLoader(str(Path(__file__).parent)), undefined=StrictUndefined, autoescape=False, trim_blocks=False, lstrip_blocks=False)


def money(n: int) -> str:
    return f"-${abs(int(n)):,}" if int(n) < 0 else f"${int(n):,}"


def pct(p: float) -> str:
    return f"{abs(p) * 100:.1f}%"


def build_facts(ex: dict[str, Any]) -> list[str]:
    inc, adj, ded, tax, pay, res = (ex.get(k, {}) for k in ("income", "adjustments", "deductions", "tax", "payments", "result"))
    facts: list[str] = []

    def add(label: str, value: int | None, *, zero_ok: bool = False) -> None:
        if value is None:
            return
        if int(value) == 0 and not zero_ok:
            return
        facts.append(f"{label}: {money(int(value))}")

    add("Wages", inc.get("wages"))
    add("Taxable interest", inc.get("interest"))
    add("Dividends", inc.get("dividends"))
    add("IRA distributions and pensions (taxable)", inc.get("ira_pensions"))
    add("Taxable social security", inc.get("social_security_taxable"))
    add("Capital gain or loss", inc.get("capital_gain"))
    add("Other income from Schedule 1", inc.get("schedule_1_total"))
    add("Total income", inc.get("total_income"), zero_ok=True)
    add("Adjustments to income", adj.get("schedule_1_adjustments"))
    add("Adjusted gross income", adj.get("agi"), zero_ok=True)
    add(f"{ded.get('type', 'standard').capitalize()} deduction", ded.get("amount"), zero_ok=True)
    add("Qualified business income deduction", ded.get("qbi"))
    add("Taxable income", ded.get("taxable_income"), zero_ok=True)
    add("Income tax before credits", tax.get("tax"))
    add("Nonrefundable credits", tax.get("nonrefundable_credits"))
    add("Other taxes (including self-employment tax)", tax.get("other_taxes"))
    add("Total tax", tax.get("total_tax"), zero_ok=True)
    rate = tax.get("effective_rate")
    if isinstance(rate, (int, float)) and rate:
        facts.append(f"Effective tax rate on taxable income: {rate * 100:.1f}%")
    add("Federal withholding", pay.get("withholding"))
    add("Estimated tax payments", pay.get("estimates"))
    add("Refundable credits", pay.get("refundable_credits"))
    add("Total payments", pay.get("total_payments"), zero_ok=True)
    if int(res.get("refund", 0)) > 0:
        add("REFUND", res.get("refund"))
    if int(res.get("applied_to_next_year", 0)) > 0:
        add("Applied to next year's estimated tax", res.get("applied_to_next_year"))
    if int(res.get("amount_owed", 0)) > 0:
        add("BALANCE DUE (amount you owe)", res.get("amount_owed"))
    if int(res.get("refund", 0)) == 0 and int(res.get("amount_owed", 0)) == 0:
        facts.append("RESULT: no refund and no balance due; the return balances to zero")
    for st in ex.get("state", []):
        code = st.get("code", "")
        if int(st.get("tax", 0)):
            facts.append(f"{code} state tax: {money(st['tax'])}")
        if int(st.get("refund", 0)) > 0:
            facts.append(f"{code} state REFUND: {money(st['refund'])}")
        if int(st.get("amount_owed", 0)) > 0:
            facts.append(f"{code} state BALANCE DUE: {money(st['amount_owed'])}")
    return facts


def build_observation_facts(ex: dict[str, Any]) -> list[str]:
    out = []
    py = ex.get("prior_year") or {}
    for obs in ex.get("observations", []):
        tmpl = OBS_TEXT.get(obs.get("id"))
        if not tmpl:
            continue
        d = int(obs.get("delta", 0))
        text = tmpl.format(delta=money(d).replace("-$", "$") if obs["id"] != "yoy_result" else money(d).replace("-$", "$"), pct=pct(float(obs.get("pct", 0))))
        direction = "an increase" if d > 0 else "a decrease" if d < 0 else "no change"
        if obs["id"].startswith("yoy"):
            text += f" ({direction})"
        out.append(text)
    if py.get("present"):
        out.append(f"Last year's adjusted gross income: {money(int(py.get('agi', 0)))}; last year's total tax: {money(int(py.get('total_tax', 0)))}")
    return out


def state_facts(ex: dict[str, Any]) -> list[str]:
    codes = [s.get("code", "") for s in ex.get("state", [])]
    if not codes:
        return []
    return [f"{codes[0]} (resident state, describe in a sentence or two)"] + [f"{c} (mention the result only)" for c in codes[1:]]


def greeting_names(ex: dict[str, Any], settings: dict[str, Any]) -> str | None:
    if settings.get("greeting_use_first_names", True) is False:
        return None
    tp = ex.get("taxpayer", {})
    first = tp.get("first_name")
    if not first:
        return None
    spouse = tp.get("spouse_first_name")
    return f"{first} and {spouse}" if spouse else first


def render_prompt(section: str, ex: dict[str, Any], settings: dict[str, Any], note: str | None) -> str:
    tmpl = _env.get_template("prompt.jinja")
    return tmpl.render(
        section=section,
        firm_name=settings.get("firm_name") or "",
        greeting_names=greeting_names(ex, settings),
        meta=ex.get("meta", {}),
        filing_status_text=FILING_STATUS_TEXT.get(ex.get("meta", {}).get("filing_status"), "unknown"),
        deductions=ex.get("deductions", {}),
        state_facts=state_facts(ex),
        facts=build_facts(ex),
        observation_facts=build_observation_facts(ex),
        preparer_note=(note or "").strip() or None,
        signoff_sentence=settings.get("signoff_sentence") or "We look forward to reviewing this with you.",
        target_words=int(settings.get("target_words") or 350),
    ).strip()


def generate(ex: dict[str, Any], settings: dict[str, Any], note: str | None, client: Ollama, log: Any = None) -> tuple[str, list[dict[str, Any]]]:
    """Returns (script, attempts). Raises OllamaError or ValueError after MAX_ATTEMPTS failures."""
    messages = [
        {"role": "system", "content": render_prompt("system", ex, settings, note)},
        {"role": "user", "content": render_prompt("user", ex, settings, note)},
    ]
    attempts: list[dict[str, Any]] = []
    last_errors: list[str] = []
    for n in range(1, MAX_ATTEMPTS + 1):
        result = client.chat(messages)
        script = result.content.strip()
        v = validate_script(script, ex)
        attempts.append({"attempt": n, "ok": v.ok, "errors": v.errors[:10], "words": v.word_count, "ms": result.total_ms})
        if log:
            log.info("script attempt", extra={"attempt": n, "ok": v.ok, "words": v.word_count, "error_count": len(v.errors)})
        if v.ok:
            return script, attempts
        last_errors = v.errors
        messages.append({"role": "assistant", "content": script})
        messages.append({"role": "user", "content": format_errors_for_model(v)})
    err = ValueError("validator rejected the script after 3 attempts: " + "; ".join(last_errors[:5]))
    err.attempts = attempts  # type: ignore[attr-defined]
    raise err


# ---------------------------------------------------------------------------
# Pipeline step bodies
# ---------------------------------------------------------------------------


def _client_for(ctx: Any) -> Ollama:
    s = ctx.settings or {}
    return Ollama(
        (s.get("ollama_url") or ctx.cfg.ollama_url),
        (s.get("model_name") or ctx.cfg.ollama_model),
        temperature=float(s.get("temperature", 0.3) or 0.3),
        timeout_s=float(s.get("ollama_timeout_s") or ctx.cfg.ollama_timeout_s),
    )


def generate_script(ctx: Any) -> None:
    from ..pipeline import StepFailed, replace_file

    if ctx.extraction is None:
        raise StepFailed("script", "extraction missing")
    client = _client_for(ctx)
    try:
        script, attempts = generate(ctx.extraction, ctx.settings, ctx.job.get("note"), client, ctx.log)
    except OllamaError as exc:
        raise StepFailed("script", str(exc)) from exc
    except ValueError as exc:
        attempts = getattr(exc, "attempts", None)
        if attempts:
            ctx.db.add_event(ctx.job_id, "processing", "script", "all attempts rejected by the validator", {"attempts": attempts})
        raise StepFailed("script", str(exc)) from exc
    ctx.script = script
    sha = replace_file(ctx, "script", script.encode("utf-8"))
    ctx.db.update_job(ctx.job_id, script_sha256=sha)
    ctx.db.add_event(ctx.job_id, "processing", "script", f"script generated in {len(attempts)} attempt(s)", {"attempts": attempts, "extraction_sha256": ctx.extraction_sha256})


def validate_current_script(ctx: Any) -> None:
    from ..pipeline import StepFailed, load_file

    if ctx.script is None:
        raw = load_file(ctx, "script")
        if raw is None:
            raise StepFailed("validate", "no script to validate; generate one first")
        ctx.script = raw.decode("utf-8")
    if ctx.extraction is None:
        raise StepFailed("validate", "extraction missing")
    v = validate_script(ctx.script, ctx.extraction)
    if not v.ok:
        raise StepFailed("validate", "script failed validation: " + "; ".join(v.errors[:6]))
    ctx.db.update_job(ctx.job_id, script_sha256=hashlib.sha256(ctx.script.encode("utf-8")).hexdigest())
