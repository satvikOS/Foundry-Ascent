"""The sums a reply writes out: what they support, and what they never may. Every venture, number and line is invented."""

from __future__ import annotations

import datetime as dt
from dataclasses import replace

import pytest

from conversation_lab.client import graders as g
from conversation_lab.client import strict, workings
from conversation_lab.client.scenarios import Expect
from conversation_lab.client.turns import ReplyTurn

X = chr(0xD7)
TURN = ReplyTurn(
    founder="What is left from Friday? We filled 43 seats and the hall keeps 35 that night.",
    reply="",
    known=(
        "SoupLoft\nA seat sells for 13 dollars; soup is 3.70 and the bowl 45 cents; the card company keeps 6%.\n"
        "Seven offices pay 95 dollars a month each; Edda cooks about 26 hours a week."
    ),
    expect=Expect(kind="coaching"),
    today=dt.date(2026, 11, 25),
)
#: 43 x 13 - 43 x 3.70 - 43 x 0.45 - 35
LEFT = f"43 {X} $13 − 43 {X} $3.70 − 43 {X} $0.45 − $35"
SHARE = (
    "The fund gives 240k at most and the college takes 46% on top of the direct costs. How much is for work?"
)
STORE = "Say 80k people pay 3.49 and the store keeps 15 percent. What do I get?"
FEE = "We take 7% of each rental, a rental is 310, and my rent is 1,450 a month. How many rentals until that is covered?"


def turn(reply: str, founder: str | None = None, **changes: object) -> ReplyTurn:
    base = replace(TURN, reply=reply, **changes)  # type: ignore[arg-type]
    return base if founder is None else replace(base, founder=founder)


