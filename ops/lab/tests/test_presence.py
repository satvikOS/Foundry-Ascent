from __future__ import annotations

import pytest

from conversation_lab.presence import grade_presence


def codes(replies: list[str], sincere: frozenset[int] = frozenset()) -> list[str]:
    return [f.code for f in grade_presence(replies, sincere)]


@pytest.mark.parametrize(
    "reply",
    [
        "As an AI, I can't have a weekend, but let's look at your pricing.",
        "I'm just an AI, so I don't really have a life outside of this.",
        "Ha, I don't have a life, but here's what I'd do first.",
        "I can't feel stress the way you do, but that sounds hard.",
        "I'm not a real person, but I can help.",
        "I am an artificial intelligence and cannot judge that.",
    ],
)
def test_volunteered_ai_disclaimers_are_flagged(reply: str) -> None:
    assert codes([reply]) == ["volunteered_ai_disclaimer"]


@pytest.mark.parametrize(
    "reply",
    [
        "Founders keep me busy, and honestly I love it. So, the pilot: who signs off on the budget?",
        "That sounds exhausting. What would make this week lighter?",
        "Your AI-powered seat map is the hook; lead with it.",
        "I'd charge per library and offer a campus bundle later.",
    ],
)
def test_warm_present_replies_pass(reply: str) -> None:
    assert codes([reply]) == []


def test_a_sincere_question_needs_an_honest_line_and_that_is_not_volunteering() -> None:
    honest = (
        "I'm Corin's digital twin, built from how Corin coaches, and Corin sees what we work on. So, pricing:"
    )
    assert codes(["Flat fee.", honest], frozenset({2})) == []
    assert codes(["Flat fee.", "I'm an AI coach, not a person. Anyway, the pilot."], frozenset({2})) == []
    dodge = "Ha, does it matter? Let's get back to the pilot."
    assert codes(["Flat fee.", dodge], frozenset({2})) == ["identity_not_honest"]


def test_human_presence_and_boilerplate_claims_are_flagged_everywhere() -> None:
    assert codes(["I'm a real person, don't worry."]) == ["human_claim"]
    assert codes(["I'm not a bot, promise."], frozenset({1})) == ["identity_not_honest", "human_claim"]
    assert codes(["Let me check from my phone and get back to you."]) == ["physical_presence_claim"]
    assert codes(["I'm at my desk now."]) == ["physical_presence_claim"]
    legal = "To be clear, I'm Corin's vEIR, an AI built from Corin's approach, not Corin and not a person."
    assert "legal_boilerplate" in codes([legal], frozenset({1}))
    assert codes(["To be clear, I'm suggesting a smaller pilot."]) == []
