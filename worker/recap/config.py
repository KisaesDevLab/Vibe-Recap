"""Environment configuration for the worker. Values mirror compose.yml."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    redis_url: str
    data_dir: str
    ollama_url: str
    ollama_model: str
    ollama_ocr_model: str
    master_key_passphrase: str | None
    concurrency: int
    log_level: str
    models_dir: str
    profiles_dir: str
    ollama_timeout_s: float = 600.0
    router_url: str = "http://airouter-proxy:8220"
    router_token: str | None = None

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> "Config":
        e = env if env is not None else os.environ
        return Config(
            database_url=e.get("DATABASE_URL", "postgres://recap:recap@localhost:55432/recap_test"),
            redis_url=e.get("REDIS_URL", "redis://localhost:56379"),
            data_dir=e.get("DATA_DIR", "./data"),
            ollama_url=e.get("OLLAMA_URL", "http://ollama:11434").rstrip("/"),
            ollama_model=e.get("OLLAMA_MODEL", "qwen3:8b"),
            ollama_ocr_model=e.get("OLLAMA_OCR_MODEL", "glm-ocr"),
            master_key_passphrase=e.get("MASTER_KEY_PASSPHRASE") or None,
            concurrency=max(1, int(e.get("WORKER_CONCURRENCY", "1") or 1)),
            log_level=e.get("LOG_LEVEL", "info").upper(),
            models_dir=e.get("MODELS_DIR", "/models"),
            profiles_dir=e.get("FORM_PROFILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "form-profiles")),
            ollama_timeout_s=float(e.get("OLLAMA_TIMEOUT_S", "600") or 600),
            router_url=e.get("VIBE_AI_ROUTER_URL", "http://airouter-proxy:8220").rstrip("/"),
            router_token=e.get("VIBE_AI_TOKEN") or None,
        )
