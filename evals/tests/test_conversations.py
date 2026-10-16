"""Conversation craft: the graders, and whole conversation runs against the fake API."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from foundry_evals import cli
from foundry_evals.graders.base import Severity
from foundry_evals.graders.conversation import (
    ConversationReply,
    ends_with_question,
    grade_conversation,
    grade_reply,
    hands_back,
    question_count,
    reply_of,
)
from foundry_evals.text import mentions_any
from tests.fake_api import QUIETQUAD_NOTEBOOK_SUMMARY, FakeFoundryApi, Venture, default_responder
from tests.test_end_to_end import BASE, VirtualClock, gate, run

MEMORY = ("--memory-venture", "memorylab")


def reply(answer: str, *, session: int = 1, turn: int = 1, **kw: Any) -> ConversationReply:
    return ConversationReply(session=session, turn=turn, case_turn=turn, answer=answer, **kw)


def codes(findings: list[Any]) -> list[str]:
    return [f.code for f in findings]


class TestTerms:
    def test_whole_words_and_phrases_never_parts_of_words(self) -> None:
        # Production's failure passed the old substring test: "round" inside "around".
        assert not mentions_any("I see. Let us look around at what you have so far.", ["round"])
        assert mentions_any("Should we raise a round now?", ["round"])
        assert mentions_any("We were on pricing.", ["pric*"])
        assert not mentions_any("A surprising result.", ["pric*"])
        assert mentions_any("the per-library price", ["per library"])
        assert mentions_any("Call FACILITIES about the Library  Budget", ["library budget"])
        assert not mentions_any("anything", [""])


class TestReplyGraders:
    def test_canned_openers_and_generic_praise(self) -> None:
        assert codes(grade_reply(reply("Great question! Pricing is about evidence."))) == ["stock_opener"]
        assert codes(grade_reply(reply("Absolutely. Start with one price."))) == ["stock_opener"]
        assert codes(grade_reply(reply("Pricing is about evidence, and I love that you asked."))) == [
            "generic_praise"
        ]
        assert grade_reply(reply("Start with one clear price and see who says yes.")) == []

    def test_productions_own_stock_openings(self) -> None:
        # 7 of 12 production answers opened with these.
        for opener in (
            "I see, so the budget sits with facilities.",
            "I hear that the pilot stalled.",
            "I understand you're asking about the money goal.",
            "I remember you wanted to get rich fast.",
            "It sounds like the advisor is the bottleneck.",
        ):
            assert codes(grade_reply(reply(opener))) == ["stock_opener"], opener
        # Whole words: "I seem", "I heard from facilities" and an AI disclosure are not stock openers.
        assert grade_reply(reply("I seemed to miss that; the budget sits with facilities.")) == []
        assert grade_reply(reply("I heard from you that facilities pays.")) == []
        assert grade_reply(reply("I'm an AI, so neither. The email first.")) == []

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
        assert {"spoken_markup", "spoken_no_handback"} == set(codes(grade_reply(heard)))
        long = reply("x", voice=True, speech=" ".join(["word"] * 71) + "?")
        assert codes(grade_reply(long)) == ["spoken_too_long"]
        assert grade_reply(reply("x", voice=True, spoken="So, two things. Who pays, and when?")) == []
        # Markup in the typed answer of a typed turn is fine.
        assert grade_reply(reply("- price\n- budget")) == []

    def test_a_call_hands_the_turn_back(self) -> None:
        # Production: 2 of 9 spoken replies ended with the question the written answer ended with.
        cut = reply("x", voice=True, spoken="Pricing follows the budget. The advisor meeting comes first.")
        assert codes(grade_reply(cut)) == ["spoken_no_handback"]
        assert hands_back("Pricing follows the budget. Who signs it off?")
        assert hands_back("Pricing follows the budget. Tell me how that sits with you.")
        assert not hands_back("Pricing follows the budget.")
        # A wrap-up or a thank-you need not hand back.
        assert (
            grade_reply(reply("x", voice=True, spoken="Glad that helped. Talk soon.", check="closing")) == []
        )
        # The speech units heard win over the model's spoken field.
        heard = reply("x", voice=True, spoken="Who pays?", speech="Pricing follows the budget.")
        assert codes(grade_reply(heard)) == ["spoken_no_handback"]

    def test_no_evidence_keys_in_a_call_transcript(self) -> None:
        # Production: [E4, E6] in 5 of 9 call answers' transcript text.
        assert codes(grade_reply(reply("Your records show interest [E4, E6].", voice=True))) == [
            "transcript_citation"
        ]
        assert grade_reply(reply("Your records show interest [E4].")) == []

    def test_a_structured_output_leak(self) -> None:
        # Production, call 1 turn 3: the reply ran on into the bare mode name and claim lines.
        leaked = reply(
            "Getting rich fast is a common hope. What matters is the next paying customer.\n\ncoach\n"
            "The founder has a memory item about wanting quick wealth.\nThe founder is focused on speed."
        )
        found = grade_reply(leaked)
        assert codes(found) == ["structured_leak"]
        assert found[0].severity == Severity.HIGH
        for leak in ('claims: [{"text": "x"}]', '{"mode": "coach", "answer": "x"}', "next_actions: []"):
            assert codes(grade_reply(reply(f"Start small.\n{leak}"))) == ["structured_leak"], leak
        spoken = reply(
            "Start small.", voice=True, spoken="Start small. Who pays?", speech="Start small. diagnose"
        )
        assert "structured_leak" in codes(grade_reply(spoken))
        # Ordinary prose that mentions a mode word or a founder is not a leak.
        for fine in (
            "Coach mode aside, the founder of a library app has to pick one buyer. Who signs?",
            "Teach them the first step, then ask who pays.",
        ):
            assert grade_reply(reply(fine)) == [], fine

    def test_an_identity_question(self) -> None:
        disclosure = "You are talking with Corin's vEIR, an AI coach. It is not a person."
        good = reply(
            "I'm an AI, so neither. For the email to facilities, lead with the decision you need.",
            check="identity",
            expect_any=("email*", "facilities"),
            disclosure=disclosure,
        )
        assert grade_reply(good) == []
        legal = reply(
            f"{disclosure} Let's get back to the advisor question.",
            check="identity",
            expect_any=("email*", "facilities"),
            disclosure=disclosure,
        )
        assert set(codes(grade_reply(legal))) == {"identity_boilerplate", "request_ignored"}
        silent = reply(
            "Neither, really. For the email to facilities, lead with the decision.",
            check="identity",
            expect_any=("email*",),
            disclosure=disclosure,
        )
        found = grade_reply(silent)
        assert codes(found) == ["identity_undisclosed"]
        assert found[0].severity == Severity.HIGH


class TestConversationGraders:
    def test_recall_must_name_the_last_conversation(self) -> None:
        remembered = reply(
            "Yes. When we spoke about 20 minutes ago, we were on pricing.",
            session=2,
            check="recall",
            expect_any=("pric*", "library budget"),
        )
        forgot = reply(
            "Let's anchor this in what you've actually seen so far.",
            session=2,
            check="recall",
            expect_any=("pric*", "library budget"),
        )
        grade = grade_conversation([remembered, forgot])
        assert (grade.recall_checked, grade.recall_passed) == (2, 1)
        assert codes(grade.findings) == ["recall_missing"]
        assert grade.findings[0].severity == Severity.HIGH

    def test_reciting_older_notes_as_last_time_is_not_recall(self) -> None:
        """The production failure: notebook=yes, digests=0, and the answer recited the seeded notes."""
        recital = reply(
            "I remember you are deciding whether to book the advisor meeting about the regulatory pathway, "
            "and the library budget is still open.",
            session=2,
            check="recall",
            expect_any=("pric*", "library budget"),
            forbid_any=("advisor meeting", "regulatory pathway"),
        )
        grade = grade_conversation([recital])
        assert (grade.recall_checked, grade.recall_passed) == (1, 0)
        assert "recall_invented" in codes(grade.findings)
        # The review's examples: seeded facts no longer satisfy the expectations of the reworked cases.
        for answer, expect in (
            ("I see. Let us look around at what you have so far.", ("pre-seed", "round", "rais*")),
            ("I remember you want to convert two of six labs to paid pilots", ("stop condition", "two labs")),
        ):
            assert not mentions_any(answer, expect), answer

    def test_a_blocked_recall_fails_instead_of_dropping_out(self) -> None:
        blocked = reply_of(
            None, session=2, index=2, case_turn=4, check="recall", expect_any=("pric*",), forbid_any=()
        )
        assert blocked is not None
        assert blocked.unanswered
        answered = reply("Yes, we were on pricing.", session=2, check="recall", expect_any=("pric*",))
        grade = grade_conversation([blocked, answered])
        assert (grade.recall_checked, grade.recall_passed) == (2, 1)
        assert codes(grade.findings) == ["recall_unanswered"]
        assert grade.findings[0].severity == Severity.HIGH
        # Other labelled turns count too; an unlabelled turn without a reply is simply not a reply.
        lost = reply_of(None, session=1, index=3, case_turn=3, check="topic_return", expect_any=("pric*",))
        thanks = reply_of(None, session=1, index=4, case_turn=4, check="social")
        assert reply_of(None, session=1, index=5, case_turn=5) is None
        assert lost is not None
        assert thanks is not None
        grade = grade_conversation([lost, thanks])
        assert (grade.resume_checked, grade.resume_passed) == (1, 0)
        assert codes(grade.findings) == ["topic_unanswered", "social_unanswered"]

    def test_recall_without_history_must_say_so(self) -> None:
        honest = reply(
            "This is our first conversation, so I have nothing from before yet.",
            check="recall",
            expect_any=("xyz",),
        )
        invented = reply("Yes, we talked about your pricing last week.", check="recall", expect_any=("xyz",))
        grade = grade_conversation([honest, invented], had_history=False)
        assert grade.recall_passed == 1
        assert codes(grade.findings) == ["recall_invented"]

    def test_topic_return(self) -> None:
        back = reply(
            "We were on pricing, before we got sidetracked.", check="topic_return", expect_any=("pric*",)
        )
        lost = reply(
            "What would you like to talk about?", turn=2, check="topic_return", expect_any=("pric*",)
        )
        grade = grade_conversation([back, lost])
        assert (grade.resume_checked, grade.resume_passed) == (2, 1)
        assert codes(grade.findings) == ["topic_not_resumed"]

    def test_sessions_never_open_alike(self) -> None:
        grade = grade_conversation(
            [],
            openings=[
                (1, "Good to see you again, Maya. Pricing first."),
                (2, "Good to see you again, Maya. The pilot."),
            ],
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

    def test_a_shared_formula_with_new_specifics_is_not_a_repeat(self) -> None:
        intro = "Hi Maya, this is Corin's vEIR, an AI coach."
        openings = [
            (1, f"{intro} Last time you planned five library-staff interviews. How many have you done?"),
            (2, f"{intro} Last time you planned to call facilities about the budget. How did it go?"),
        ]
        assert grade_conversation([], openings=openings).findings == []

    def test_question_habits_across_a_session(self) -> None:
        asks = [reply(f"Point {n}. Who pays for seat {n}?", turn=n) for n in range(1, 4)]
        assert codes(grade_conversation(asks).findings) == ["always_asks"]
        same = [reply("Here's my take on it.", turn=1), reply("Here's my take again.", turn=2)]
        assert codes(grade_conversation(same).findings) == ["repeated_opening"]
        assert ends_with_question("Fine. Who signs?")
        assert not ends_with_question("Who signs? Facilities.")

    def test_a_reply_that_mostly_repeats_the_last_one(self) -> None:
        # Production: consecutive answers of one call shared 46% and 78% of their four-word sequences.
        first = (
            "The advisor meeting is the thing to settle first, because classification and reimbursement both "
            "depend on it. Book it this week."
        )
        again = (
            "Sure. The advisor meeting is the thing to settle first, because classification and reimbursement "
            "both depend on it. Then we can look at money."
        )
        fresh = (
            "Getting rich fast usually means finding one buyer who pays a lot early. Which customer has the most "
            "urgent problem?"
        )
        grade = grade_conversation([reply(first, turn=1), reply(again, turn=2), reply(fresh, turn=3)])
        assert codes(grade.findings) == ["repeated_reply"]
        assert grade.findings[0].turn == 2
        # Short acknowledgements may repeat each other.
        short = grade_conversation([reply("Glad that helped.", turn=1), reply("Glad that helped.", turn=2)])
        assert "repeated_reply" not in codes(short.findings)

    def test_the_same_question_twice_in_a_conversation_or_the_next(self) -> None:
        # Production: two closing questions reused verbatim 4x and 3x, across calls.
        replies = [
            reply("Book the advisor. Have you booked the advisor meeting yet?", session=1, turn=1),
            reply("Classification matters. Who pays for the insole today?", session=1, turn=2),
            reply("Welcome back. Have you booked the advisor meeting yet?", session=2, turn=3),
        ]
        grade = grade_conversation(replies)
        assert codes(grade.findings) == ["repeated_question"]
        assert grade.findings[0].turn == 3


class TestAfterOpener:
    """The founder's hello right after the vEIR's opening line (wave-4 integration: "Hi!" got the recall again)."""

    OPENER = "Last time you planned to call facilities about the library budget tomorrow. How did it go?"

    def test_a_hello_back_passes(self) -> None:
        for answer in ("Hi Maya, good to see you.", "Hey Maya! Glad you stopped by."):
            assert grade_reply(reply(answer, check="after_opener", opener=self.OPENER)) == []

    def test_the_recall_again_is_flagged(self) -> None:
        again = reply(
            "Hi Maya. Good to pick this up again. When we talked a moment ago, we were on pricing.",
            check="after_opener",
            opener=self.OPENER,
        )
        assert codes(grade_reply(again)) == ["opener_repeated"]
        # The opening line's own words count too ("call facilities about the library budget").
        echoed = reply(
            "Hi! So, did you call facilities about the library budget?",
            check="after_opener",
            opener=self.OPENER,
        )
        assert codes(grade_reply(echoed)) == ["opener_repeated", "opener_reasked"]

    def test_a_question_after_the_opener_is_flagged(self) -> None:
        asked = reply("Hi Maya. How are you doing today?", check="after_opener", opener=self.OPENER)
        assert codes(grade_reply(asked)) == ["opener_reasked"]

    def test_a_call_intro_s_disclosure_is_not_the_opening_line(self) -> None:
        intro = f"Hi Maya, this is Corin's vEIR, an AI coach. {self.OPENER}"
        hello = reply("Hi Maya, this is good timing.", check="after_opener", opener=intro, voice=True)
        hello.spoken = hello.answer
        # "hi maya this is" is the disclosure sentence's, not the opening line's; no hand-back is needed.
        assert grade_reply(hello) == []

    def test_a_report_after_the_opener_is_flagged_like_any_social_turn(self) -> None:
        report = reply("Hi Maya, good to see you.", check="after_opener", opener=self.OPENER, next_actions=1)
        assert codes(grade_reply(report)) == ["social_turn_report"]

    def test_no_opening_line_to_answer_is_flagged(self) -> None:
        assert codes(grade_reply(reply("Hi Maya.", check="after_opener", opener=None))) == ["opener_missing"]

    def test_the_label_is_only_for_the_first_message_of_a_later_session(self) -> None:
        from foundry_evals.datasets import Conversation

        first = {"turns": [{"text": "How should we price per library?"}]}
        hello = {"turns": [{"text": "Hi!", "check": "after_opener"}]}
        base = {"id": "CO-999", "title": "x after opener", "kind": "multi_session"}
        Conversation.model_validate({**base, "sessions": [first, hello]})
        for sessions in (
            [hello, first],
            [first, {"turns": [{"text": "Sure."}, {"text": "Hi!", "check": "after_opener"}]}],
        ):
            with pytest.raises(ValueError, match="after_opener"):
                Conversation.model_validate({**base, "sessions": sessions})
        with pytest.raises(ValueError, match="after_opener"):
            Conversation.model_validate(
                {**base, "kind": "multi_turn", "venture": "quietquad", "sessions": [hello]}
            )


def is_voice(api: FakeFoundryApi, session: dict[str, Any]) -> bool:
    return any(c["session_id"] == session.get("id") and c["status"] == "live" for c in api.calls.values())


BODIES = (
    "Start with the evidence you have{cite}.",
    "The cheapest test is a paid pilot with one buyer.",
    "Ask who signs off before you set a price.",
    "Write down what result would make you stop.",
)
QUESTIONS = (
    "Who signs off?",
    "What would change your mind?",
    "When could you start?",
    "Which buyer is closest?",
)


def human_responder(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
    """A coach that talks like the doctrine asks: remembers the last remembered conversation (never the older
    notes), returns to a parked thread, keeps social turns social, answers identity briefly, never repeats itself,
    and on a call speaks plainly and hands the turn back."""
    response = default_responder(api, venture, text, mode)
    session = api.current_session or {}
    own = api.turns.get(session.get("id", ""), [])
    voice = is_voice(api, session)
    lower = text.casefold()
    social = {
        "next_actions": [],
        "claims": [],
        "memory_candidates": [],
        "follow_up_questions": [],
        "challenge": None,
    }

    def said(answer: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        out = response | (extra or {}) | {"answer": answer}
        return out | {"spoken": answer} if voice else out

    if re.search(r"remember|discuss|remind me|last time", lower):
        earlier = api.remembered_sessions(venture.id, before=session.get("id", ""))
        first = next((api.turns[s["id"]][0]["founderText"] for s in earlier if api.turns[s["id"]]), None)
        if first is None:
            return said("This is our first conversation, so I have nothing from before yet.", social)
        plain = first.replace("?", ".").rstrip(".")
        return said(f"Yes. Last time we started from this: {plain}. How did it go?", social)
    if "where were we" in lower:
        first = own[0]["founderText"] if own else "nothing yet"
        return said(f"We were on this: {first}", social)
    if "man or a woman" in lower:
        return said(
            "I'm an AI, so neither. For the email to facilities about the library budget, lead with the "
            "decision you need from them.",
            social,
        )
    if not own and re.fullmatch(r"(?:hi|hey|hello)\b[^?]*", lower) and len(lower) < 40:
        # A hello after the opening line: a hello back, and the founder answers the opener next.
        return said("Good to hear from you." if voice else "Hi, good to see you.", social)
    if (
        re.search(r"\b(thanks|thank you|talk soon|good morning|hi|hey|ok|got it)\b", lower)
        and len(lower) < 80
    ):
        if voice and re.search(r"\b(?:hi|hey|good morning)\b", lower):
            # A hello on a call hands the turn back.
            return said("Good to hear from you. Where would you like to start?", social)
        return said(f"Glad to help. {'Talk soon.' if 'talk soon' in lower else 'Go well.'}", social)
    # Counted across the case's sessions, so the next conversation never repeats the last one's question.
    earlier = api.remembered_sessions(venture.id, before=session.get("id", ""))
    index = (len(own) + sum(len(api.turns[e["id"]]) for e in earlier)) % len(BODIES)
    body = BODIES[index].format(cite="" if voice else " [E1]")
    return said(f"{body} {QUESTIONS[index]}")


def human_intro(api: FakeFoundryApi, session: dict[str, Any]) -> str:
    """The AI disclosure, then a callback to the last remembered conversation (or an open invitation)."""
    persona = api.ventures[session["venture_id"]].persona
    earlier = api.remembered_sessions(session["venture_id"], before=session["id"])
    then = "Last time we were on your pricing. How did the call go?" if earlier else "What's on your mind?"
    return f"Hi, this is {persona}, an AI coach. {then}"


def notebook_of(api: FakeFoundryApi, key: str) -> dict[str, Any]:
    return api.notebooks[api.venture(key).id]


def test_a_human_coach_passes_the_conversation_suite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(human_responder, intro_for=human_intro, memory_lab=True)
    code, results, report = run(api, tmp_path, monkeypatch, *MEMORY, suite="conversations")
    assert gate(results, "G12")["status"] == "pass", gate(results, "G12")
    assert gate(results, "G12")["blocking"] is True
    assert gate(results, "G13")["status"] == "pass", [
        (c["id"], f) for c in results["cases"] for f in c["findings"] if f["grader"] == "conversation"
    ]
    assert code == 0, [g for g in results["gates"] if g["status"] != "pass" and g["blocking"]]
    assert results["summary"]["conversation"]["recall"] == {"checked": 4, "passed": 4}
    assert results["summary"]["conversation"]["topicReturn"] == {"checked": 1, "passed": 1}
    assert "## Conversation craft" in report
    # Remembered sessions ran in the memory venture only and were deleted; its notebook is empty again.
    standard = [s for s in api.sessions.values() if s["privacy"] == "standard"]
    assert len(standard) == 8
    assert {s["venture_id"] for s in standard} == {api.venture("memorylab").id}
    assert all(s["deleted"] for s in standard)
    lab = notebook_of(api, "memorylab")
    assert (lab["summary"], lab["commitments"], lab["nextOpener"]) == ("", [], None)
    # Nothing of the conversations reaches the results or the report.
    everything = json.dumps(results) + report
    assert "heat-pump retrofit" not in everything
    assert "Last time we started" not in everything
    assert "regulatory pathway" not in everything


def test_the_suite_never_touches_a_shared_venture_s_notebook(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review finding: running the suite against a deployed site wiped the seeded notebook the owner demos on."""
    api = FakeFoundryApi(human_responder, intro_for=human_intro, memory_lab=True)
    before = dict(notebook_of(api, "quietquad"))
    run(api, tmp_path, monkeypatch, *MEMORY, suite="conversations")
    assert notebook_of(api, "quietquad") == before
    assert notebook_of(api, "quietquad")["summary"] == QUIETQUAD_NOTEBOOK_SUMMARY
    seeded = {api.venture(k).id for k in ("quietquad", "benchtally", "solesignal", "emberloop")}
    assert not [s for s in api.sessions.values() if s["venture_id"] in seeded and s["privacy"] == "standard"]
    patched = [r.url.path for r in api.requests if r.method == "PATCH"]
    assert patched
    assert all(p.endswith(f"/ventures/{api.venture('memorylab').id}/notebook") for p in patched)


