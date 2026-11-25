"""What the judge is told beside a reply (the moved calendar, what counts as answering), and what is no question to the
founder: a message, a template or a script drafted for them. All wording here is invented."""

from __future__ import annotations

import datetime as dt
from dataclasses import replace

import pytest

from conversation_lab.client import graders, reading
from conversation_lab.client.graders import grade_turn
from conversation_lab.client.judge import SYSTEM, answered_by, calendar_note, reply_prompt
from conversation_lab.client.runner import ClientRunner, ScenarioResult, TurnResult
from conversation_lab.client.scenarios import Expect, load
from tests.test_client_graders import TURN

DAY = dt.date(2026, 11, 25)


def prompt(**changes: str) -> str:
    given = {
        "role": "undergrad",
        "founder": "Ines, junior in botany",
        "known": "One nursery pays 30 dollars a month.",
        "founder_text": "What did we decide?",
        "reply": "You decided to sell to nurseries.",
        "card": "",
        "channel": "chat",
        "tests": "memory",
        "passing": "",
    }
    return reply_prompt(earlier=(), seconds=1.0, **{**given, **changes})  # type: ignore[arg-type]


def test_the_judge_is_told_how_far_the_calendar_was_moved() -> None:
    note = calendar_note([14, 7])
    assert "conversation 1 and what it left on record: 14 days back" in note
    assert "conversation 2 and what it left on record: 7 days back" in note
    assert "never an invented one" in note
    assert calendar_note([]) == calendar_note([0, 0]) == ""
    assert f"Calendar: {note}" in prompt(calendar=note)
    assert "Calendar:" not in prompt()
    assert "calendar note" in SYSTEM


@pytest.mark.parametrize(
    ("expect", "says"),
    [
        (Expect(no_flattery=True), "honest read"),
        (Expect(other_venture=True), "kept apart"),
        (Expect(challenge_friends=True), "Saying that it is none"),
        (Expect(referral=("ip",)), "what to bring"),
    ],
)
def test_a_refusal_or_an_honest_read_is_the_answer_where_the_scenario_expects_one(
    expect: Expect, says: str
) -> None:
    note = answered_by(expect)
    assert says in note
    assert f"What counts as answering here: {note}" in prompt(answers=note)


def test_a_plain_question_has_no_such_note() -> None:
    assert answered_by(Expect()) == ""
    assert answered_by(Expect(history=("jars",))) == ""
    assert "What counts as answering" not in prompt()


def test_the_runner_derives_both_from_the_scenario() -> None:
    scenarios = load(DAY).by_id()
    aged = next(s for s in scenarios.values() if len(s.sessions) > 2 and s.repeat == 1)
    result = ScenarioResult(aged)
    for index, plan in enumerate(aged.sessions, start=1):
        for number, planned in enumerate(plan.turns, start=1):
            result.turns.append(
                TurnResult(
                    f"{index}.{number}",
                    index,
                    plan.channel,
                    planned,
                    planned.say,
                    reply="A reply.",
                    kind="completed",
                )
            )
    runner = ClientRunner(app=None, simulator=None, judge=None, today=DAY, log=lambda _m: None)
    first = runner.judge_prompt(result, 0)
    last = runner.judge_prompt(result, len(result.turns) - 1)
    total = sum(p.gap_days for p in aged.sessions[1:])
    assert "Calendar:" not in first
    assert f"conversation 1 and what it left on record: {total} days back" in last


def test_the_figure_and_what_a_recall_gives_back_are_named() -> None:
    assert "the figure asked for is 12 or 12.5" in answered_by(Expect(number=("12", "12.5")))
    note = answered_by(Expect(kind="recall", remember=("pots", "gone")), {"pots": ("pots", "labels")})
    assert "pots or labels" in note
    assert "gone" not in note


@pytest.mark.parametrize(
    ("text", "back", "moved"),
    [
        ("By Monday, November 30. Done when", 7, "By Monday, November 23. Done when"),
        ("The talk on December 3 is yours.", 4, "The talk on November 29 is yours."),
        ("Due Sat, Dec 5 at the latest", 1, "Due Friday, December 4 at the latest"),
        ("In January 9 pots broke", 10, "In December 30 pots broke"),
        ("Ask 20 people by Friday.", 7, "Ask 20 people by Friday."),
        ("By Monday, November 30.", 0, "By Monday, November 30."),
    ],
)
def test_dates_move_with_their_conversation(text: str, back: int, moved: str) -> None:
    assert reading.move_dates(text, back, DAY) == moved


def test_earlier_conversations_are_shown_on_the_days_they_were_moved_to() -> None:
    scenarios = load(DAY).by_id()
    aged = next(
        s for s in scenarios.values() if len(s.sessions) > 1 and s.repeat == 1 and s.sessions[1].gap_days == 7
    )
    result = ScenarioResult(aged)
    for index, plan in enumerate(aged.sessions, start=1):
        for number, planned in enumerate(plan.turns, start=1):
            result.turns.append(
                TurnResult(
                    f"{index}.{number}",
                    index,
                    plan.channel,
                    planned,
                    planned.say,
                    reply="**Next:** Ask three by Monday, November 30.",
                    kind="completed",
                )
            )
    runner = ClientRunner(app=None, simulator=None, judge=None, today=DAY, log=lambda _m: None)
    second = next(i for i, t in enumerate(result.turns) if t.session == 2)
    shown = runner.judge_prompt(result, second)
    assert "[conversation 1, 7 days before this one, Wednesday, November 18]" in shown
    assert "Ask three by Monday, November 23." in shown
    # Nothing of the same conversation is moved.
    assert "days before this one" not in runner.judge_prompt(result, 0)


