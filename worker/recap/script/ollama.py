"""Minimal Ollama chat client.

Always sends num_ctx 16384 (the default 4096 truncates a full extraction prompt), strips any
<think>...</think> blocks Qwen3 emits, and turns transport problems into OllamaError.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

THINK_RE = re.compile(r"<think>.*?</think>\s*", re.S)


class OllamaError(Exception):
    pass


@dataclass
class ChatResult:
    content: str
    model: str
    eval_count: int | None
    prompt_eval_count: int | None
    total_ms: int | None


def strip_think(text: str) -> str:
    text = THINK_RE.sub("", text)
    # an unterminated think block means the model ran out of tokens while thinking
    if "<think>" in text:
        text = text.split("<think>", 1)[0]
    return text.strip()


class Ollama:
    def __init__(self, base_url: str, model: str, *, temperature: float = 0.3, num_ctx: int = 16384, timeout_s: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self.num_ctx = num_ctx
        self.timeout_s = timeout_s

    def available(self) -> bool:
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=5)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    def has_model(self) -> bool:
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=5)
            names = [m.get("name", "") for m in r.json().get("models", [])]
            return any(n == self.model or n.split(":")[0] == self.model.split(":")[0] for n in names)
        except (httpx.HTTPError, ValueError):
            return False

    def chat(self, messages: list[dict[str, str]], *, max_tokens: int = 1200) -> ChatResult:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            # Qwen3 thinking is off: it costs a thousand tokens per answer on CPU and the validator
            # loop is the reasoning we want. Older Ollama versions ignore the field; the /no_think
            # marker in the prompts covers them.
            "think": False,
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx, "num_predict": max_tokens},
        }
        try:
            r = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout_s)
        except httpx.TimeoutException as exc:
            raise OllamaError(f"Ollama timed out after {self.timeout_s:.0f}s") from exc
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama unreachable at {self.base_url} ({type(exc).__name__})") from exc
        if r.status_code == 404:
            raise OllamaError(f"model {self.model} is not available on Ollama; pull it or change the model setting")
        if r.status_code >= 400:
            raise OllamaError(f"Ollama returned {r.status_code}: {r.text[:200]}")
        data = r.json()
        content = strip_think(data.get("message", {}).get("content", ""))
        return ChatResult(
            content=content,
            model=data.get("model", self.model),
            eval_count=data.get("eval_count"),
            prompt_eval_count=data.get("prompt_eval_count"),
            total_ms=int(data["total_duration"] / 1e6) if data.get("total_duration") else None,
        )
