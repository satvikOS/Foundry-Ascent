"""The strict graders, each shown to pass good replies and to FAIL the faults of a first live run in other words. Every
person, venture, number and line here is invented."""

from __future__ import annotations

import datetime as dt
from dataclasses import replace
from typing import Any

import pytest

from conversation_lab.client import strict
from conversation_lab.client.graders import BLOCKING, GRADERS, grade_turn
from conversation_lab.client.scenarios import Expect
from conversation_lab.client.turns import ReplyTurn

STEP: dict[str, Any] = {
    "playId": "money-in-one",
    "criterionId": "one-sale",
    "title": "Work out what one kite leaves",
    "items": [
        {
            "do": "Write the price a buyer really paid",
            "how": "Take it from your last market day.",
            "minutes": 10,
        },
        {
            "do": "List each cost one kite uses up",
            "how": "Paper, rods, string and the stall fee.",
            "minutes": 20,
        },
    ],
    "doneWhen": "A table shows the price, the costs and what is left of one kite",
    "dueOn": "2026-11-30",  # a Monday
}
PATH: dict[str, Any] = {
    "playId": "promise",
    "title": "Say the promise in one sentence",
    "items": [{"do": "Say it to five parents", "how": "", "minutes": 30}],
    "doneWhen": "Four of five parents can repeat it",
    "dueOn": "2026-12-02",  # a Wednesday
}
GUIDANCE: dict[str, Any] = {
    "intent": "money",
    "playId": "money-in-one",
    "stage": "validation",
    "step": STEP,
    "then": [],
    "referral": None,
}
EVIDENCE = ({"key": "E1", "title": "Money in one sale", "excerpt": "Take the price and subtract each cost."},)
GOOD = (
    "One kite leaves 9 dollars: it sells for 16 and uses up 7. At 20 kites a market day that is 180 dollars before your "
    "time, so the stall pays. Next: work out what one kite leaves, by Monday. Done when a table shows the price, the "
    "costs and what is left of one kite."
)
BASE = ReplyTurn(
    founder="What would I make in a day if I sell 20 kites?",
    reply=GOOD,
    guidance=GUIDANCE,
    evidence=EVIDENCE,
    known="KiteKin\nPaper kites for school fairs\nA kite sells for 16 dollars and uses up 7 dollars\njunior in botany",
    facts={"kites": ("kite*",), "wind": ("wind*", "torn", "tear*"), "half": ("half", "50")},
    venture_name="KiteKin",
    founder_name="Odette Marsh",
    today=dt.date(2026, 11, 25),  # a Wednesday
)


def turn(reply: str = GOOD, founder: str | None = None, **changes: Any) -> ReplyTurn:
    expect = {k: changes.pop(k) for k in list(changes) if k in Expect.__dataclass_fields__ and k != "kind"}
    kind = changes.pop("intent", "coaching")
    base = replace(BASE, reply=reply, expect=Expect(kind=kind, **expect), **changes)
    return base if founder is None else replace(base, founder=founder)


NOVICE = "I have never done this, I study plants and know nothing about business."
RESULT = "I sold 30 kites at the fair and 15 of them came back torn by the wind."
TEMPLATE = (
    "Here it is, filled in:\n\n1. Who: parents at school fairs (seen)\n2. Problem: shop kites tear (guess)\n"
)

