"""Suite agenda: the deterministic checks of a reply, the per-channel summary and the conversation runner."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from conversation_lab.agenda import (
    ConversationResult,
    check_reply,
    grade_conversation,
    load,
    run_channel,
    summarize,
)
from conversation_lab.config import suites_for

HELP = {"topic": "agenda", "help": True}
OTHER = {"topic": "other", "help": True}
ASK_BACK = "What three questions do you want answered in the advisor session?"


def test_a_question_back_is_no_help_and_a_draft_is() -> None:
    back, _ = check_reply(ASK_BACK, HELP, 2, [])
    assert back.question_back_only
    assert not back.substance
    drafted, asked = check_reply(
        "Here are three to start with. 1. Is the sleeve a medical device, and in which class? "
        "2. Which clinic billing codes could cover remote monitoring? 3. What evidence would a first clinic need?",
        HELP,
        3,
        [],
    )
    assert drafted.substance
    assert not drafted.question_back_only
    assert len(asked) == 3
    steps, _ = check_reply(
        "Start with the device question, because everything else depends on it. Write down what the sleeve "
        "measures and who acts on it. Then list the two clinics you'd pilot with.",
        HELP,
        4,
        [],
    )
    assert steps.substance


def test_steering_back_re_asking_stale_and_so_openings() -> None:
    steer, _ = check_reply("Before the pitch, have you booked the advisor session yet?", OTHER, 1, [])
    assert steer.steer_back
    on_topic, _ = check_reply("For a five-minute pitch, lead with the patient story.", OTHER, 1, [])
    assert not on_topic.steer_back
    again, _ = check_reply(
        "Which three questions do you want answered in that advisor session?", HELP, 3, [ASK_BACK]
    )
    assert again.reask
    stale, _ = check_reply("Your advisor session is still open from last time.", HELP, 1, [])
    assert stale.stale
    fragment, _ = check_reply("So the pitch competition is coming up.", OTHER, 1, [])
    assert fragment.so_opening
    assert fragment.statements == 1
    assert not fragment.substance


def test_following_up_when_the_founder_raises_it() -> None:
    raised = {"topic": "agenda", "raises": True}
    asked, _ = check_reply(
        "Good that it happened. How did it go, and what did they say about clearance?", raised, 1, []
    )
    assert asked.follows_up
    ignored, _ = check_reply("Great. What are your three questions for the advisor?", raised, 1, [])
    assert not ignored.follows_up


def test_a_conversation_grades_and_summarizes() -> None:
    suite = load()
    conversation = suite["conversations"][0]
    result = ConversationResult(
        id="AG-1-call", channel="call", opener="Did you manage to book the advisor session?"
    )
    result.turns = [
        ("Hey. I've got a bit of time today.", ASK_BACK),
        ("I don't know. You tell me.", ASK_BACK),
        (
            "That's the thing, I don't know. You tell me what I should ask.",
            "So the advisor session is still open.",
        ),
        ("idk I'm blank, help me get started, I'm writing it all down.", "So what's your first question?"),
    ]
    grade_conversation(result, conversation)
    assert result.opener_reopens
    assert "t2:no_substance" in result.failures
    assert "t2:question_back_only" in result.failures
    assert "t2:reask" in result.failures
    assert "t3:stale_commitment" in result.failures
    assert not result.passed
    numbers = summarize([result])
    assert numbers["call"]["helpTurns"] == 3
    assert numbers["call"]["substanceOnRequest"] == 0
    assert numbers["call"]["soOpenings"] == 2
    assert numbers["all"]["openersReopeningCommitment"] == 1
    assert "transcript" not in result.public()
    assert "transcript" in result.private()


@dataclass
class _Session:
    id: str
    opener: str | None


@dataclass
class _Unit:
    text: str


@dataclass
class _Call:
    id: str


@dataclass
class _Started:
    call: _Call
    intro: _Unit | None


@dataclass
class _Outcome:
    text: str
    kind: str = "completed"
    error_code: str | None = None
    turn: Any = None
    speech: list[str] = field(default_factory=list)
    phases: list[str] = field(default_factory=list)


class _Client:
    def __init__(self) -> None:
        self.ended: list[str] = []
        self.calls_ended: list[str] = []
        self.n = 0

    def create_session(self, venture_id: str, *, mode: str, privacy: str) -> _Session:
        assert privacy == "standard"  # remembered: the notebook and the last conversation are loaded
        self.n += 1
        return _Session(f"s{self.n}", "Did you book the advisor session?")

    def start_call(self, session_id: str) -> _Started:
        return _Started(_Call(f"c-{session_id}"), _Unit("Hi Idris. Did you book the advisor session?"))

    def run_turn(self, session_id: str, text: str, *, call_id: str | None = None) -> _Outcome:
        return _Outcome(
            f"Here is something useful about that. And a second sentence with content. ({text[:5]})"
        )

    def end_call(self, call_id: str) -> None:
        self.calls_ended.append(call_id)

    def end_session(self, session_id: str) -> None:
        self.ended.append(session_id)
        self.version += 1  # distilled

    version = 1

    def request(self, method: str, path: str) -> Any:
        version = self.version

        class _Response:
            def json(self) -> dict[str, Any]:
                return {
                    "version": version,
                    "nextTopic": "the advisor session",
                    "commitments": [{"status": "open"}],
                }

        return _Response()


def test_the_runner_plays_remembered_conversations_in_order_and_ends_each() -> None:
    client = _Client()
    reserved: list[int] = []
    slept: list[float] = []
    suite = load()
    results = run_channel(
        client=client,
        venture_id="v",
        channel="call",
        conversations=suite["conversations"],
        heard=lambda outcome, voice: outcome.text,
        judge=None,
        founder_context="Idris",
        reserve=reserved.append,
        sleep=slept.append,
    )
    assert [r.id for r in results] == ["AG-1-call", "AG-2-call", "AG-3-call"]
    assert client.ended == ["s1", "s2", "s3"]
    assert client.calls_ended == ["c-s1", "c-s2", "c-s3"]
    assert reserved == [len(c["turns"]) for c in suite["conversations"]]
    assert slept  # waits for each conversation's distillation
    assert results[0].notebook_before == {
        "version": 1,
        "updatedAt": None,
        "nextOpener": None,
        "nextTopic": "the advisor session",
        "commitments": [{"status": "open"}],
        "openQuestions": None,
        "summary": None,
    }
    assert results[1].notebook_before["version"] == 2
    assert results[0].public()["notebookBefore"] == {"version": 1, "hasNextTopic": True, "openCommitments": 1}
    assert (
        results[0].founder_took_up_opener is False
    )  # the fake opener names the session, the founder never does
    assert results[0].opener.startswith("Hi Idris")
    assert all(r.checks for r in results)
    assert len(results[0].details) == len(suite["conversations"][0]["turns"])
    assert results[0].public()["notes"] == [[], [], [], []]
    assert "details" in results[0].private()


def test_agenda_is_a_suite_of_its_own() -> None:
    assert suites_for("agenda") == ["agenda"]
    assert "agenda" not in suites_for("all")


def test_the_scenarios_cover_every_requested_founder_move() -> None:
    lines = [t["say"] for c in load()["conversations"] for t in c["turns"]]
    for needed in (
        "I don't know. You tell me.",
        "help me prepare for my pitch next week",
        "You tell me what I should ask.",
        "help me get started, I'm writing it all down",
        "make a lot of money",
        "My cofounder wants to quit his job",
        "I met the advisor last week",
    ):
        assert any(needed in line for line in lines), needed


def test_the_same_question_in_other_words_and_booking_what_already_happened() -> None:
    first = "What evidence do you have that clinics would buy the sleeve?"
    later, _ = check_reply(
        "Before you go full-time, what evidence can you get this month that clinics will buy the sleeve?",
        OTHER,
        3,
        [first],
    )
    assert later.reask
    different, _ = check_reply("What does your cofounder need to see before he jumps?", OTHER, 3, [first])
    assert not different.reask
    suite = load()
    result = ConversationResult(id="AG-3-call", channel="call", opener="")
    result.turns = [
        ("I met the advisor last week, actually.", "How did it go? What did they say?"),
        ("They said we might not need device clearance for the first version.", "That's useful."),
        (
            "So what should I do this week?",
            "Book the session and bring those questions. Then draft the pitch.",
        ),
    ]
    grade_conversation(result, suite["conversations"][2])
    assert "t3:stale_commitment" in result.failures