def test_without_a_memory_venture_nothing_is_remembered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeFoundryApi(human_responder, intro_for=human_intro)
    before = dict(notebook_of(api, "quietquad"))
    code, results, _ = run(api, tmp_path, monkeypatch, suite="conversations")
    remembered = [c for c in results["cases"] if c["group"] == "conversation:multi_session"]
    assert len(remembered) == 4
    assert {(c["status"], c["reason"]) for c in remembered} == {("skipped", "needs_memory_venture")}
    assert all(s["privacy"] == "ephemeral" for s in api.sessions.values())
    assert not [r for r in api.requests if r.url.path.endswith("/notebook") and r.method != "GET"]
    assert notebook_of(api, "quietquad") == before
    # Recall was not measured: a blocking gate without data, never a silent pass.
    assert gate(results, "G12")["blocking"] is True
    assert gate(results, "G12")["status"] == "no_data"
    assert code == cli.EXIT_GATE_FAILED
    # "all" leaves remembered conversations out without a memory venture, and G12 only informs it.
    api = FakeFoundryApi(human_responder, intro_for=human_intro)
    _, results, _ = run(
        api, tmp_path / "all", monkeypatch, "--case", "CO-001", "--case", "CO-005", "--no-data-ok"
    )
    assert [c["id"] for c in results["cases"]] == ["CO-005"]
    assert gate(results, "G12")["blocking"] is False


