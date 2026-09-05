"""Pipeline orchestration.

    ingest -> identify -> extract -> [ocr] -> recon -> script -> validate -> verify -> tts -> slides -> mux -> ready

`jobs.resume_from` selects the first step to run (retry, re-extract, regenerate, re-render).
Every step reads and writes encrypted artifacts through Storage; nothing plaintext is left on
disk after the job finishes. A job whose row is already `processing` when we pick it up was
interrupted by a worker restart; it is marked failed at that step so the rest of the queue keeps
flowing and the preparer can retry it deliberately.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .config import Config
from .db import Db
from .extract.identify import Identification, identify
from .extract.mapper import ExtractionError
from .extract.recon import failures
from .extract.run import extract_return
from .logging import get_logger
from .storage import Storage

STEPS = ["ingest", "identify", "extract", "ocr", "recon", "script", "validate", "verify", "tts", "slides", "mux", "ready"]
MAX_PAGES = 200
OCR_COVERAGE_THRESHOLD = 0.8  # below this share of pages with text, run OCR (i.e. >20% without text)


class StepFailed(Exception):
    def __init__(self, step: str, message: str):
        super().__init__(message)
        self.step = step
        self.message = message


@dataclass
class Ctx:
    cfg: Config
    storage: Storage
    db: Db
    job: dict[str, Any]
    workdir: Path
    log: Any
    settings: dict[str, Any] = field(default_factory=dict)
    source_pdf: Path | None = None
    prior_pdf: Path | None = None
    ident: Identification | None = None
    extraction: dict[str, Any] | None = None
    extraction_sha256: str | None = None
    script: str | None = None
    verification: dict[str, Any] | None = None
    audio: list[dict[str, Any]] = field(default_factory=list)
    slides: list[Path] = field(default_factory=list)
    started: float = field(default_factory=time.time)

    @property
    def job_id(self) -> str:
        return str(self.job["id"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------------------
# Artifact helpers
# ---------------------------------------------------------------------------


def load_file(ctx: Ctx, kind: str) -> bytes | None:
    rows = ctx.db.list_files(ctx.job_id, kind)
    if not rows:
        return None
    r = rows[0]
    return ctx.storage.get(r["path"], r["key_path"])


def replace_file(ctx: Ctx, kind: str, data: bytes, seq: int = 0) -> str:
    """Store `data` as the job's `kind` artifact, shredding any previous one of that kind+seq."""
    for old in ctx.db.list_files(ctx.job_id, kind):
        if int(old.get("seq") or 0) == seq:
            ctx.storage.shred(old["path"], old["key_path"])
    with ctx.db.conn() as c:
        c.execute("delete from files where job_id = %s and kind = %s and seq = %s", (ctx.job_id, kind, seq))
    blob = ctx.storage.put(ctx.job_id, data)
    ctx.db.add_file(ctx.job_id, kind, blob.path, blob.key_path, blob.sha256, blob.size, seq=seq, file_id=blob.id)
    return blob.sha256


def replace_files(ctx: Ctx, kind: str, items: list[bytes]) -> list[str]:
    for old in ctx.db.list_files(ctx.job_id, kind):
        ctx.storage.shred(old["path"], old["key_path"])
    with ctx.db.conn() as c:
        c.execute("delete from files where job_id = %s and kind = %s", (ctx.job_id, kind))
    out = []
    for i, data in enumerate(items):
        blob = ctx.storage.put(ctx.job_id, data)
        ctx.db.add_file(ctx.job_id, kind, blob.path, blob.key_path, blob.sha256, blob.size, seq=i, file_id=blob.id)
        out.append(blob.sha256)
    return out


def store_extraction(ctx: Ctx) -> None:
    data = json.dumps(ctx.extraction, indent=2, sort_keys=False).encode("utf-8")
    ctx.extraction_sha256 = replace_file(ctx, "extraction", data)
    ctx.db.update_job(ctx.job_id, extraction_sha256=ctx.extraction_sha256)


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------


