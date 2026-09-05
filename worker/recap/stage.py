"""Upload-time staging pass: first page only, under a second per file.

Input: {stageId, fileId}; the encrypted blob lives at blobs/staging/<stageId>/<fileId>.age.
Output: names, tax year, software, form, page count. Never logs the names.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from .config import Config
from .extract.identify import identify
from .logging import get_logger
from .storage import Storage


def stage_file(cfg: Config, storage: Storage, stage_id: str, file_id: str) -> dict[str, Any]:
    log = get_logger("recap.stage", stage_id=stage_id, file_id=file_id)
    rel = f"blobs/staging/{stage_id}/{file_id}.age"
    rel_key = f"blobs/staging/{stage_id}/{file_id}.key"
    try:
        data = storage.get(rel, rel_key)
    except Exception as exc:  # noqa: BLE001
        log.warning("staged blob unreadable", extra={"error": str(exc)})
        return {"ok": False, "error": "staged file unreadable"}
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(data)
        tmp = Path(fh.name)
    try:
        ident = identify(str(tmp), cfg.profiles_dir, max_pages=3)
    except Exception as exc:  # noqa: BLE001
        log.warning("identify failed", extra={"error": type(exc).__name__})
        return {"ok": False, "error": f"could not read PDF ({type(exc).__name__})"}
    finally:
        tmp.unlink(missing_ok=True)
    log.info("staged", extra={"software": ident.software, "tax_year": ident.tax_year, "pages": ident.page_count})
    return {
        "ok": True,
        "firstName": ident.first_name,
        "lastName": ident.last_name,
        "spouseFirstName": ident.spouse_first_name,
        "taxYear": ident.tax_year,
        "software": ident.software,
        "form": ident.form,
        "pageCount": ident.page_count,
        "textCoverage": ident.text_coverage,
    }
