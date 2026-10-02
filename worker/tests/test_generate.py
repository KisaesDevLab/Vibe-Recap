"""Script generation with a stub language model: prompt facts, retry loop, and the hard gate."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from recap.script.generate import build_facts, build_observation_facts, generate, render_prompt
from recap.script.ollama import ChatResult, strip_think

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
GOLDEN = FIXTURES / "scripts"


def extraction(case: str, software: str = "ultratax") -> dict:
    return json.loads((FIXTURES / f"{software}-1040-2025-{case}.expected.json").read_text())


class StubModel:
    """Answers with a queue of canned scripts; records what it was asked."""

    def __init__(self, answers: list[str], finish_reason: str | None = None):
        self.answers = list(answers)
        self.finish_reason = finish_reason
        self.calls: list[list[dict]] = []

    def chat(self, messages, **_):
        self.calls.append([dict(m) for m in messages])
        text = self.answers.pop(0)
        return ChatResult(content=text, model="stub", eval_count=1, prompt_eval_count=1, total_ms=5, finish_reason=self.finish_reason)


def test_prompt_lists_only_extracted_facts():
    ex = extraction("mfj-refund-mo")
    facts = build_facts(ex)
    assert "Total income: $153,800" in facts
    assert "REFUND: $3,747" in facts
    assert not any("BALANCE DUE" in f for f in facts)
    assert "MO state REFUND: $590" in facts
    obs = build_observation_facts(ex)
    assert any("$7,500" in o and "5.4%" in o for o in obs)
    user = render_prompt("user", ex, {"firm_name": "Test CPA", "signoff_sentence": "See you soon."}, "mention the new rental")
    assert "GREETING NAMES: Alex and Jordan" in user
    assert "mention the new rental" in user
    assert "See you soon." in user
    system = render_prompt("system", ex, {"firm_name": "Test CPA"}, None)
    assert system.startswith("/no_think")
    assert "[[slide:greeting]]" in system and "Test CPA" in system


def test_generic_greeting_setting_removes_names():
    ex = extraction("mfj-refund-mo")
    user = render_prompt("user", ex, {"greeting_use_first_names": False}, None)
    assert "GREETING NAMES: (none" in user


def test_generate_accepts_golden_on_first_try():
    ex = extraction("single-owed-itemized")
    model = StubModel([(GOLDEN / "single-owed-itemized.md").read_text(encoding="utf-8")])
    script, attempts = generate(ex, {}, None, model)
    assert attempts == [dict(a, ms=5) for a in attempts] and len(attempts) == 1 and attempts[0]["ok"]
    assert script.startswith("[[slide:greeting]]")


def test_generate_feeds_validator_errors_back_and_retries():
    ex = extraction("hoh-refund-two-states")
    good = (GOLDEN / "hoh-refund-two-states.md").read_text(encoding="utf-8")
    bad = good.replace("$4,900", "$4,950")  # invented number
    model = StubModel(["<think>let me write</think>" + bad, good])
    script, attempts = generate(ex, {}, None, model)
    assert len(attempts) == 2 and not attempts[0]["ok"] and attempts[1]["ok"]
    assert any("$4,950" in e for e in attempts[0]["errors"])
    # the second call carried the rejected script and the validator's message
    second = model.calls[1]
    assert second[-2]["role"] == "assistant" and "$4,950" in second[-2]["content"]
    assert second[-1]["role"] == "user" and "rejected by the validator" in second[-1]["content"]
    assert script == good.strip()


def test_generate_gives_up_after_three_attempts():
    ex = extraction("hoh-refund-two-states")
    bad = (GOLDEN / "hoh-refund-two-states.md").read_text(encoding="utf-8").replace("$4,900", "$4,950")
    model = StubModel([bad, bad, bad, bad])
    with pytest.raises(ValueError, match="after 3 attempts"):
        generate(ex, {}, None, model)
    assert len(model.calls) == 3


def test_truncated_output_is_reported_as_truncation_not_a_short_script():
    ex = extraction("hoh-refund-two-states")
    cut = (GOLDEN / "hoh-refund-two-states.md").read_text(encoding="utf-8")[:400]
    model = StubModel([cut, cut, cut], finish_reason="length")
    with pytest.raises(ValueError, match=r"after 3 attempts: output cut off at the token limit"):
        generate(ex, {}, None, model)


def test_capture_records_each_call_as_sent_and_the_raw_reply():
    ex = extraction("hoh-refund-two-states")
    good = (GOLDEN / "hoh-refund-two-states.md").read_text(encoding="utf-8")
    bad = good.replace("$4,900", "$4,950")
    model = StubModel([bad, good])
    capture: list[dict] = []
    generate(ex, {}, None, model, capture=capture)
    assert [c["attempt"] for c in capture] == [1, 2] and [c["ok"] for c in capture] == [False, True]
    # each record holds the conversation exactly as that call received it, and the raw reply
    assert capture[0]["request"] == model.calls[0] and capture[1]["request"] == model.calls[1]
    assert [m["role"] for m in capture[0]["request"]] == ["system", "user"]
    assert capture[0]["response"] == bad and capture[1]["response"] == good
    assert any("$4,950" in e for e in capture[0]["errors"]) and capture[0]["model"] == "stub"


def test_no_capture_list_means_nothing_is_recorded():
    ex = extraction("single-owed-itemized")
    model = StubModel([(GOLDEN / "single-owed-itemized.md").read_text(encoding="utf-8")])
    script, attempts = generate(ex, {}, None, model)  # default capture=None must not fail or record
    assert attempts[0]["ok"] and "request" not in attempts[0]


def test_strip_think_handles_unterminated_blocks():
    assert strip_think("<think>a</think>hello") == "hello"
    assert strip_think("hello<think>ran out") == "hello"
