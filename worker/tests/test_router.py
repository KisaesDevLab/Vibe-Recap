"""Vibe AI Router client against a stub HTTP server: headers, wire shape, error taxonomy, retries."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from recap.script import generate as gen
from recap.script.router import Router, RouterError

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
GOLDEN = FIXTURES / "scripts"


class StubRouter:
    """Records requests; answers per a queue of (status, body, headers)."""

    def __init__(self):
        self.requests: list[dict] = []
        self.responses: list[tuple[int, dict, dict]] = []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: D102
                pass

            def do_GET(self):  # noqa: N802
                self.send_response(200 if self.path == "/healthz" else 404)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                stub.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                status, payload, headers = stub.responses.pop(0) if stub.responses else (200, stub.ok_body("[[slide:greeting]] hi"), {})
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("x-request-id", "req-123")
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    @staticmethod
    def ok_body(text: str) -> dict:
        return {
            "id": "x",
            "model": "llama-3.3-70b",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 900, "completion_tokens": 400},
            "vibe": {"provider_id": "do-serverless", "latency_ms": 1234},
        }

    def close(self):
        self.server.shutdown()


@pytest.fixture
def stub():
    s = StubRouter()
    yield s
    s.close()


def test_sends_contract_headers_and_openai_body(stub):
    r = Router(stub.url, "tok-abc", model="llama-3.3-70b", user_id="u1", user_role="preparer", client_ref="c1", engagement_ref="j1")
    out = r.chat([{"role": "system", "content": "s"}, {"role": "user", "content": "u"}], max_tokens=800)
    req = stub.requests[0]
    assert req["path"] == "/v1/chat/completions"
    assert req["headers"]["authorization"] == "Bearer tok-abc"
    assert req["headers"]["x-vibe-task-class"] == "recap_script"
    assert req["headers"]["x-vibe-user"] == "u1" and req["headers"]["x-vibe-user-role"] == "staff"
    assert req["headers"]["x-vibe-client"] == "c1" and req["headers"]["x-vibe-engagement"] == "j1"
    assert req["body"]["model"] == "llama-3.3-70b" and req["body"]["max_tokens"] == 800 and req["body"]["stream"] is False
    assert out.content.startswith("[[slide:greeting]]") and out.model == "llama-3.3-70b" and out.total_ms == 1234
    assert out.prompt_eval_count == 900


def test_error_taxonomy_is_surfaced_by_code(stub):
    stub.responses.append((403, {"error": {"code": "policy_blocked", "message": "no model bound"}}, {}))
    with pytest.raises(RouterError) as exc:
        Router(stub.url, "tok").chat([{"role": "user", "content": "u"}])
    assert exc.value.code == "policy_blocked" and "router console" in str(exc.value) and "req-123" in str(exc.value)
    stub.responses.append((422, {"error": {"code": "scrubber_blocked", "message": "SSN", "detail": {"matches": ["ssn"]}}}, {}))
    with pytest.raises(RouterError) as exc:
        Router(stub.url, "tok").chat([{"role": "user", "content": "u"}])
    assert exc.value.code == "scrubber_blocked" and not exc.value.retryable


def test_retries_retryable_errors_with_retry_after(stub):
    stub.responses.append((429, {"error": {"code": "rate_limited", "message": "slow down"}}, {"retry-after": "0"}))
    stub.responses.append((502, {"error": {"code": "provider_unavailable", "message": "down"}}, {"retry-after": "0"}))
    stub.responses.append((200, StubRouter.ok_body("[[slide:greeting]] ok"), {}))
    out = Router(stub.url, "tok").chat([{"role": "user", "content": "u"}])
    assert out.content.endswith("ok") and len(stub.requests) == 3


def test_provider_selection_prefers_router_when_token_present(stub, monkeypatch):
    cfg = SimpleNamespace(router_url=stub.url, router_token="tok", ollama_url="http://ollama:11434", ollama_model="qwen3:8b", ollama_timeout_s=600.0)
    ctx = SimpleNamespace(cfg=cfg, settings={}, job={"uploaded_by": "u", "client_id": "c", "id": "j"}, log=None)
    assert isinstance(gen._client_for(ctx), Router)
    ctx.settings = {"llm_provider": "ollama"}
    assert not isinstance(gen._client_for(ctx), Router)
    cfg.router_token = None
    ctx.settings = {}
    assert not isinstance(gen._client_for(ctx), Router)


def test_generate_through_router_with_golden_script(stub):
    ex = json.loads((FIXTURES / "drake-1040-2025-mfj-refund-mo.expected.json").read_text())
    stub.responses.append((200, StubRouter.ok_body((GOLDEN / "mfj-refund-mo.md").read_text(encoding="utf-8")), {}))
    script, attempts = gen.generate(ex, {}, None, Router(stub.url, "tok"))
    assert attempts[0]["ok"] and script.startswith("[[slide:greeting]]")
    assert stub.requests[0]["headers"]["x-vibe-task-class"] == "recap_script"
