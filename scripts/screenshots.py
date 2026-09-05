#!/usr/bin/env python
"""Capture README screenshots from a running stack with Playwright.

    python scripts/screenshots.py --base https://localhost --email smoke@example.com --password ...

Writes docs/screenshots/{dashboard,upload,job,verification,settings}.png. Uses the first job
in `needs_review`/`approved`/`released` for the job page. Synthetic fixtures only.
"""

from __future__ import annotations

import argparse
import json
import ssl
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://localhost")
    ap.add_argument("--email", default="smoke@example.com")
    ap.add_argument("--password", default="smoke-test-password-1")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(f"{args.base}/login", wait_until="networkidle")
        page.fill('input[type="email"]', args.email)
        page.fill('input[type="password"]', args.password)
        page.click('button[type="submit"]')
        page.wait_for_url(f"{args.base}/", timeout=20000)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / "dashboard.png"))

        page.goto(f"{args.base}/upload", wait_until="networkidle")
        page.screenshot(path=str(OUT / "upload.png"))

        # pick a finished job through the API using the browser session
        jobs = page.evaluate("async () => (await fetch('/api/jobs?status=needs_review,approved,released&limit=1')).json()")
        job = (jobs.get("jobs") or [None])[0]
        if job:
            page.goto(f"{args.base}/jobs/{job['id']}", wait_until="networkidle")
            page.wait_for_timeout(2500)
            page.screenshot(path=str(OUT / "job.png"), full_page=True)
        page.goto(f"{args.base}/settings/general", wait_until="networkidle")
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "settings.png"))
        browser.close()
    print(json.dumps({"written": sorted(p.name for p in OUT.glob("*.png"))}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
