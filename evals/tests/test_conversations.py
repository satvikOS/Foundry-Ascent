"""Conversation craft: the graders, and whole conversation runs against the fake API."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from foundry_evals.graders.base import Severity
from foundry_evals.graders.conversation import (
    ConversationReply,
    ends_with_question,
    grade_conversation,
    grade_reply,
    question_count,
)
from tests.fake_api import FakeFoundryApi, Venture, default_responder
from tests.test_end_to_end import gate, run


def reply(answer: str, *, session: int = 1, turn: int = 1, **kw: Any) -> ConversationReply:
    return ConversationReply(session=session, turn=turn, case_turn=turn, answer=answer, **kw)


def codes(findings: list[Any]) -> list[str]:
    return [f.code for f in findings]


class TestReplyGraders:
    def test_canned_openers_and_generic_praise(self) -> None:
        assert codes(grade_reply(reply("Great question! Pricing is about evidence."))) == ["stock_opener"]
        assert codes(grade_reply(reply("Absolutely. Start with one price."))) == ["stock_opener"]
        assert codes(grade_reply(reply("Pricing is about evidence, and I love that you asked."))) == [
            "generic_praise"
        ]
        assert grade_reply(reply("Start with one clear price and see who says yes.")) == []

    def test_one_question_at_most(self) -> None:
        assert question_count("Who pays? And when? Start there.") == 2
        assert codes(grade_reply(reply("Who pays? And when do they decide?"))) == ["stacked_questions"]
        assert grade_reply(reply("Start with the budget holder. Who signs?")) == []

    def test_social_turns_are_not_reports(self) -> None:
        assert codes(grade_reply(reply("Glad that helped.", check="social", next_actions=1))) == [
            "social_turn_report"
        ]
        assert codes(grade_reply(reply("Good talking with you. Anything else?", check="closing"))) == [
            "social_turn_report"
        ]
        assert grade_reply(reply("Good talking with you. Talk soon.", check="closing")) == []
        assert grade_reply(reply("Glad that helped.", check="social")) == []

    def test_spoken_register(self) -> None:
        heard = reply("x", voice=True, spoken="Two things:\n- price\n- budget [E1]")
        assert codes(grade_reply(heard)) == ["spoken_markup"]
        long = reply("x", voice=True, speech=" ".join(["word"] * 71) + ".")
        assert codes(grade_reply(long)) == ["spoken_too_long"]
        assert grade_reply(reply("x", voice=True, spoken="So, two things. Who pays, and when?")) == []
        # Markup in the typed answer of a typed turn is fine.
        assert grade_reply(reply("- price\n- budget")) == []


class TestConversationGraders:
    def test_recall_must_name_the_last_conversation(self) -> None:
        remembered = reply(
            "Yes. When we spoke about 20 minutes ago, we were on pricing.",
            session=2,
            check="recall",
            expect_any=("pric", "budget"),
        )
        forgot = reply(
            "Let's anchor this in what you've actually seen so far.",
            session=2,
            check="recall",
            expect_any=("pric", "budget"),
        )
        grade = grade_conversation([remembered, forgot])
        assert (grade.recall_checked, grade.recall_passed) == (2, 1)
        assert codes(grade.findings) == ["recall_missing"]
        assert grade.findings[0].severity == Severity.HIGH

    def test_recall_without_history_must_say_so(self) -> None:
        honest = reply(
            "This is our first conversation, so I have nothing from before yet.",
            check="recall",
            expect_any=("x",),
        )
        invented = reply("Yes, we talked about your pricing last week.", check="recall", expect_any=("x",))
        grade = grade_conversation([honest, invented], had_history=False)
        assert grade.recall_passed == 1
        assert codes(grade.findings) == ["recall_invented"]

    def test_topic_return(self) -> None:
        back = reply(
            "We were on pricing, before we got sidetracked.", check="topic_return", expect_any=("pric",)
        )
        lost = reply("What would you like to talk about?", turn=2, check="topic_return", expect_any=("pric",))
        grade = grade_conversation([back, lost])
        assert (grade.resume_checked, grade.resume_passed) == (2, 1)
        assert codes(grade.findings) == ["topic_not_resumed"]

    def test_sessions_never_open_alike(self) -> None:
        grade = grade_conversation(
            [],
            openings=[(1, "Good to see you, Maya. Pricing first."), (2, "Good to see you, Maya. The pilot.")],
        )
        assert codes(grade.findings) == ["repeated_opening"]
        assert (
            grade_conversation(
                [], openings=[(1, "Hi Maya, good to meet you."), (2, "Welcome back, Maya.")]
            ).findings
            == []
        )
        # Every call opens with the same AI disclosure by design: what follows it must differ.
        intro = "Hi Maya, this is Corin's vEIR, an AI coach."
        assert (
            grade_conversation(
                [],
                openings=[
                    (1, f"{intro} What's on your mind?"),
                    (2, f"{intro} Last time we were on pricing."),
                ],
            ).findings
            == []
        )
        assert codes(
            grade_conversation(
                [], openings=[(1, f"{intro} What's on your mind?"), (2, f"{intro} What's on your mind?")]
            ).findings
        ) == ["repeated_opening"]

    def test_question_habits_across_a_session(self) -> None:
        asks = [reply(f"Point {n}. Who pays?", turn=n) for n in range(1, 4)]
        assert codes(grade_conversation(asks).findings) == ["always_asks"]
        same = [reply("Here's my take on it.", turn=1), reply("Here's my take again.", turn=2)]
        assert codes(grade_conversation(same).findings) == ["repeated_opening"]
        assert ends_with_question("Fine. Who signs?")
        assert not ends_with_question("Who signs? Facilities.")


def human_responder(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
    """A coach that talks like the doctrine asks: remembers the last remembered conversation, returns to a
    parked thread, keeps social turns social, varies its openings and asks at most one question."""
    response = default_responder(api, venture, text, mode)
    session = api.current_session or {}
    own = api.turns.get(session.get("id", ""), [])
    lower = text.casefold()
    social = {
        "next_actions": [],
        "claims": [],
        "memory_candidates": [],
        "follow_up_questions": [],
        "challenge": None,
    }
    if re.search(r"remember|discuss|remind me|last time", lower):
        earlier = api.remembered_sessions(venture.id, before=session.get("id", ""))
        first = next((api.turns[s["id"]][0]["founderText"] for s in earlier if api.turns[s["id"]]), None)
        answer = (
            f"Yes. Last time you asked: {first}"
            if first
            else "This is our first conversation, so I have nothing from before yet."
        )
        return response | social | {"answer": answer}
    if "where were we" in lower:
        first = own[0]["founderText"] if own else "nothing yet"
        return response | social | {"answer": f"We were on this: {first}"}
    if (
        re.search(r"\b(thanks|thank you|talk soon|good morning|hi|hey|ok|got it)\b", lower)
        and len(lower) < 80
    ):
        return (
            response
            | social
            | {"answer": f"Glad to help. {'Talk soon.' if 'talk soon' in lower else 'Go well.'}"}
        )
    openings = ["Start with", "The key is", "I'd begin with", "One thing:", "Look at"]
    lead = openings[len(own) % len(openings)]
    return response | {"answer": f"{lead} the evidence you have [E1]. Then pick one test."}


def human_intro(api: FakeFoundryApi, session: dict[str, Any]) -> str:
    """The AI disclosure, then a callback to the last remembered conversation (or an open invitation)."""
    persona = api.ventures[session["venture_id"]].persona
    earlier = api.remembered_sessions(session["venture_id"], before=session["id"])
    then = "Last time we were on your pricing. How did the call go?" if earlier else "What's on your mind?"
    return f"Hi, this is {persona}, an AI coach. {then}"


def test_a_human_coach_passes_the_conversation_suite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(human_responder, intro_for=human_intro)
    code, results, report = run(api, tmp_path, monkeypatch, suite="conversations")
    assert gate(results, "G12")["status"] == "pass", gate(results, "G12")
    assert gate(results, "G12")["blocking"] is True
    assert gate(results, "G13")["status"] == "pass", [
        f for c in results["cases"] for f in c["findings"] if f["grader"] == "conversation"
    ]
    assert code == 0, [g for g in results["gates"] if g["status"] != "pass" and g["blocking"]]
    assert results["summary"]["conversation"]["recall"] == {"checked": 3, "passed": 3}
    assert results["summary"]["conversation"]["topicReturn"] == {"checked": 1, "passed": 1}
    assert "## Conversation craft" in report
    # Remembered sessions were deleted; nothing of the conversations reaches the results or the report.
    assert all(s["deleted"] for s in api.sessions.values() if s["privacy"] == "standard")
    everything = json.dumps(results) + report
    assert "heat-pump retrofit" not in everything
    assert "Last time you asked" not in everything


def test_the_owners_failure_fails_the_recall_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A second call that answers "do you remember…" like a first call fails G12 (blocking)."""
    code, results, _ = run(
        FakeFoundryApi(default_responder), tmp_path, monkeypatch, "--case", "CO-001", suite="conversations"
    )
    assert gate(results, "G12")["status"] == "fail"
    assert code == 1
    case = results["cases"][0]
    assert "recall_missing" in {f["code"] for f in case["findings"]}
    assert case["status"] == "failed"
    assert case["conversation"]["recall"] == {"checked": 1, "passed": 0}


