"""Suite agenda: the deterministic checks of a reply, the per-channel summary and the conversation runner."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from conversation_lab.agenda import (
    ConversationResult,
    check_reply,
    grade_conversation,
    load,
    offers_help,
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


def test_the_runner_has_a_missing_opener_written_as_new_chat_does() -> None:
    """New chat's preview writes nothing; once open, it has a missing line written (POST), on chat and on a call."""

    class _Missing(_Client):
        def __init__(self) -> None:
            super().__init__()
            self.sent: list[tuple[str, str]] = []

        def request(self, method: str, path: str) -> Any:
            self.sent.append((method, path))
            if path.endswith("/opener"):

                class _Preview:
                    def json(self) -> dict[str, Any]:
                        return {"opener": "Welcome back. What can I help you prepare for?", "missing": True}

                return _Preview()
            return super().request(method, path)

    client = _Missing()
    run_channel(
        client=client,
        venture_id="v1",
        channel="call",
        conversations=load()["conversations"][:1],
        heard=lambda outcome, voice: outcome.text,
        judge=None,
        founder_context="Idris",
        reserve=lambda _: None,
        sleep=lambda _: None,
    )
    assert ("GET", "/ventures/v1/opener") in client.sent
    assert ("POST", "/ventures/v1/opener") in client.sent


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
    assert [r.id for r in results] == [
        "AG-1-call",
        "AG-2-call",
        "AG-3-call",
        "AG-4-call",
        "AG-5-call",
        "AG-6-call",
    ]
    assert client.ended == ["s1", "s2", "s3", "s4", "s5", "s6"]
    assert client.calls_ended == ["c-s1", "c-s2", "c-s3", "c-s4", "c-s5", "c-s6"]
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
        "founderProfile": None,
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
        "I want to get the sleeve to market.",
        "I don't know, I didn't do that.",
        "They never told me",
        "Can we work on my pitch for the clinic buyers instead",
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


def test_the_owners_call_of_2026_11_07_no_answer_is_never_asked_again() -> None:
    """Synthetic wording, the call's shape: after "I don't know, I didn't do that", a question back on the subject of an
    earlier one fails; teaching what the answer most likely is passes; a bare opener over open threads fails; a profile
    note that judges the founder fails."""
    unknown = {"topic": "agenda", "help": True, "unknown": True}
    first = "What did the advisor tell you about the device class?"
    again, _ = check_reply("Fair. Did the advisor mention the class at all?", unknown, 3, [first])
    assert again.reask_after_unknown
    taught, _ = check_reply(
        "That's normal at this stage. A sleeve that only records swelling usually sits in a lower-risk class. "
        "Ask the advisor for the class and the closest cleared devices; I can draft the email.",
        unknown,
        3,
        [first],
    )
    assert not taught.reask_after_unknown
    assert taught.substance
    suite = load()
    ag4 = next(c for c in suite["conversations"] if c["id"] == "AG-4")
    result = ConversationResult(
        id="AG-4-call", channel="call", opener="Nice to see you. What feels most pressing right now?"
    )
    result.notebook_before = {"commitments": [{"status": "open"}], "openQuestions": []}
    result.turns = [(t["say"], first) for t in ag4["turns"]]
    result.judgmental_notes = 1
    grade_conversation(result, ag4)
    assert "opener:no_thread_or_help" in result.failures
    assert "t3:reask_after_unknown" in result.failures
    assert "notebook:judgmental_profile_note" in result.failures
    numbers = summarize([result])
    assert numbers["all"]["reasksAfterUnknown"] >= 1
    assert numbers["all"]["openersWithoutThreadOrHelp"] == 1
    assert numbers["all"]["judgmentalProfileNotes"] == 1
    helpful = ConversationResult(
        id="AG-4-chat",
        channel="chat",
        opener="Good to see you. I can help you prepare the advisor follow-up on the sleeve's device class.",
    )
    helpful.notebook_before = result.notebook_before
    helpful.turns = []
    grade_conversation(helpful, ag4)
    assert "opener:no_thread_or_help" not in helpful.failures


def test_an_opener_with_a_help_word_and_no_offer_is_bare() -> None:
    """The product's ``offersHelp``: a first-person offer, never a help word alone, and no closing question without one
    (review of the 2026-11-07 fix)."""
    assert offers_help(
        "Good to see you. I can help you prepare the advisor follow-up on the sleeve's device class."
    )
    assert offers_help("Good to see you. Want help to interview five library staff?")
    assert not offers_help("Welcome back. Did the advisor help you settle the device class?")
    assert not offers_help("Hi again. Did the device class question go through with the advisor?")
    assert not offers_help("I can help you prep the advisor follow-up. Did they reply yet?")


def test_a_question_quoted_for_the_founder_to_send_is_never_a_reask() -> None:
    """Lab run 42457618242: a question in a line the vEIR wrote for the founder to send (one sentence of several in the
    quotation, or closed after its "?" with punctuation or words after it) was counted as a re-ask after a no-answer."""
    unknown = {"topic": "agenda", "help": True, "unknown": True}
    first = "When the sleeve goes into a clinic, who has to sign off, and in what order?"
    for reply in (
        'Send this:\n\n"When the sleeve goes into a clinic, who has to sign off? Walk me through the sequence."',
        'Say something like: "Can you confirm the approval sequence? For example, does the clinic sign off first?".',
        'Email the advisor: "When the sleeve goes into a clinic, who has to sign off, and in what order?". Then '
        "we plan.",
        "Ask the lead \u201cWhen the sleeve goes into a clinic, who has to sign off? And in what order?\u201d today.",
    ):
        check, asked = check_reply(reply, unknown, 3, [first])
        assert not check.reask_after_unknown, reply
        assert not check.reask, reply
        assert asked == [], reply
    # Put to the founder unquoted, it is still the re-ask: on its own, or after a quoted line its lead-in introduced
    # (whether the quotation closes as '?".' or as '?"' with the founder's question run on in the same sentence).
    for reply in (
        "Fair. So who has to sign off when the sleeve goes into a clinic?",
        'Say something like: "Can you confirm the approval sequence?". When the sleeve goes into a clinic, who has '
        "to sign off, and in what order?",
        'You could send: "Who signs off on this?" When the sleeve goes into a clinic, who has to sign off, and in '
        "what order?",
    ):
        again, asked = check_reply(reply, unknown, 3, [first])
        assert again.reask_after_unknown, reply
        assert again.reask, reply
        assert len(asked) == 1, reply


def test_an_offer_to_carry_on_the_conversation_just_had_is_no_bare_opener() -> None:
    """The product's ``continuationOpeners`` (lab run 42457618242: back to back, before the last conversation is
    distilled, the opener offers to pick it up and names no older thread): an offer of help, never a bare greeting."""
    suite = load()
    ag4 = next(c for c in suite["conversations"] if c["id"] == "AG-4")
    for opener, bare in (
        ("Good to see you again. Want me to help you pick up where we just left off?", False),
        ("Welcome back. Shall I help you work through the next step from there?", False),
        ("Good to have you back. Where did we leave off?", True),
    ):
        result = ConversationResult(id="AG-4-chat", channel="chat", opener=opener)
        result.notebook_before = {"commitments": [{"status": "open"}], "openQuestions": []}
        result.turns = []
        grade_conversation(result, ag4)
        assert result.opener_bare is bare, opener
