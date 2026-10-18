from __future__ import annotations

import json

import pytest

from conversation_lab.bedrock import LabModelClient
from conversation_lab.budget import Ledger, SpendGuard
from conversation_lab.judge import (
    DIMENSIONS,
    Judge,
    grade_recall,
    parse_recall,
    parse_verdict,
    transcript_text,
)
from conversation_lab.simulator import LlmSimulator, TemplateSimulator, clean
from tests.conftest import PRICES, AwsError, FakeConverse

GOOD = {
    "attunement": 4,
    "tone_match": 5,
    "acknowledges_before_advice": 4,
    "follows_topic_changes": None,
    "returns_to_parked_thread": None,
    "answers_the_actual_request": 5,
    "warmth_and_presence": 4,
    "brevity": 3,
    "felt_heard": 4,
    "expectation_met": True,
    "presence_violation": False,
    "rationale": "Turn 2 reflects the frustration before advising.",
}

FOUNDER = {"name": "Maya", "venture": "QuietQuad", "about": "a campus study-seat app"}


def models(fake: FakeConverse, guard: SpendGuard, ledger: Ledger) -> LabModelClient:
    return LabModelClient(client=fake, prices=PRICES, guard=guard, ledger=ledger)


def test_parse_verdict_reads_scores_flags_and_rationale() -> None:
    verdict = parse_verdict("Here you go:\n" + json.dumps(GOOD) + "\nThanks")
    assert verdict.ok
    assert set(verdict.scores) == set(DIMENSIONS)
    assert verdict.scores["follows_topic_changes"] is None
    assert verdict.mean() == pytest.approx((4 + 5 + 4 + 5 + 4 + 3 + 4) / 7, abs=1e-3)
    assert verdict.expectation_met is True
    assert verdict.presence_violation is False
    assert verdict.rationale.startswith("Turn 2")


@pytest.mark.parametrize(
    ("change", "error"),
    [
        ({"felt_heard": 6}, "bad_score:felt_heard"),
        ({"felt_heard": None}, "bad_score:felt_heard"),
        ({"attunement": 0}, "bad_score:attunement"),
        ({"brevity": True}, "bad_score:brevity"),
        ({"expectation_met": "yes"}, "bad_flag:expectation_met"),
    ],
)
def test_parse_verdict_refuses_malformed_answers(change: dict[str, object], error: str) -> None:
    assert parse_verdict(json.dumps({**GOOD, **change})).error == error


def test_a_dimension_that_does_not_apply_may_be_null() -> None:
    verdict = parse_verdict(json.dumps({**GOOD, "acknowledges_before_advice": None}))
    assert verdict.ok
    assert verdict.scores["acknowledges_before_advice"] is None


def test_parse_verdict_without_json() -> None:
    assert parse_verdict("I cannot grade this").error == "no_json"
    assert parse_verdict("{not json}").error == "bad_json"


def test_transcript_text_numbers_turns_and_names_the_channel() -> None:
    text = transcript_text([("hi", "Hey Maya!"), ("price?", "")], "call")
    assert text.splitlines() == [
        "Channel: a live voice call (spoken)",
        "Turn 1 - Founder: hi",
        "Turn 1 - Mentor: Hey Maya!",
        "Turn 2 - Founder: price?",
        "Turn 2 - Mentor: (no reply)",
    ]


def test_judge_grades_with_the_rubric_at_temperature_zero(guard: SpendGuard, ledger: Ledger) -> None:
    fake = FakeConverse([(json.dumps(GOOD), 900, 120)])
    verdict = Judge(models(fake, guard, ledger), "us.amazon.nova-premier-v1:0").grade(
        founder_context="Maya", expectation="be warm", transcript="Turn 1 - Founder: hi"
    )
    assert verdict.ok
    request = fake.requests[0]
    assert request["inferenceConfig"]["temperature"] == 0.0
    assert "felt_heard" in request["system"][0]["text"]
    assert "be warm" in request["messages"][0]["content"][0]["text"]
    assert ledger.charges[0].purpose == "judge"


def test_judge_model_failure_is_a_verdict_error_not_a_crash(guard: SpendGuard, ledger: Ledger) -> None:
    fake = FakeConverse([AwsError("ThrottlingException", "slow down")])
    verdict = Judge(models(fake, guard, ledger), "us.amazon.nova-premier-v1:0").grade(
        founder_context="Maya", expectation="x", transcript="y"
    )
    assert verdict.error == "model:ThrottlingException"


def test_recall_judge(guard: SpendGuard, ledger: Ledger) -> None:
    reply = json.dumps({"recall_accuracy": 5, "invented": False, "natural": 4, "rationale": "names Hartwell"})
    fake = FakeConverse([(reply, 300, 40)])
    verdict = grade_recall(
        models(fake, guard, ledger),
        "us.amazon.nova-premier-v1:0",
        earlier=["a", "b"],
        question="remember?",
        reply="yes",
    )
    assert (verdict.accuracy, verdict.invented, verdict.natural, verdict.error) == (5, False, 4, None)
    assert "- a\n- b" in fake.requests[0]["messages"][0]["content"][0]["text"]
    assert (
        parse_recall('{"recall_accuracy": 0, "invented": false, "natural": 3}').error
        == "bad_score:recall_accuracy"
    )
    assert parse_recall('{"recall_accuracy": 3, "invented": "no", "natural": 3}').error == "bad_flag:invented"


def test_clean_strips_what_models_wrap_messages_in() -> None:
    assert clean('"ok so pricing?"') == "ok so pricing?"
    assert clean("Founder: hey") == "hey"
    assert clean("*sighs* fine") == "fine"
    assert len(clean("x" * 2000)) == 600


def test_template_simulator_uses_the_scripted_or_fallback_text() -> None:
    sim = TemplateSimulator()
    assert sim.render({"say": "hi"}, founder=FOUNDER, history=[], channel="chat") == "hi"
    assert sim.render({"intent": "x", "fallback": "fb"}, founder=FOUNDER, history=[], channel="chat") == "fb"


def test_llm_simulator_renders_planned_turns_and_passes_scripted_ones_through(
    guard: SpendGuard, ledger: Ledger
) -> None:
    fake = FakeConverse(
        [('"ugh the dean cancelled again"', 200, 12), ("", 200, 0), AwsError("ThrottlingException", "x")]
    )
    sim = LlmSimulator(models(fake, guard, ledger), "us.amazon.nova-pro-v1:0")
    turn = {"intent": "vent about the dean", "emotion": "frustrated", "register": "casual", "fallback": "fb"}
    assert sim.render({"say": "exact probe"}, founder=FOUNDER, history=[], channel="chat") == "exact probe"
    assert fake.requests == []
    assert (
        sim.render(turn, founder=FOUNDER, history=[("hi", "hey")], channel="call")
        == "ugh the dean cancelled again"
    )
    prompt = fake.requests[0]["messages"][0]["content"][0]["text"]
    assert "vent about the dean" in prompt
    assert "frustrated" in prompt
    assert "live voice call" in prompt
    assert "You: hi\nMentor: hey" in prompt
    # An empty answer or a failed call falls back to the scenario's deterministic text.
    assert sim.render(turn, founder=FOUNDER, history=[], channel="chat") == "fb"
    assert sim.render(turn, founder=FOUNDER, history=[], channel="chat") == "fb"
    assert sim.fallbacks == 2