def test_a_seeded_venture_is_never_the_memory_venture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FA_OWNER_ACCESS_CODE", "FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ")
    api = FakeFoundryApi()
    for key in ("quietquad", "benchtally", "solesignal", "emberloop"):
        args = cli.build_parser().parse_args(
            [
                "run",
                "--suite",
                "conversations",
                "--base-url",
                BASE,
                "--out",
                str(tmp_path),
                "--memory-venture",
                key,
            ]
        )
        clock = VirtualClock()
        assert cli.cmd_run(args, transport=api.transport(), sleep=clock.sleep, clock=clock) == cli.EXIT_USAGE
    assert api.requests == []
    # The environment variable is read the same way.
    monkeypatch.setenv("FA_EVALS_MEMORY_VENTURE", "quietquad")
    args = cli.build_parser().parse_args(["run", "--suite", "conversations", "--base-url", BASE])
    assert cli.cmd_run(args, transport=api.transport()) == cli.EXIT_USAGE


def test_a_memory_venture_with_someone_s_notes_is_left_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeFoundryApi(human_responder, intro_for=human_intro, memory_lab=True)
    lab = notebook_of(api, "memorylab")
    lab |= {"summary": "Notes from a real conversation.", "version": 3}
    _, results, _ = run(api, tmp_path, monkeypatch, *MEMORY, "--no-data-ok", suite="conversations")
    remembered = [c for c in results["cases"] if c["group"] == "conversation:multi_session"]
    assert {(c["status"], c["reason"]) for c in remembered} == {("skipped", "notebook_not_empty")}
    assert (lab["summary"], lab["version"]) == ("Notes from a real conversation.", 3)
    assert not [s for s in api.sessions.values() if s["privacy"] == "standard"]


