"""OCR fallback (Phase 4): GLM-OCR via Ollama for pages with no usable text layer.

Only runs when `identify` reports text coverage below the threshold. Pages without text are
rasterized at 200 dpi, sent to the OCR model, and the returned words (with coordinates) are
merged into a synthetic PDF text layer so the form profiles apply unchanged. A per-page cap
of 90 s fails the job cleanly at `ocr` instead of hanging the queue.

The OCR model is asked for line-level JSON with bounding boxes. Any model that answers the
prompt format works; the name is a setting (OLLAMA_OCR_MODEL, default glm-ocr).
"""

from __future__ import annotations

import base64
import io
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import httpx

PAGE_TIMEOUT_S = 90
DPI = 200

OCR_PROMPT = (
    "Read every line of text on this scanned tax form page. Respond with JSON only: "
    '{"lines":[{"text":"...", "box":[x0,y0,x1,y1]}]} where box is in pixel coordinates of the '
    "image (left, top, right, bottom). Keep numbers exactly as printed, including commas and parentheses."
)


class OcrTimeout(Exception):
    pass


class OcrUnavailable(Exception):
    pass


@dataclass
class OcrLine:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float


OcrFn = Callable[[bytes], list[OcrLine]]


def rasterize(pdf_path: str, page_numbers: list[int], dpi: int = DPI) -> dict[int, bytes]:
    """Render the given 1-based pages to PNG bytes."""
    import pypdfium2 as pdfium

    out: dict[int, bytes] = {}
    doc = pdfium.PdfDocument(pdf_path)
    try:
        for n in page_numbers:
            page = doc[n - 1]
            bitmap = page.render(scale=dpi / 72)
            img = bitmap.to_pil()
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            out[n] = buf.getvalue()
    finally:
        doc.close()
    return out


def ollama_ocr(base_url: str, model: str, timeout_s: int = PAGE_TIMEOUT_S) -> OcrFn:
    """Build an OCR function that calls Ollama's chat endpoint with an image."""

    def run(png: bytes) -> list[OcrLine]:
        started = time.time()
        payload = {
            "model": model,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0, "num_ctx": 8192},
            "messages": [{"role": "user", "content": OCR_PROMPT, "images": [base64.b64encode(png).decode("ascii")]}],
        }
        try:
            r = httpx.post(f"{base_url}/api/chat", json=payload, timeout=timeout_s)
        except httpx.TimeoutException as exc:
            raise OcrTimeout("scanned pages exceeded time limit") from exc
        except httpx.HTTPError as exc:
            raise OcrUnavailable(f"OCR model unreachable ({type(exc).__name__})") from exc
        if r.status_code == 404:
            raise OcrUnavailable(f"OCR model {model} is not pulled")
        r.raise_for_status()
        if time.time() - started > timeout_s:
            raise OcrTimeout("scanned pages exceeded time limit")
        content = r.json().get("message", {}).get("content", "")
        return parse_ocr_json(content)

    return run


def parse_ocr_json(content: str) -> list[OcrLine]:
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    out: list[OcrLine] = []
    for ln in data.get("lines", []):
        box = ln.get("box") or [0, 0, 0, 0]
        if len(box) != 4:
            continue
        text = str(ln.get("text", "")).strip()
        if text:
            out.append(OcrLine(text, float(box[0]), float(box[1]), float(box[2]), float(box[3])))
    return out


def lines_to_text_layer(pdf_path: str, page_lines: dict[int, list[OcrLine]], out_path: str, dpi: int = DPI) -> None:
    """Write a copy of the PDF where each OCR'd page gets an invisible text layer at the OCR
    coordinates, so pdfplumber (and the form profiles) see words exactly like a native page."""
    import pypdfium2 as pdfium
    from reportlab.pdfgen import canvas

    src = pdfium.PdfDocument(pdf_path)
    try:
        sizes = [(src[i].get_width(), src[i].get_height()) for i in range(len(src))]
    finally:
        src.close()
    overlay_path = str(Path(out_path).with_suffix(".overlay.pdf"))
    c = canvas.Canvas(overlay_path)
    scale = 72 / dpi
    for i, (w, h) in enumerate(sizes):
        c.setPageSize((w, h))
        for ln in page_lines.get(i + 1, []):
            height_pt = max(6.0, (ln.bottom - ln.top) * scale)
            c.setFont("Helvetica", min(12.0, height_pt * 0.85))
            c.setFillColorRGB(1, 1, 1, alpha=0)  # invisible
            # PDF origin is bottom-left; OCR top is measured from the page top.
            c.drawString(ln.x0 * scale, h - ln.bottom * scale + 1, ln.text)
        c.showPage()
    c.save()
    _merge_overlay(pdf_path, overlay_path, out_path)
    Path(overlay_path).unlink(missing_ok=True)


def _merge_overlay(base_path: str, overlay_path: str, out_path: str) -> None:
    """Stamp each overlay page onto the base page. Falls back to the overlay alone when the
    base pages are pure images the merge library cannot handle."""
    try:
        from pypdf import PdfReader, PdfWriter

        over = PdfReader(overlay_path)
        writer = PdfWriter(clone_from=PdfReader(base_path))
        for i, page in enumerate(writer.pages):
            if i < len(over.pages):
                page.merge_page(over.pages[i])
        with open(out_path, "wb") as fh:
            writer.write(fh)
    except ImportError:
        Path(out_path).write_bytes(Path(overlay_path).read_bytes())


def ocr_pages(ctx: Any, ocr_fn: OcrFn | None = None) -> None:
    """Pipeline step body: OCR the pages identify found empty and swap in the text-layered PDF."""
    from .identify import identify
    from ..pipeline import StepFailed

    settings = ctx.settings or {}
    if settings.get("ocr_enabled", True) is False:
        raise StepFailed("ocr", "pages lack a text layer and OCR is disabled in settings")
    ident = ctx.ident
    empty = list(ident.pages_without_text) if ident else []
    if not empty:
        return
    fn = ocr_fn or ollama_ocr(ctx.cfg.ollama_url, ctx.settings.get("ocr_model") or ctx.cfg.ollama_ocr_model)
    images = rasterize(str(ctx.source_pdf), empty)
    page_lines: dict[int, list[OcrLine]] = {}
    for n in empty:
        try:
            page_lines[n] = fn(images[n])
        except OcrTimeout as exc:
            raise StepFailed("ocr", str(exc)) from exc
        except OcrUnavailable as exc:
            raise StepFailed("ocr", str(exc)) from exc
    out = ctx.workdir / "source.ocr.pdf"
    lines_to_text_layer(str(ctx.source_pdf), page_lines, str(out))
    ctx.source_pdf = out
    ctx.ident = identify(str(out), ctx.cfg.profiles_dir)
    ctx.db.add_event(ctx.job_id, "processing", "ocr", f"OCR applied to {len(empty)} page(s)", {"pages": empty})
