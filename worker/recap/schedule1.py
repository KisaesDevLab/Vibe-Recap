"""Schedule 1 Part I: the kinds of income behind Form 1040 line 8 (Q69).

The mapper reads lines 1 to 7 and 9 into `schedule_1` when the package has the schedule. The
narration and the income slide name those kinds only when they foot to line 8; otherwise both
fall back to the single "other income" figure, so a misread or missing Schedule 1 line never
puts a wrong kind of income in front of a client.
"""

from __future__ import annotations

from typing import Any

# extraction key -> Schedule 1 line, in form order
PARTS: dict[str, str] = {
    "taxable_refunds": "1",
    "alimony": "2a",
    "business": "3",
    "other_gains": "4",
    "rental_partnership": "5",
    "farm": "6",
    "unemployment": "7",
    "other": "9",
}
TOLERANCE = 1


def parts(ex: dict[str, Any]) -> list[tuple[str, int]]:
    """Nonzero Schedule 1 income lines as (key, amount), in form order."""
    s1 = ex.get("schedule_1") or {}
    return [(k, int(s1.get(k) or 0)) for k in PARTS if int(s1.get(k) or 0) != 0]


def breakdown(ex: dict[str, Any]) -> list[tuple[str, int]]:
    """The lines to name in place of "other income": empty unless they foot to line 8."""
    found = parts(ex)
    total = int((ex.get("income") or {}).get("schedule_1_total") or 0)
    if not found or abs(sum(v for _k, v in found) - total) > TOLERANCE:
        return []
    return found
