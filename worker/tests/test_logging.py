import json
import logging

from recap.logging import JsonFormatter, RedactingAdapter, _redact


def test_redacts_pii_keys_recursively():
    out = _redact({"job_id": "j1", "taxpayer": {"first_name": "Ann"}, "meta": {"amount": 5, "sha256": "abc"}})
    assert out == {"job_id": "j1", "taxpayer": "[redacted]", "meta": {"amount": "[redacted]", "sha256": "abc"}}


def test_adapter_redacts_extra_fields():
    logger = logging.getLogger("t")
    logger.handlers.clear()
    records = []
    h = logging.Handler()
    h.emit = records.append  # type: ignore[assignment]
    logger.addHandler(h)
    logger.setLevel(logging.INFO)
    RedactingAdapter(logger, {}).info("hello", extra={"job_id": "j", "name": "Ann"})
    line = JsonFormatter().format(records[0])
    data = json.loads(line)
    assert data["job_id"] == "j"
    assert data["name"] == "[redacted]"
    assert "Ann" not in line
