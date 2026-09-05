"""Vibe AI Router client (default script-generation provider; QUESTIONS.md Q37).

Speaks the router's frozen wire contract (docs/envelope.md in the Vibe-AI-Router repo):
OpenAI-compatible `POST /v1/chat/completions` with `Authorization: Bearer <app token>` and
`X-Vibe-Task-Class`. The model is advisory; the router's policy decides what serves. Errors
are handled by taxonomy code, not status: retryable ones (`rate_limited`,
`provider_unavailable`) are retried with the router's `Retry-After`, the rest surface as a
clear job failure. Only the prompt (extracted figures, first names, filing status, states,
preparer note) is sent; the PDF never is.
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

from .ollama import ChatResult, OllamaError, strip_think

TASK_CLASS = "recap_script"
RETRYABLE = {"rate_limited", "provider_unavailable"}
USER_MESSAGES = {
    "scrubber_blocked": "the AI Router blocked the request: protected data would leave the box for this task class",
    "policy_blocked": "the AI Router policy has no model bound to the recap_script task class, or the firm disabled it; an admin fixes this in the router console (Policies)",
    "budget_exceeded": "the firm's AI budget is exhausted for this period (router)",
    "auth_error": "the AI Router rejected the app token; re-provision VIBE_AI_TOKEN",
    "context_exceeded": "the prompt is too long for the model the router selected",
    "content_filtered": "the model provider refused this request",
    "capability_missing": "no bound model has the capability the recap_script class requires",
    "invalid_request": "the AI Router rejected the request shape (app bug)",
}


class RouterError(OllamaError):
    def __init__(self, code: str, message: str, retryable: bool = False, retry_after: float | None = None, request_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.retry_after = retry_after
        self.request_id = request_id


class Router:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        model: str | None = None,
        task_class: str = TASK_CLASS,
        temperature: float = 0.3,
        timeout_s: float = 600.0,
        user_id: str | None = None,
        user_role: str | None = None,
        client_ref: str | None = None,
        engagement_ref: str | None = None,
        max_retries: int = 3,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.model = model or None
        self.task_class = task_class
        self.temperature = temperature
        self.timeout_s = timeout_s
        self.user_id = user_id
        self.user_role = user_role
        self.client_ref = client_ref
        self.engagement_ref = engagement_ref
        self.max_retries = max_retries

    def _headers(self) -> dict[str, str]:
        h = {
            "authorization": f"Bearer {self.token}",
            "content-type": "application/json",
            "accept": "application/json",
            "x-vibe-task-class": self.task_class,
        }
        if self.user_id:
            h["x-vibe-user"] = self.user_id
        if self.user_role:
            h["x-vibe-user-role"] = "admin" if self.user_role == "admin" else "staff"
        if self.client_ref:
            h["x-vibe-client"] = self.client_ref
        if self.engagement_ref:
            h["x-vibe-engagement"] = self.engagement_ref
        return h

    def available(self) -> bool:
        try:
            return httpx.get(f"{self.base_url}/healthz", timeout=5).status_code == 200
        except httpx.HTTPError:
            return False

    def chat(self, messages: list[dict[str, str]], *, max_tokens: int = 1200) -> ChatResult:
        payload: dict[str, Any] = {
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": self.temperature,
            "stream": False,
        }
        if self.model:
            payload["model"] = self.model
        attempt = 0
        while True:
            attempt += 1
            try:
                r = httpx.post(f"{self.base_url}/v1/chat/completions", json=payload, headers=self._headers(), timeout=self.timeout_s)
            except httpx.TimeoutException as exc:
                raise RouterError("timeout", f"AI Router timed out after {self.timeout_s:.0f}s") from exc
            except httpx.HTTPError as exc:
                raise RouterError("unreachable", f"AI Router unreachable at {self.base_url} ({type(exc).__name__})") from exc
            request_id = r.headers.get("x-request-id")
            if r.status_code < 400:
                break
            code, message = _parse_error(r)
            retry_after = _retry_after(r)
            if code in RETRYABLE and attempt <= self.max_retries:
                time.sleep(min(retry_after or 2.0 * attempt, 30.0))
                continue
            human = USER_MESSAGES.get(code, message)
            raise RouterError(code, f"{human} (router {code}, request {request_id})", retryable=code in RETRYABLE, retry_after=retry_after, request_id=request_id)
        if "application/json" not in r.headers.get("content-type", ""):
            raise RouterError("unknown", "AI Router returned a non-JSON response (proxy or login page?)")
        data = r.json()
        choice = (data.get("choices") or [{}])[0]
        content = choice.get("message", {}).get("content") or ""
        if isinstance(content, list):  # content parts
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        usage = data.get("usage") or {}
        served = (data.get("vibe") or {})
        return ChatResult(
            content=strip_think(content),
            model=data.get("model") or served.get("model") or "router",
            eval_count=usage.get("completion_tokens"),
            prompt_eval_count=usage.get("prompt_tokens"),
            total_ms=served.get("latency_ms"),
        )


def _parse_error(r: httpx.Response) -> tuple[str, str]:
    try:
        body = r.json()
        err = body.get("error") or {}
        return str(err.get("code") or "unknown"), str(err.get("message") or f"HTTP {r.status_code}")
    except ValueError:
        return "unknown", f"HTTP {r.status_code}: {r.text[:200]}"


def _retry_after(r: httpx.Response) -> float | None:
    v = r.headers.get("retry-after")
    if not v:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", v.strip()):
        return float(v)
    return None