SUPPORTED = [
    turn(f"$345.55 is left from a night: {LEFT}."),
    turn(f"**$345.55** is left: {LEFT.replace(X, 'x')}."),
    turn("$345.55 is left: 43 * ($13 - $3.70 - $0.45) - $35."),
    turn(f"About $346 is left: {LEFT}."),
    turn(f"{LEFT} = $345.55"),
    turn(f"43 seats {X} $13 a seat − 43 bowls {X} ($3.70 soup + $0.45 bowl) − $35 for the hall = $345.55."),
    # One sum builds on another.
    turn(f"$13 price - $3.70 soup - $0.45 bowl = $8.85 a seat. 43 {X} $8.85 − $35 = $345.55."),
    turn("$164,383.56 is for work: $240,000 ÷ (1 + 46%).", SHARE),
    turn("$164,384 is for work: $240,000 / 1.46.", SHARE),
    turn("About $164k is for work: $240,000 / (100% + 46%).", SHARE),
    turn(f"You get $237,320: 80,000 {X} $3.49 {X} (1 − 15%).", STORE),
    turn("You get $237,320: 80,000 x $3.49 x 0.85.", STORE),
    turn("1,450 / (310 x 0.07) = about 66.8 rentals.", FEE),
    turn("You need 67 rentals: 1,450 / (310 x 7%) = 66.82.", FEE),
    # Weeks in a month, when the reply says weeks and months.
    turn(
        f"You earn $6.39 an hour: 7 {X} $95 a month ÷ (26 hours a week {X} 4).", "What do I make in an hour?"
    ),
    turn(
        f"It is $5.91 an hour: 7 {X} $95 a month ÷ (26 {X} 4.33), at 26 hours a week.",
        "What do I make in an hour?",
    ),
    turn("That is a value of about 1.6 million: 240,000 / 0.15 = 1,600,000.", "Uncle offers 240k for 15%."),
]
#: The figure the reply's own working is written as coming to, and does not.
WRONG = [
    turn(f"$355.55 is left from a night: {LEFT}."),
    turn(f"$346.55 is left from a night: {LEFT}."),
    turn(f"About $350 is left from a night: {LEFT}."),
    turn(f"{LEFT} = $354.55"),
    turn(f"43 {X} $13 = $561."),
    # A close miss that a two-number reading would let through.
    turn(f"43 {X} $13 = $560."),
    # The right number, the wrong working.
    turn(f"$345.55 is left: 43 {X} $13 − 43 {X} $3.70 − $35."),
    turn(f"43 {X} $13 − 43 {X} $3.70 − 43 {X} $0.45 + $35 = $345.55."),
    # The order of operations: without the brackets it is another sum.
    turn(f"$345.55 is left: 43 {X} $13 − $3.70 − $0.45 − $35."),
    # The right arithmetic, on numbers nobody gave.
    turn(f"$1,057.35 would be left: 123 {X} ($13 − $3.70 − $0.45) − $35 + $3.80."),
    turn("$160,000 is for work: $240,000 ÷ (1 + 50%).", SHARE),
    turn(f"You get $195,440: 80,000 {X} $3.49 {X} (1 − 30%).", STORE),
    turn("You get $195,440: 80,000 x $3.49 x 0.7.", STORE),
    turn("That is worth $2 million: 240,000 / 0.15.", "Uncle offers 240k for 15%."),
]
#: A working that is cut short, or stands on a number, a share or a period that is not theirs, supports nothing.
REFUSED = [
    *WRONG,
    turn(f"$345.55 is left: {LEFT} − tips."),
    turn(f"$345.55 is left: tips + {LEFT}."),
    turn(f"$345.55 is left: 43 {X} (takings − $3.70 − $0.45) − $35."),
    turn(f"$338.05 is left: 43 {X} $13 − 43 {X} $3.70 − 43 {X} $0.45 − $42.50."),
    turn(f"$313.30 is left: 43 {X} $13 − 43 {X} $3.70 − 43 {X} $0.45 − $35 − $32.25."),
    # A percentage taken off as if it were a number, and one nobody called a percentage.
    turn(f"$345.49 is left: 43 {X} ($13 − $3.70 − $0.45) − $35 − 6%."),
    turn(f"$123.79 is left: (43 {X} $13 − 43 {X} $3.70 − 43 {X} $0.45) {X} 35% − $9.40."),
    # Thirty days of a month nobody names, twelve of something else, and a hundred buyers out of the air.
    turn(
        f"It is $10,366.50: (43 {X} ($13 − $3.70 − $0.45) − $35) {X} 30.",
        "We fill 43 seats and the hall keeps 35.",
    ),
    turn(f"12 stalls a month make $4,146.60 a year: (43 {X} ($13 − $3.70 − $0.45) − $35) {X} 12."),
    # A period and a share are multiplied by, never added.
    turn(f"Each day of the year $710.55 is left: 43 {X} ($13 − $3.70 − $0.45) − $35 + 365."),
    turn(f"$850: 100 {X} ($13 − $3.70 − $0.45) − $35."),
    turn("You need 68 rentals: 1,450 / (310 x 7%).", FEE),
]


@pytest.mark.parametrize("t", SUPPORTED)
def test_a_sum_of_theirs_that_comes_out_is_grounded(t: ReplyTurn) -> None:
    assert g.grounded_figures(t).passed, g.grounded_figures(t).detail
    assert strict.no_invented_founder_fact(t).passed, strict.no_invented_founder_fact(t).detail


@pytest.mark.parametrize("t", REFUSED)
def test_a_wrong_sum_or_one_on_other_numbers_is_not(t: ReplyTurn) -> None:
    assert g.grounded_figures(t).passed is False


@pytest.mark.parametrize("t", WRONG)
def test_an_amount_of_such_a_sum_is_made_up(t: ReplyTurn) -> None:
    assert strict.no_invented_founder_fact(t).passed is False


def test_only_whole_expressions_are_read() -> None:
    def values(text: str) -> list[float]:
        return [round(w.value, 4) for w in workings.workings(workings.readable(text))]

    assert values(f"2 + 3 {X} 4, then (2 + 3) {X} 4 and 9 − 4 − 3.") == [14, 20, 2]
    assert values("8 / 4 / 2 and 10 x $2.50 and $12 − 50 cents") == [1, 25, 11.5]
    assert values("1 − 30%, 100% − 30%, 50% x 8") == [0.7, 0.7, 4]
    assert values("just 12 of them, $40 and (3)") == []
    assert values("5 / 0 and 5 − and 5 + x and (5 + y") == []
    # Never deeper or longer than a person would write.
    assert 12 not in values(f"{'(' * 9}1 + 2{')' * 9} {X} 4")
    assert values(" + ".join(["1"] * 60)) == []
    assert values("$40 − 30% and 2 ** 9") == []
    assert values("9-to-5 work, from Monday - 3 of them") == []