#: grader -> (replies it must pass, replies it must fail).
CASES: dict[str, tuple[list[ReplyTurn], list[ReplyTurn]]] = {
    "answers_the_number": (
        [
            turn(number=("180",)),
            turn("That is 20 times 9, one hundred and eighty dollars.", number=("180",)),
            turn("About $33.33 an hour, three hours for 100 dollars.", number=("33.33",)),
        ],
        [
            # A step in place of the figure, the method in place of it, another figure.
            turn("Your next step: list each cost one kite uses up, by Monday.", number=("180",)),
            turn("Take the price, subtract each cost and multiply by what you sell.", number=("180",)),
            turn("You would make about 200 dollars.", number=("180",)),
            turn("Tell me the price and the costs and I will do the sum.", number=("180",)),
        ],
    ),
    "no_fragment": (
        [
            turn(),
            # Asked what is next, the step is the answer; told of a plan, it may be confirmed.
            turn("Your next step: list each cost one kite uses up, by Monday.", "What should I do next?"),
            turn("Five sentences. The child, the kite, the price, the proof, the ask.", "How do I open?"),
            turn("Good. List each cost one kite uses up by Monday.", "I'll list my costs this weekend."),
            turn("No. Ask ten parents to pay 16 dollars at the gate, then count who did.", "Is it enough?"),
            turn(
                "Ask five parents to pay at the gate on Saturday. Do it by Monday.",
                "How do I start selling them?",
            ),
        ],
        [
            turn("Your next step: list each cost one kite uses up, by Monday."),
            turn(
                "**Start with:** Weigh the paper of one kite.\n\n**Next:** List each cost one kite uses up by Monday."
            ),
            turn(
                "List each cost one kite uses up, paper, rods, string and the stall fee.",
                "That is useless. Give me something real.",
            ),
            turn("Do it by Monday. Done when a table shows the price, the costs and what is left."),
            turn(
                "Done when four of five parents can repeat it. Keep the kites cheap and sell them at the gate."
            ),
            turn("then match each of those to something the kite gives them, and write it down in one line."),
            turn(
                "Sell them at the gate, where parents wait with children. One sheet. Done when it is written."
            ),
            turn(
                "Sell them at the gate, where parents wait with children. In 20 minutes. Done when it is written."
            ),
            turn(
                "I am here to help you reach your first market. Do it by Monday.",
                "You know nothing.",
                intent="social",
            ),
        ],
    ),
    "single_step_line": (
        [
            turn(),
            turn("It pays. List each cost one kite uses up. Done when the table is full. Do it by Monday."),
            turn(
                'The price is right. Say to them: "Ready by Friday, shall I keep one?" Next: list each cost, by Monday.'
            ),
            turn(
                "Open with the child, next what the kite does, then the price. Your next step: list each cost, by Monday."
            ),
            turn("You were going to list each cost, due Monday. Next: list each cost.", intent="recall"),
            turn(
                "You said you would ask five parents by Friday. Next: work out what one kite leaves, by Monday."
            ),
            turn(
                "Finish the table by Friday, as you said. Next: list each cost by Monday.",
                "I can do it by Friday, is it ok?",
            ),
            # The one thing to do first stands before the step: one plan, on text and on a call.
            turn(
                "It pays.\n\n**Start with:** Weigh the paper of one kite.\n\n"
                "**Next:** List each cost by Monday, November 30. Done when the list is full."
            ),
            turn(
                "It pays. Your next step: list each cost by Monday, and start with this: weigh the paper of one kite.",
                channel="call",
            ),
        ],
        [
            turn(
                "Next: list each cost by Monday. Keep going.\n\nNext: work out what one kite leaves by Monday."
            ),
            turn("The next step is to list each cost. Now: work out what one kite leaves, due Monday."),
            turn(
                "Next, list each cost by Monday. Your next step: say the promise in one sentence, by Wednesday."
            ),
            turn(
                "List each cost. Done when the list is full. Next: work it out. Done when a table shows it."
            ),
            turn("List each cost by Friday. Next: work out what one kite leaves by Monday."),
            turn("Do that by Monday. Your next step: work out what one kite leaves, by Monday."),
            # Two things to do first, or a day of its own for one, are two plans.
            turn(
                "Start with: weigh the paper of one kite.\n\nStart with: ask five parents.\n\nNext: list each cost by Monday."
            ),
            turn(
                "**Start with:** Weigh the paper of one kite by Friday.\n\n**Next:** List each cost by Monday."
            ),
        ],
    ),
    "no_step_by_model_dates": (
        [
            turn(),
            turn("Ask five parents by Monday, November 30."),
            turn("Your fair is on December 5, so cut the paper first.", "The fair is on December 5."),
            turn("Say the promise by Wednesday.", guidance={**GUIDANCE, "pathStep": PATH}),
            turn("Do it tonight if you can.", "What can I do tonight?"),
            turn("Ask one parent this evening at the gate."),
        ],
        [
            turn("List each cost by Friday."),
            turn("Send it out by January 9."),
            # The right date with the wrong weekday.
            turn("Ask five parents by Thursday, November 30."),
            turn("Ask five parents by Saturday, December 2.", guidance={**GUIDANCE, "pathStep": PATH}),
            turn("Write the card, by today."),
        ],
    ),
    "no_invented_founder_fact": (
        [
            turn(),
            turn(TEMPLATE + "3. Why me: I study botany and sell paper kites at school fairs (seen)"),
            turn(TEMPLATE + "3. Idea: I would hang them at the gate and let children try one (guess)"),
            turn(TEMPLATE + "3. Why me: [skills and people]"),
            turn("You have a kite that sells for 16 dollars.", intent="recall"),
            turn("When you have paying customers, ask each one for a name."),
            turn("If you have a prototype, show it."),
            turn("Two kites at 16 dollars are 32 dollars."),
            turn("You sold 20 kites, so ask those buyers.", "I sold 20 kites."),
        ],
        [
            turn(TEMPLATE + "3. Why me: I can borrow a workshop and cut the rods quickly (guess)"),
            turn(TEMPLATE + "3. Why me: I know every head teacher in the county (seen)"),
            turn(TEMPLATE + "3. Why me: I study botany at the museum where I volunteer (seen)"),
            turn("You still have investors who want in, so carry on.", known="KiteKin"),
            turn("You already have a pilot with two schools, so carry on."),
            turn("Parents lose maybe $25 a month on toys that break."),
        ],
    ),
    "no_internal_words": (
        [
            turn(),
            turn("Give each judging criterion one slide."),
            turn("Children play with it for an hour, and play is the point."),
            turn("Your playbook for the team is fine.", "I wrote a playbook for the team."),
        ],
        [
            turn("The playbook says to keep going."),
            turn("On record: A kite sells for 16 dollars."),
            turn("KiteKin is at stage 3. Domain: consumer. Still to show: a price."),
            turn("The guidance says to ask five parents."),
            turn("This meets the criterion for the stage."),
            turn("The play says to ask five parents."),
            turn("Good.\n\nKept: the idea is now kites for museums."),
        ],
    ),
    "no_identity_leak": (
        [
            turn(),
            turn("I'm Corin. Let's price the kite.", earlier=()),
            turn("I'm not a lawyer. Ask one before you sign.", earlier=(("a", "b"),)),
            turn("I'm sure they will pay 16 dollars.", earlier=(("a", "b"),)),
        ],
        [
            turn(
                "Price the kite first.\n\n1. Who: parents\n2. I'm Corin, an AI mentor.\n3. Today: shop kites"
            ),
            turn("I'm Corin. Let's price the kite.", earlier=(("hello", "Hi there."),)),
            turn("Price the kite first. I am your AI coach. Then ask five parents."),
        ],
    ),
    "no_duplicate_story_entries": (
        [
            turn(
                "You sell paper kites at school fairs. November 11: you priced them at 16 dollars.",
                intent="recall",
            ),
            turn(
                "So far: 20 kites sold at the fair. Open step: list each cost, due Monday.",
                intent="recall",
            ),
        ],
        [
            turn(
                "November 18: Moved to museum shops. November 18: Moved to museum shops with smaller kites.",
                intent="recall",
            ),
            turn(
                "Your kite sells for 16 dollars and uses up 7 dollars of paper. On record: Kite price: A kite sells for "
                "16 dollars and uses up 7 dollars of paper.",
                intent="recall",
            ),
            turn(
                "Last time we talked about six parents, four of whom wanted bigger kites. Last conversation (November 20): "
                "The founder talked to six parents, four wanted bigger kites.",
                intent="recall",
            ),
        ],
    ),
    "news_interpreted": (
        [
            turn(
                "Half of them tore, so the paper is the problem, not the price. Change the paper before you sell more.",
                RESULT,
                intent="report",
                news=("half", "wind"),
            ),
            turn(
                "15 of 30 tore in the wind: that means one sale in two becomes a refund. Change the paper first.",
                RESULT,
                intent="report",
            ),
        ],
        [
            # Counted, praised, or passed over for the step.
            turn(
                "Got it. That's a strong signal. Next: find the pattern by Monday.", RESULT, intent="report"
            ),
            turn(
                "That is 30 of 40 towards the test. Next: fly 10 more by Monday.",
                RESULT,
                intent="report",
                news=("wind",),
            ),
            turn(
                "You've flown the kites. Your next step is to submit the canvas.",
                RESULT,
                intent="report",
                news=("half", "wind"),
            ),
            turn("Useful news. Put the idea on one page.", RESULT, intent="report"),
        ],
    ),
    "first_time_adapted": (
        [
            turn(
                "Start with one kite, as with one plant: write what a parent pays, then what the paper and rods cost you. "
                "What is left is your margin, the money one kite earns you.",
                NOVICE,
                first_time=True,
            ),
            turn("Sell one paper kite at the fair and write what is left.", NOVICE, adapt=True),
        ],
        [
            turn(
                "Work out your gross margin and your CAC before you pick a beachhead for the kites.",
                NOVICE,
                first_time=True,
            ),
            turn(
                "List the jobs parents have, the pains they feel and the gains they want from kites.",
                NOVICE,
                first_time=True,
            ),
            # Nothing of their idea.
            turn(
                "Talk to people about the last time it happened and write down what they say.",
                NOVICE,
                first_time=True,
            ),
            # Said once, unexplained, and used again.
            turn(
                "Fill in the canvas for the kites at the fair.",
                "And then?",
                first_time=True,
                earlier=((NOVICE, "Fill in the canvas for the paper kites."),),
            ),
            turn(
                " ".join(
                    f"Write the kite card {n}. Ask a parent about kite {n}."
                    for n in ("one", "two", "three", "four", "five")
                ),
                NOVICE,
                first_time=True,
            ),
        ],
    ),
    "list_formatting": (
        [
            turn(),
            turn(
                "Ask them:\n\n1. What did you buy last time? (5 min)\n2. What broke? (5 min)\n\nDone when three answered."
            ),
            turn("Three lines:\n\n1. Who\n2. Problem\n3. Today\n\nNext: mark each one."),
            turn(
                "Week 1: price it.\n- Monday: list each cost.\n\nWeek 2: sell ten.",
                "Give me a plan for two weeks.",
            ),
            turn("List of 1. One. 2. Two.", channel="call"),
        ],
        [
            turn(
                "Here are the five lines:\n\n1. Who: parents\n2. Problem: kites tear\n3. Today: shop kites\n\nNext: mark them."
            ),
            turn("A promise is one sentence.\n\n1. Who: parents (guess) Do it by Monday."),
            turn("Ask the office this week. (40 min) Collect what you signed. (30 min) Ask for a meeting."),
            turn("Write two lines of proof. (15 min) by Monday."),
            turn("They lose $X a month on kites that tear."),
            turn("Week 1: price it.\n- Monday: list each cost.", "Give me a plan for the next two weeks."),
        ],
    ),
    "repeats_previous_reply": (
        [
            turn(same_session=("Sell at the gate, where parents wait.",)),
            turn(GOOD, "Say that again?", same_session=(GOOD,)),
            # The step may be named again; the answer is new.
            turn(
                "Because schools pay late and parents pay now. Next: list each cost one kite uses up by Monday.",
                "Why?",
                same_session=("Sell to parents first. Next: list each cost one kite uses up by Monday.",),
            ),
            turn(GOOD, same_session=()),
        ],
        [
            turn(
                "Price from what a parent pays for a toy today. Stay below the shop and above your paper.",
                "And if the shop is cheaper?",
                same_session=(
                    "Price from what a parent pays for a toy today. Stay below the shop and above your paper.",
                ),
            ),
            turn(
                "List each cost one kite uses up. Do it by Monday.",
                "That is nonsense, give me something that works.",
                same_session=("It pays. List each cost one kite uses up. Do it by Monday.",),
            ),
            turn(
                "I hear you. Parents pay now and schools pay late. Sell at the gate on Saturday mornings instead.",
                "I don't agree. What else?",
                same_session=(
                    "Sell to parents, not schools. Parents pay now and schools pay late. Sell at the gate on Saturday mornings.",
                ),
            ),
        ],
    ),
}


