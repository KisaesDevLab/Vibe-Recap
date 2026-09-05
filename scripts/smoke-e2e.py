#!/usr/bin/env python
"""End-to-end smoke test against a running stack (https://localhost by default).

Creates the first admin if needed, uploads a fixture, checks the worker staged it,
queues it, and waits for the worker to pick the job up. Safe to re-run.

    python scripts/smoke-e2e.py [--base https://localhost] [--fixture tests/fixtures/x.pdf]
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import ssl
import sys
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf: str | None = None

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, content_type: str | None = None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("content-type", content_type or "application/json")
        if self.csrf:
            req.add_header("x-csrf-token", self.csrf)
        try:
            with self.opener.open(req, timeout=120) as r:
                txt = r.read().decode()
                return r.status, (json.loads(txt) if txt else None)
        except urllib.error.HTTPError as e:
            txt = e.read().decode()
            return e.code, (json.loads(txt) if txt.startswith("{") else txt)


def multipart(files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    b = "----smoke" + uuid.uuid4().hex
    out = b""
    for name, data in files:
        out += f"--{b}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\nContent-Type: application/pdf\r\n\r\n".encode() + data + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return out, f"multipart/form-data; boundary={b}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://localhost")
    ap.add_argument("--fixture", default=str(ROOT / "tests/fixtures/ultratax-1040-2025-mfj-refund-mo.pdf"))
    ap.add_argument("--email", default="smoke@example.com")
    ap.add_argument("--password", default="smoke-test-password-1")
    args = ap.parse_args()
    api = Api(args.base)

    code, health = api.call("GET", "/readyz")
    print("readyz", code, health)
    code, st = api.call("GET", "/api/setup/status")
    if st and st.get("needed"):
        code, r = api.call("POST", "/api/setup", {"email": args.email, "name": "Smoke", "password": args.password})
        print("setup", code)
    code, me = api.call("POST", "/api/auth/login", {"email": args.email, "password": args.password})
    if code != 200:
        print("login failed", code, me)
        return 1
    api.csrf = me["csrfToken"]
    print("login ok as", me["user"]["role"])

    pdf = Path(args.fixture).read_bytes()
    body, ct = multipart([(Path(args.fixture).name, pdf)])
    t0 = time.time()
    code, stage = api.call("POST", "/api/uploads/stage", raw=body, content_type=ct)
    print(f"stage {code} in {time.time() - t0:.1f}s")
    if code != 201:
        print(stage)
        return 1
    row = stage["files"][0]
    print("  detected:", row["detected"], "match:", row["match"], "warnings:", row["warnings"])
    if row["status"] != "ok":
        print("staging failed:", row.get("skipReason"))
        return 1
    code, q = api.call("POST", f"/api/uploads/stage/{stage['id']}/queue", {})
    print("queue", code, q)
    if code != 201:
        return 1
    job_id = q["jobIds"][0]
    for _ in range(900):
        code, job = api.call("GET", f"/api/jobs/{job_id}")
        if job["status"] not in ("queued", "processing"):
            break
        time.sleep(2)
    print("job", job["status"], job.get("step"), job.get("errorStep"), job.get("errorMessage"))
    for e in job["events"]:
        print("  ", e["at"], e["status"], e.get("step"), e.get("message"))
    return 0 if job["status"] in ("needs_review", "failed") else 2


if __name__ == "__main__":
    sys.exit(main())