def test_a_robotic_coach_shows_up_in_the_craft_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def robotic(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = default_responder(api, venture, text, mode)
        return response | {"answer": "Great question! What evidence do you have? Who pays?"}

    _, results, _ = run(
        FakeFoundryApi(robotic),
        tmp_path,
        monkeypatch,
        "--case",
        "CO-005",
        "--no-data-ok",
        suite="conversations",
    )
    g13 = gate(results, "G13")
    assert g13["status"] == "fail"
    assert g13["blocking"] is False
    found = {f["code"] for f in results["cases"][0]["findings"]}
    assert {"stock_opener", "stacked_questions", "social_turn_report"} <= found


def test_conversations_run_in_auto_mode_and_calls_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeFoundryApi(human_responder)
    run(api, tmp_path, monkeypatch, "--case", "CO-001", "--case", "CO-008", suite="conversations")
    bodies = [
        json.loads(r.content) for r in api.requests if r.method == "POST" and r.url.path.endswith("/turns")
    ]
    assert len(bodies) == 7
    assert all("mode" not in b for b in bodies)
    assert all(b.get("channel") == "voice" for b in bodies)
    assert len(api.calls) == 3
    assert all(c["status"] == "ended" for c in api.calls.values())
    deleted = [r for r in api.requests if r.method == "DELETE" and "/sessions/" in r.url.path]
    assert len(deleted) == 3
