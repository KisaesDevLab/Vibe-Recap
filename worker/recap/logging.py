"""Structured, PII-redacting logger.

Redaction happens in the logger, not by convention: any record field whose key
is on the deny list is replaced before it is written, so a careless log call
cannot leak a name, SSN, or dollar amount. Log job ids and sha256 hashes.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

REDACT_KEYS = {
    "name", "first_name", "last_name", "spouse_first_name", "taxpayer", "ssn", "ein",
    "email", "address", "amount", "amounts", "income", "payments", "result", "extraction",
    "script", "note", "notes", "text", "words", "password", "passphrase",
}


def _redact(value: Any, key: str | None = None) -> Any:
    if key is not None and key.lower() in REDACT_KEYS:
        return "[redacted]"
    if isinstance(value, dict):
        return {k: _redact(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(v) for v in value]
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + "Z",
            "level": record.levelname.lower(),
            "service": "recap-worker",
            "msg": record.getMessage(),
            "logger": record.name,
        }
        extra = getattr(record, "extra", None)
        if isinstance(extra, dict):
            payload.update(_redact(extra))
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class RedactingAdapter(logging.LoggerAdapter):
    """Usage: log.info("msg", extra={"job_id": ...}). Deny-listed keys are redacted."""

    def process(self, msg: str, kwargs: Any) -> tuple[str, Any]:
        extra = kwargs.pop("extra", None) or {}
        merged = {**(self.extra or {}), **extra}
        kwargs["extra"] = {"extra": _redact(merged)}
        return msg, kwargs


def configure(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)
    logging.getLogger("pdfminer").setLevel(logging.ERROR)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def get_logger(name: str, **context: Any) -> RedactingAdapter:
    return RedactingAdapter(logging.getLogger(name), context)