def test_a_share_is_multiplied_by_and_never_added() -> None:
    def proven(reply: str) -> frozenset[float]:
        return workings.read(reply, given={4.0, 3.0}, shares={6.0}).proven

    assert proven("0.72 of it: 4 x 3 x 0.06.") == {0.72}
    assert proven("11.28 of it: 4 x 3 x (1 − 0.06).") == {11.28}
    assert proven("12.06 of it: 4 x 3 + 0.06.") == frozenset()
    assert proven("11 of it: 4 x 3 − 1.") == frozenset()


def test_digits_with_a_scale_are_one_figure() -> None:
    t = turn("The whole is worth about 1.6 million.", "He offers 240k for 15%, so 1.6 million?")
    assert g.grounded_figures(t).passed
    # A million is not theirs because 1.6 million is.
    assert g.grounded_figures(replace(t, reply="It is worth a million.")).passed is False


def number(reply: str, founder: str, *wanted: str) -> bool | None:
    t = turn(reply, founder, expect=Expect(kind="coaching", number=wanted))
    return strict.answers_the_number(t).passed


def test_the_number_is_said_to_its_rounding() -> None:
    assert number("$164,383.56 is for work.", SHARE, "164,384")
    assert number("It is 121 seats.", "How many seats?", "120.4")
    assert not number("It is 122 seats.", "How many seats?", "120.4")
    assert not number("It is 41 seats.", "How many seats?", "40.4")
    # A count to reach rounds up; a length of time, an amount and a count that is no target do not.
    assert number("You need 62 rentals.", "How many rentals until it is covered?", "61.2")
    assert not number("You need 63 rentals.", "How many rentals until it is covered?", "61.2")
    assert not number("It lasts 62 months.", "How long until it is gone?", "61.2")
    assert not number("That is 62.", "How many months until it is gone?", "61.2")
    assert not number("You need $62.", "What do I need until Friday?", "61.2")
    assert not number("You can serve 62 people.", "How many can I serve?", "61.2")
    assert not number("You need 7 rentals.", "How many rentals until it is covered?", "6.2")


def test_a_source_that_gives_the_figure_in_words_is_shared_content() -> None:
    evidence = ({"key": "E1", "title": "Spring", "excerpt": "Seventy-two kites were sold in spring."},)
    asked = "We sold seventy-two kites in spring, what if it is at 14 dollars?"
    assert g.supported_citations(
        turn(f"That is $1,008: 72 in spring {X} $14 [E1].", asked, evidence=evidence)
    ).passed
    other = ({"key": "E1", "title": "Spring", "excerpt": "Sixty kites were sold in spring."},)
    assert not g.supported_citations(
        turn(f"That is $1,008: 72 in spring {X} $14 [E1].", asked, evidence=other)
    ).passed
    small = ({"key": "E1", "title": "Spring", "excerpt": "Seven people came in spring."},)
    assert not g.supported_citations(turn("Ask 7 of them before spring [E1].", asked, evidence=small)).passed


def picks(reply: str, founder: str, *options: str) -> bool | None:
    return g.pick(turn(reply, founder, expect=Expect(kind="coaching", pick=options))).passed