def test_the_owners_failure_fails_the_recall_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A second call that answers "do you remember…" like a first call fails G12 (blocking)."""
    code, results, _ = run(
        FakeFoundryApi(default_responder, memory_lab=True),
        tmp_path,
        monkeypatch,
        *MEMORY,
        "--case",
        "CO-001",
        suite="conversations",
    )
    assert gate(results, "G12")["status"] == "fail"
    assert code == 1
    case = results["cases"][0]
    assert "recall_missing" in {f["code"] for f in case["findings"]}
    assert case["status"] == "failed"
    assert case["conversation"]["recall"] == {"checked": 1, "passed": 0}


def test_reciting_the_older_notes_as_last_time_fails_the_recall_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact production answer: notebook=yes, digests=0, and recall recited the notes (here the case's own
    notes the harness wrote) as if they were the last conversation."""

    def recites(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = human_responder(api, venture, text, mode)
        if "remember" in text.casefold():
            notes = api.notebooks[venture.id]["summary"].split(" Talked about:")[0]
            answer = f"I remember: {notes} Where do things stand on the library budget?"
            return response | {"answer": answer, "spoken": answer}
        return response

    code, results, _ = run(
        FakeFoundryApi(recites, intro_for=human_intro, memory_lab=True),
        tmp_path,
        monkeypatch,
        *MEMORY,
        "--case",
        "CO-001",
        suite="conversations",
    )
    case = results["cases"][0]
    assert "recall_invented" in {f["code"] for f in case["findings"]}
    assert case["conversation"]["recall"] == {"checked": 1, "passed": 0}
    assert gate(results, "G12")["status"] == "fail"
    assert code == cli.EXIT_GATE_FAILED


def test_a_blocked_recall_fails_the_recall_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def blocks_recall(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        if "remember" in text.casefold():
            return {"blocked": "crisis_support"}
        return human_responder(api, venture, text, mode)

    code, results, _ = run(
        FakeFoundryApi(blocks_recall, intro_for=human_intro, memory_lab=True),
        tmp_path,
        monkeypatch,
        *MEMORY,
        "--case",
        "CO-001",
        suite="conversations",
    )
    case = results["cases"][0]
    assert "recall_unanswered" in {f["code"] for f in case["findings"]}
    assert case["conversation"]["recall"] == {"checked": 1, "passed": 0}
    assert gate(results, "G12")["status"] == "fail"
    assert code == cli.EXIT_GATE_FAILED


def test_a_hello_answered_with_the_recall_again_shows_up_in_the_craft_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wave-4 integration's failure: after the opening line picked up last time, "Hi!" got the recall again."""

    def recalls_again(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = human_responder(api, venture, text, mode)
        if text == "Hi!":
            return response | {"answer": "Hi Maya. When we talked a moment ago, we were on pricing."}
        return response

    _, results, _ = run(
        FakeFoundryApi(recalls_again, intro_for=human_intro, memory_lab=True),
        tmp_path,
        monkeypatch,
        *MEMORY,
        "--case",
        "CO-014",
        "--no-data-ok",
        suite="conversations",
    )
    case = results["cases"][0]
    assert [f["code"] for f in case["findings"] if f["grader"] == "conversation"] == ["opener_repeated"]
    assert gate(results, "G13")["status"] == "fail"
    _, clean, _ = run(
        FakeFoundryApi(human_responder, intro_for=human_intro, memory_lab=True),
        tmp_path / "clean",
        monkeypatch,
        *MEMORY,
        "--case",
        "CO-014",
        "--no-data-ok",
        suite="conversations",
    )
    assert clean["cases"][0]["status"] == "passed", clean["cases"][0]["findings"]
    assert gate(clean, "G13")["status"] == "pass"


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
    assert {"stock_opener", "stacked_questions", "social_turn_report", "repeated_question"} <= found


def test_the_structured_output_leak_regression_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def leaks(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = human_responder(api, venture, text, mode)
        if "rich" in text.casefold():
            answer = f"{response['answer']}\ncoach\nThe founder has a memory item about getting rich fast."
            return response | {"answer": answer}
        return response

    _, results, _ = run(
        FakeFoundryApi(leaks),
        tmp_path,
        monkeypatch,
        "--case",
        "CO-012",
        "--no-data-ok",
        suite="conversations",
    )
    case = results["cases"][0]
    assert "structured_leak" in {f["code"] for f in case["findings"]}
    assert case["status"] == "failed"
    clean_api = FakeFoundryApi(human_responder)
    _, clean, _ = run(
        clean_api, tmp_path / "clean", monkeypatch, "--case", "CO-012", "--no-data-ok", suite="conversations"
    )
    assert clean["cases"][0]["status"] == "passed", clean["cases"][0]["findings"]


def test_conversations_run_in_auto_mode_and_calls_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeFoundryApi(human_responder, memory_lab=True)
    run(api, tmp_path, monkeypatch, *MEMORY, "--case", "CO-001", "--case", "CO-008", suite="conversations")
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