def test_names_of_a_step_or_referral_on_record_are_grounded() -> None:
    card = {
        "step": {"title": "Book Orrin Licensing Office", "items": []},
        "referral": {"who": "Orrin Licensing Office"},
    }
    said = "We agreed on two steps, and one was to book Orrin Licensing Office."
    assert graders.grounded_names(replace(TURN, reply=said)).passed is False
    record = reading.leaf_text(card)
    assert graders.grounded_names(replace(TURN, reply=said, record=record)).passed


DRAFTS = [
    # A message, with and without quotation marks.
    "Send this today.\n\nHi [name], I am a student looking into how people carry shopping. Could I ask you about the last "
    "time? It takes 15 minutes. Would [day] or [day] work?\n\nInes\n\nAsk for ten minutes, not a meeting.",
    'Here is the message:\n\n"Hello, I am learning how nurseries label pots. May I ask you three things? Would Tuesday '
    'suit you?"\n\nKeep it that short.',
    # A script and a template.
    "Ask them about the last time.\n\n1. Tell me about the last time a label fell off.\n2. What did you do about it?\n"
    "3. What was the hardest part?\n4. What did it cost you?\n\nThen be quiet.",
    'Start: "I am learning how people label pots. May I take notes?"\n1. What did you do?\n2. What did it cost you?\n'
    'Close: "Who else should I talk to? May I come back?"',
    "1. Who: [type of person]\n2. Today: [what do they do now?] (seen / guess)\n3. Check first: [which line?]",
    # A line to say.
    'Say the price and wait. Ask: "I am taking the first five today. You can pay here. Shall I put you down?" Then write '
    "down what they say.",
]


@pytest.mark.parametrize("reply", DRAFTS)
def test_questions_of_a_draft_are_not_put_to_the_founder(reply: str) -> None:
    assert reading.questions_to_founder(reply) == []


@pytest.mark.parametrize(
    ("reply", "asked"),
    [
        ("Sell it by hand first. Who could you ask today? And what would you charge?", 2),
        ("Start with the dean. What do you know about the budget?\n\nWhen does it close?", 2),
        ("Charge 6 dollars.\n\nWhat do the pots cost you?", 1),
        ('They will ask "who pays?", so open with it.\n\nWho pays you today?', 1),
    ],
)
def test_questions_put_to_the_founder_still_count(reply: str, asked: int) -> None:
    assert len(reading.questions_to_founder(reply)) == asked


def test_one_question_reads_the_steps_own_template_as_a_script() -> None:
    step = dict(TURN.guidance["step"])  # type: ignore[index]
    step["template"] = {
        "title": "Card",
        "body": "What did you do about it last time?\nWhat did it cost you then?",
    }
    reply = f"{step['template']['body']}\n\nWhich of them will you ask first?"
    shown = replace(TURN, reply=reply, guidance={**(TURN.guidance or {}), "step": step})
    assert graders.one_question(shown).passed is True
    assert (
        grade_turn(
            replace(shown, reply="Who pays? When? Who says yes, and why would they?\n\nWhat is it worth?")
        )["one_question"].passed
        is False
    )


def test_a_question_given_in_quotation_marks_opens_an_answer() -> None:
    reply = 'The first one will be: "Who pays for this today?" Answer with the nursery that pays 30 dollars a month.'
    assert graders.direct_answer(replace(TURN, reply=reply)).passed is True
    assert (
        graders.direct_answer(replace(TURN, reply="Who pays for this today? Tell me first.")).passed is False
    )


def test_a_quarter_of_an_hours_price_is_arithmetic() -> None:
    shown = replace(
        TURN,
        founder="Tutors ask 30 dollars an hour and I sell by the quarter hour. How do I price it?",
        reply="At 30 dollars an hour, a quarter hour is 7.50 dollars, so start just under it.",
        known="",
    )
    assert graders.grounded_figures(shown).passed is True
    assert graders.grounded_figures(replace(shown, reply="Charge 8.25 dollars for it.")).passed is False


def test_the_steps_own_words_claim_nothing_of_the_founder() -> None:
    from conversation_lab.client.strict import no_invented_founder_fact

    step = dict(TURN.guidance["step"])  # type: ignore[index]
    step |= {
        "title": "List what you have shown of the patent and book the office",
        "doneWhen": "The list is written.",
    }
    line = "Talk about the result only.\n\n**Next:** List what you have shown of the patent and book the office by Friday."
    shown = replace(TURN, reply=line, guidance={**(TURN.guidance or {}), "step": step})
    assert no_invented_founder_fact(shown).passed is not False
    assert no_invented_founder_fact(replace(TURN, reply="You already have a patent on it.")).passed is False