def test_a_pick_by_whose_it_is_by_the_time_given_or_in_their_own_words() -> None:
    whose = "My uncle says open a stall, my aunt says rent the oven out. Which?"
    assert picks("Both cost a day. Pick the uncle's idea.", whose, "stall", "oven*")
    assert picks("Go with your aunt's plan.", whose, "stall", "oven*")
    assert not picks(
        "Your uncle's idea adds a place, your aunt's plan adds a buyer.", whose, "stall", "oven*"
    )
    assert not picks("If you pick the uncle's idea, count the hours.", whose, "stall", "oven*")
    assert not picks("Pick the uncle's idea, or the aunt's.", whose, "stall", "oven*")
    assert not picks("Pick the uncle's idea only once ten have paid.", whose, "stall", "oven*")
    assert not picks("Don't pick the uncle's idea.", whose, "stall", "oven*")
    assert not picks("Pick the cousin's idea.", whose, "stall", "oven*")
    two = "Should the week go to the stall or the oven?"
    assert picks("Spend the week on the stall. The oven can wait.", two, "stall", "oven*")
    assert not picks("Spend the week on the stall and the oven.", two, "stall", "oven*")
    assert not picks("Spend an hour on why each could work.", two, "stall", "oven*")
    assert not picks("Spend the week on notes.", "Do I stop, yes or no?", "yes", "no")
    sides = "Do I look for more bakers who HAVE bread or more shops that NEED bread?"
    assert picks("More shops that need bread.", sides, "have", "need")
    assert not picks("More bakers who have bread or more shops that need bread.", sides, "have", "need")
    assert not picks("It depends. More shops that need bread.", sides, "have", "need")
    assert not picks("Soup or stew nights.", "Do we do bread or soup or stew nights?", "bread", "soup")
    assert not picks("More bread.", sides, "have", "need")


STEP = {
    "title": "Find the first ten buyers",
    "items": [{"do": "Make a list", "how": "", "minutes": 20}],
    "doneWhen": "Ten buyers are listed",
    "dueOn": "2026-11-30",
    "template": {"title": "Ten", "body": "Buyer | Price\nNext list of 30: [from where]"},
}


def test_a_line_of_the_steps_own_template_declares_no_step() -> None:
    handed = "Fill it in.\n\nFastest kind: [...]\nNext list of 30: [from where]\n\n**Next:** Find the first ten buyers."
    assert strict.single_step_line(turn(handed, guidance={"step": STEP})).passed
    assert (
        strict.single_step_line(turn(handed, guidance={"step": {**STEP, "template": None}})).passed is False
    )
    twice = handed + "\n\nNext: list thirty names."
    assert strict.single_step_line(turn(twice, guidance={"step": STEP})).passed is False


REFERRAL = {"who": "A patent lawyer; ask the clinic", "bring": "The drawing and the dates."}
SENT = (
    "Talk to a patent lawyer before you show anybody anything. Keep the drawing in a drawer for this month."
)


def again(reply: str, *before: str, referral: object = None) -> bool | None:
    t = turn(
        reply,
        "And if a shop wants to see it?",
        same_session=before,
        guidance={"step": STEP, "referral": referral},
    )
    return strict.repeats_previous_reply(t).passed


def test_who_decides_and_the_paths_step_may_be_said_again() -> None:
    new = (
        "Show the shop the box and not the hinge inside. Keep the drawing in a drawer for this month. "
        "A shop that likes the box will wait a fortnight for the rest. "
        "Talk to a patent lawyer before you show anybody anything."
    )
    assert again(new, SENT, referral=REFERRAL)
    assert again(new, SENT) is False
    # With little else in the reply, it is the reply before it again.
    little = "The shop can wait a fortnight for that. " + SENT
    assert again(little, SENT, referral=REFERRAL) is False
    # Another sentence about a lawyer is not the one that sends them there.
    other = "A patent lawyer costs more than the mould does. The box is cheap to print in the hall."
    assert again(f"{other} Show them the box this time.", other, referral=REFERRAL) is False
    path = "On your path, next is: Say the promise out loud to four people by Monday."
    said = "Forty shops saw the box and three of them asked the price."
    answer = (
        f"Show the shop a box without its hinge. A fortnight is soon enough to show more. {said}\n\n{path}"
    )
    assert again(answer, f"{said}\n\n{path}")
    assert again(f"{said} Show the shop a box.\n\n{path}", f"{said} Show the shop a box.\n\n{path}") is False
