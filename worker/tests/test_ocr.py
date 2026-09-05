"""OCR fallback tests with a fake OCR engine.

The real GLM-OCR model only runs inside the compose stack. Here the fixture is rasterized to
images (so it has no text layer), and a stand-in OCR function answers with the words pdfplumber
sees on the original page, scaled to pixel coordinates. That exercises rasterization, the
text-layer overlay, and the hand-off back into extraction and recon.
"""

from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace

import pdfplumber
import pytest

from recap.extract import ocr
from recap.extract.identify import identify
from recap.extract.run import extract_return

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
PROFILES = Path(__file__).resolve().parents[2] / "form-profiles"


def image_only_pdf(src: Path, out: Path) -> None:
    """PDF -> PNG -> PDF: every page becomes a picture with no text layer."""
    import pypdfium2 as pdfium
    from PIL import Image

    doc = pdfium.PdfDocument(str(src))
    images = [doc[i].render(scale=150 / 72).to_pil().convert("RGB") for i in range(len(doc))]
    doc.close()
    images[0].save(str(out), save_all=True, append_images=images[1:], resolution=150.0)
    Image.open  # noqa: B018 (keep PIL import used)


def fake_ocr_from(src: Path, dpi: int = ocr.DPI):
    """OCR stand-in: returns the original page's words as OCR lines in pixel space."""
    with pdfplumber.open(str(src)) as pdf:
        pages = [page.extract_words(use_text_flow=True) for page in pdf.pages]
    calls = {"n": 0}

    def run(png: bytes) -> list[ocr.OcrLine]:
        words = pages[calls["n"]]
        calls["n"] += 1
        s = dpi / 72
        return [ocr.OcrLine(w["text"], w["x0"] * s, w["top"] * s, w["x1"] * s, w["bottom"] * s) for w in words]

    return run


def test_rasterized_fixture_extracts_and_reconciles(tmp_path):
    src = FIXTURES / "lacerte-1040-2025-single-owed-itemized.pdf"
    scanned = tmp_path / "scanned.pdf"
    image_only_pdf(src, scanned)
    ident = identify(str(scanned), str(PROFILES))
    assert ident.text_coverage == 0.0 and len(ident.pages_without_text) == 4

    ctx = SimpleNamespace(
        settings={},
        ident=ident,
        cfg=SimpleNamespace(ollama_url="http://unused", ollama_ocr_model="glm-ocr", profiles_dir=str(PROFILES)),
        source_pdf=scanned,
        workdir=tmp_path,
        job_id="job",
        db=SimpleNamespace(add_event=lambda *a, **k: None),
    )
    ocr.ocr_pages(ctx, ocr_fn=fake_ocr_from(src))
    assert ctx.source_pdf.name == "source.ocr.pdf"
    assert ctx.ident.text_coverage == 1.0
    assert ctx.ident.software == "lacerte"
    doc = extract_return(str(ctx.source_pdf), str(PROFILES), ident=ctx.ident)
    assert doc["recon"]["passed"] is True
    assert doc["result"]["amount_owed"] > 0


def test_ocr_disabled_fails_cleanly(tmp_path):
    from recap.pipeline import StepFailed

    ctx = SimpleNamespace(settings={"ocr_enabled": False}, ident=SimpleNamespace(pages_without_text=[1]))
    with pytest.raises(StepFailed) as exc:
        ocr.ocr_pages(ctx, ocr_fn=lambda png: [])
    assert exc.value.step == "ocr"


def test_parse_ocr_json_tolerates_think_blocks():
    lines = ocr.parse_ocr_json('<think>hmm</think>{"lines":[{"text":"11 Adjusted gross income 84,250","box":[10,20,300,32]}]}')
    assert lines[0].text.endswith("84,250") and lines[0].x1 == 300
    assert ocr.parse_ocr_json("not json") == []


def test_timeout_maps_to_step_failure(tmp_path, monkeypatch):
    from recap.pipeline import StepFailed

    src = FIXTURES / "drake-1040-2025-mfj-refund-mo.pdf"
    scanned = tmp_path / "scanned.pdf"
    image_only_pdf(src, scanned)
    ident = identify(str(scanned), str(PROFILES))

    def slow(png: bytes):
        raise ocr.OcrTimeout("scanned pages exceeded time limit")

    ctx = SimpleNamespace(settings={}, ident=ident, cfg=SimpleNamespace(profiles_dir=str(PROFILES)), source_pdf=scanned, workdir=tmp_path, job_id="j", db=None)
    with pytest.raises(StepFailed, match="exceeded time limit"):
        ocr.ocr_pages(ctx, ocr_fn=slow)
    io.BytesIO  # noqa: B018