def test_every_strict_grader_has_good_and_bad_replies_and_blocks() -> None:
    assert set(CASES) == set(strict.STRICT)
    assert set(strict.STRICT) <= set(GRADERS)
    assert set(strict.STRICT) <= BLOCKING
    assert all(good and bad for good, bad in CASES.values())


@pytest.mark.parametrize(("name", "good"), [(n, t) for n, (ok, _) in CASES.items() for t in ok])
def test_passes_a_good_reply(name: str, good: ReplyTurn) -> None:
    grade = GRADERS[name](good)
    assert grade.passed is not False, (name, grade.detail, good.reply)


@pytest.mark.parametrize(("name", "bad"), [(n, t) for n, (_, no) in CASES.items() for t in no])
def test_fails_a_bad_reply(name: str, bad: ReplyTurn) -> None:
    grade = GRADERS[name](bad)
    assert grade.passed is False, (name, bad.reply)


def test_a_good_reply_passes_every_strict_grader_that_applies() -> None:
    grades = grade_turn(turn(number=("180",)))
    assert {k: v.detail for k, v in grades.items() if k in strict.STRICT and not v.passed} == {}
    assert {"answers_the_number", "no_fragment", "single_step_line", "no_step_by_model_dates"} <= set(grades)


def test_a_grader_that_does_not_apply_stays_out() -> None:
    assert GRADERS["answers_the_number"](turn()).passed is None
    assert GRADERS["news_interpreted"](turn()).passed is None
    assert GRADERS["first_time_adapted"](turn()).passed is None
    assert GRADERS["no_duplicate_story_entries"](turn()).passed is None
    assert GRADERS["list_formatting"](turn(channel="call")).passed is None
    assert GRADERS["no_fragment"](turn("988, now.", intent="crisis")).passed is None
    assert (
        GRADERS["no_identity_leak"](turn("I'm Corin.", "Are you a bot?", earlier=(("a", "b"),))).passed
        is None
    )


def test_a_weekday_is_read_in_the_year_it_falls_in() -> None:
    assert strict._real_weekday(dt.date(2026, 11, 25), 12, 2) == "wednesday"
    assert strict._real_weekday(dt.date(2026, 12, 28), 1, 4) == "monday"
    assert strict._real_weekday(dt.date(2026, 11, 25), 2, 30) is None