def step_ingest(ctx: Ctx) -> None:
    src = load_file(ctx, "source")
    if src is None:
        raise StepFailed("ingest", "source PDF is missing (purged?)")
    if not src.startswith(b"%PDF-"):
        raise StepFailed("ingest", "source is not a PDF")
    ctx.source_pdf = ctx.workdir / "source.pdf"
    ctx.source_pdf.write_bytes(src)
    prior = load_file(ctx, "prior")
    if prior:
        ctx.prior_pdf = ctx.workdir / "prior.pdf"
        ctx.prior_pdf.write_bytes(prior)
    import pdfplumber

    try:
        with pdfplumber.open(str(ctx.source_pdf)) as pdf:
            n = len(pdf.pages)
    except Exception as exc:  # noqa: BLE001
        raise StepFailed("ingest", f"could not open PDF ({type(exc).__name__})") from exc
    if n > MAX_PAGES:
        raise StepFailed("ingest", f"{n} pages exceeds the {MAX_PAGES}-page limit")
    ctx.db.update_job(ctx.job_id, page_count=n)


def step_identify(ctx: Ctx) -> None:
    if ctx.source_pdf is None:
        step_ingest(ctx)
    ident = identify(str(ctx.source_pdf), ctx.cfg.profiles_dir)
    if not ident.tax_year:
        raise StepFailed("identify", "tax year not found on the first pages")
    ctx.ident = ident
    ctx.db.update_job(
        ctx.job_id,
        software=ident.software,
        tax_year=ident.tax_year,
        form=ident.form or "1040",
        text_coverage=int(round(ident.text_coverage * 100)),
        page_count=ident.page_count,
    )


def step_extract(ctx: Ctx) -> None:
    if ctx.ident is None:
        step_identify(ctx)
    try:
        exceptions = {e.get("check") for e in (ctx.job.get("recon_exceptions") or []) if e.get("check")}
        ctx.extraction = extract_return(
            str(ctx.source_pdf),
            ctx.cfg.profiles_dir,
            ident=ctx.ident,
            prior_pdf_path=str(ctx.prior_pdf) if ctx.prior_pdf else None,
            recon_exceptions=exceptions,
        )
    except ExtractionError as exc:
        raise StepFailed("extract", str(exc)) from exc
    store_extraction(ctx)


def step_ocr(ctx: Ctx) -> None:
    """Conditional: only when identify found too little text. Implemented in Phase 4."""
    if ctx.ident and ctx.ident.text_coverage < OCR_COVERAGE_THRESHOLD:
        from .extract.ocr import ocr_pages

        ocr_pages(ctx)
        step_extract(ctx)


def step_recon(ctx: Ctx) -> None:
    if ctx.extraction is None:
        raw = load_file(ctx, "extraction")
        if raw is None:
            step_extract(ctx)
        else:
            ctx.extraction = json.loads(raw)
            ctx.extraction_sha256 = sha256_bytes(raw)
    from .extract.recon import reconcile

    exceptions = {e.get("check") for e in (ctx.job.get("recon_exceptions") or []) if e.get("check")}
    ctx.extraction["recon"] = reconcile(ctx.extraction, exceptions)
    store_extraction(ctx)
    bad = failures(ctx.extraction["recon"])
    if bad:
        names = ", ".join(f"{c['name']} (expected {c['expected']:,}, found {c['actual']:,})" for c in bad)
        raise StepFailed("recon", f"reconciliation failed: {names}")


def step_script(ctx: Ctx) -> None:
    from .script.generate import generate_script

    generate_script(ctx)


def step_validate(ctx: Ctx) -> None:
    from .script.generate import validate_current_script

    validate_current_script(ctx)


def step_verify(ctx: Ctx) -> None:
    from .verify.verify import verify_job

    verify_job(ctx)


def step_tts(ctx: Ctx) -> None:
    from .render.tts import synthesize

    synthesize(ctx)


def step_slides(ctx: Ctx) -> None:
    from .render.slides import render_slides

    render_slides(ctx)


def step_mux(ctx: Ctx) -> None:
    from .render.mux import mux

    mux(ctx)


def step_ready(ctx: Ctx) -> None:
    ctx.db.update_job(ctx.job_id, status="needs_review", step="ready", ready_at=_now(), resume_from=None)
    ctx.db.add_event(ctx.job_id, "needs_review", "ready", "ready for review", {"seconds": round(time.time() - ctx.started, 1)})


