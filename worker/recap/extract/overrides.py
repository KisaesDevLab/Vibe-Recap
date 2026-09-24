"""Preparer overrides of extracted figures (Q66).

When the profile misreads a line and the firm cannot wait for a profile fix, a preparer enters the
figure from the return with a reason. The API stores it in `extraction_overrides`; the worker
applies every active override after the mapper and before observations and recon, so recon, the
effective rate and the observations all see the corrected figure. The extraction records each
override next to the value the mapper read (`overrides`), and `evidence` says where on the PDF the
mapper found each figure, so the override log tells profile work which rule misread which row.

Overrides never loosen the later gates: `validate` checks the script against the corrected
extraction, and `verify` still traces every amount in the script to the uploaded PDF itself.
"""

from __future__ import annotations

import re
from typing import Any

SECTIONS = ("income", "adjustments", "deductions", "tax", "payments", "result", "extras", "prior_year")
STATE_FIELDS = ("taxable_income", "tax", "payments", "refund", "amount_owed", "penalty")
# Fields that are facts or computed, never figures a preparer types in.
NOT_OVERRIDABLE = {"deductions.type", "tax.effective_rate", "prior_year.present", "prior_year.source", "extras.has_form_2210"}
STATE_PATH_RE = re.compile(r"^state\.([A-Z]{2})\.(" + "|".join(STATE_FIELDS) + r")$")


def is_overridable(path: str) -> bool:
    if path in NOT_OVERRIDABLE:
        return False
    if STATE_PATH_RE.match(path):
        return True
    parts = path.split(".")
    return len(parts) == 2 and parts[0] in SECTIONS and re.fullmatch(r"[a-z_0-9]+", parts[1]) is not None


def get_value(doc: dict[str, Any], path: str) -> int | None:
    m = STATE_PATH_RE.match(path)
    if m:
        st = next((s for s in doc.get("state", []) if s.get("code") == m.group(1)), None)
        v = st.get(m.group(2)) if st else None
    else:
        section, key = path.split(".", 1)
        v = (doc.get(section) or {}).get(key)
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _set_value(doc: dict[str, Any], path: str, value: int) -> None:
    m = STATE_PATH_RE.match(path)
    if m:
        code, key = m.groups()
        st = next((s for s in doc.setdefault("state", []) if s.get("code") == code), None)
        if st is None:
            # A state the page grouping missed entirely: the override brings it into the extraction.
            st = {"code": code, **{f: 0 for f in STATE_FIELDS}}
            doc["state"].append(st)
            doc.setdefault("meta", {}).setdefault("state_returns", []).append(code)
        st[key] = value
        return
    section, key = path.split(".", 1)
    doc.setdefault(section, {})[key] = value
    if section == "prior_year":
        doc["prior_year"]["present"] = True
        doc["prior_year"].setdefault("source", "override")


def apply_overrides(doc: dict[str, Any], overrides: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply active overrides in place; return the record kept in the extraction as `overrides`.

    Each record keeps the value the mapper read (`extracted`, None when the line was not found) so
    the extraction shows both, and `matches_extracted` flags an override a later profile fix made
    redundant. Paths that are not overridable are skipped and reported as `ignored`.
    """
    applied: list[dict[str, Any]] = []
    for ov in overrides:
        path = str(ov.get("path") or "")
        value = ov.get("value")
        rec: dict[str, Any] = {"id": str(ov.get("id") or ""), "path": path}
        if not is_overridable(path) or not isinstance(value, int) or isinstance(value, bool):
            applied.append({**rec, "ignored": True})
            continue
        extracted = get_value(doc, path)
        _set_value(doc, path, value)
        applied.append({**rec, "extracted": extracted, "value": value, "matches_extracted": extracted == value})
    return applied