STEP_FUNCS: dict[str, Callable[[Ctx], None]] = {
    "ingest": step_ingest,
    "identify": step_identify,
    "extract": step_extract,
    "ocr": step_ocr,
    "recon": step_recon,
    "script": step_script,
    "validate": step_validate,
    "verify": step_verify,
    "tts": step_tts,
    "slides": step_slides,
    "mux": step_mux,
    "ready": step_ready,
}

# Steps whose outputs later steps need loaded from disk when resuming past them.
_RESUME_LOADERS: dict[str, Callable[[Ctx], None]] = {}


def _load_for_resume(ctx: Ctx, first_step: str) -> None:
    """When resuming mid-pipeline, restore in-memory state from stored artifacts."""
    idx = STEPS.index(first_step)
    if idx > STEPS.index("ingest"):
        step_ingest(ctx)
    if idx > STEPS.index("identify"):
        ctx.ident = identify(str(ctx.source_pdf), ctx.cfg.profiles_dir)
    if idx > STEPS.index("recon"):
        raw = load_file(ctx, "extraction")
        if raw is None:
            raise StepFailed(first_step, "extraction is missing; re-extract first")
        ctx.extraction = json.loads(raw)
        ctx.extraction_sha256 = sha256_bytes(raw)
    if idx > STEPS.index("validate"):
        raw = load_file(ctx, "script")
        if raw is None:
            raise StepFailed(first_step, "script is missing; regenerate first")
        ctx.script = raw.decode("utf-8")
    if idx > STEPS.index("verify"):
        raw = load_file(ctx, "verification")
        if raw is not None:
            ctx.verification = json.loads(raw)


def run_job(cfg: Config, storage: Storage, job_id: str) -> dict[str, Any]:
    db = Db(cfg.database_url)
    log = get_logger("recap.pipeline", job_id=job_id)
    job = db.get_job(job_id)
    if not job:
        log.warning("job row missing")
        return {"ok": False, "error": "job not found"}
    if job["status"] in ("processing",):
        # A previous worker died mid-job. Fail it cleanly; the preparer retries from that step.
        step = job.get("step") or "ingest"
        db.update_job(job_id, status="failed", error_step=step, error_message="worker restarted mid-job; retry to resume", failed_at=_now())
        db.add_event(job_id, "failed", step, "worker restarted mid-job; retry to resume")
        log.warning("job was mid-flight when the worker restarted; marked failed", extra={"step": step})
        return {"ok": False, "error": "interrupted"}
    if job["status"] not in ("queued",):
        log.info("job not queued; ignoring", extra={"status": job["status"]})
        return {"ok": False, "error": f"status {job['status']}"}

    first = job.get("resume_from") or "ingest"
    if first not in STEPS:
        first = "ingest"
    workdir = Path(tempfile.mkdtemp(prefix=f"recap-{job_id[:8]}-"))
    ctx = Ctx(cfg=cfg, storage=storage, db=db, job=job, workdir=workdir, log=log, settings=db.settings())
    current = first
    try:
        db.update_job(job_id, status="processing", step=first, processing_at=_now(), error_step=None, error_message=None)
        db.add_event(job_id, "processing", first, f"starting at {first}")
        _load_for_resume(ctx, first)
        for step in STEPS[STEPS.index(first) :]:
            current = step
            if step != first:
                db.update_job(job_id, step=step)
            t0 = time.time()
            STEP_FUNCS[step](ctx)
            db.add_event(job_id, "processing", step, None, {"seconds": round(time.time() - t0, 1)})
        log.info("job ready", extra={"seconds": round(time.time() - ctx.started, 1)})
        return {"ok": True}
    except StepFailed as exc:
        db.update_job(job_id, status="failed", step=exc.step, error_step=exc.step, error_message=exc.message[:2000], failed_at=_now())
        db.add_event(job_id, "failed", exc.step, exc.message[:2000])
        log.warning("job failed", extra={"step": exc.step})
        return {"ok": False, "step": exc.step}
    except Exception as exc:  # noqa: BLE001
        msg = f"{type(exc).__name__}: {exc}"[:2000]
        db.update_job(job_id, status="failed", step=current, error_step=current, error_message=msg, failed_at=_now())
        db.add_event(job_id, "failed", current, msg, {"trace": traceback.format_exc()[-1500:]})
        log.error("job crashed", extra={"step": current, "error": type(exc).__name__})
        return {"ok": False, "step": current}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
