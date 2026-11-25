"""The sums a reply writes out ("$41: 9 x $5 - $4"): read, worked out, and held to the founder's own numbers.

A working supports the figure it comes to only when every operand of it is grounded (said by the founder or their record,
the result of another supported working, a percentage of theirs as a fraction, or the number of days, weeks or months in a
period both of whose ends are named) and it comes to that figure within the figure's own rounding. Nothing is evaluated but
numbers, parentheses and + - x /; what is not read whole supports nothing.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass, field, replace

from conversation_lab.client import reading
from conversation_lab.client.turns import ReplyTurn
from conversation_lab.live.checks import _FIGURE, _SCALE, _WORD_SCALES, _WORD_UNITS

_NUMBER = re.compile(
    r"([$£€]\s?)?(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(?:\s?(k|m|bn|thousand|million|billion)\b)?"
    r"(?:(\s?%)|(\s(?:percent|per cent)\b))?(?![\w])",
    re.IGNORECASE,
)
_TIMES, _OVER, _PLUS, _MINUS = "\u00d7x*", "÷/", "+", "−–-"
#: An operator as a working writes it ("x" only between numbers, never the dash of an aside).
_OPERATOR = re.compile(r"[ \t]*(?:([\u00d7÷*/+−–-])|([xX])(?=[ \t]*[$£€(.\d]))[ \t]*")
_STOP_WORDS = r"(?:and|or|is|are|was|were|to|so|but|then|minus|plus|times|less|divided|by|than|x)\b"
#: What a number counts ("9 tables x $5", "$5 a ride - $2"): words between it and the next operator.
_UNIT = re.compile(
    rf"(?:[ \t]*/[ \t]*[a-z]+|(?:[ \t]+(?!{_STOP_WORDS})[a-z][a-z'-]*){{1,4}})(?=[ \t]*(?:[\u00d7÷*/+−–)-]|[xX][ \t]*[$£€(.\d]))"
)
_CUT_BEFORE = re.compile(
    r"(?:[\u00d7÷*/+−–-]|\b(?:x|minus|plus|times|less|divided by))[ \t]*$", re.IGNORECASE
)
_CUT_AFTER = re.compile(
    r"[ \t]*(?:[\u00d7÷*/+−–]|-|\b(?:x|minus|plus|times|less|divided by)\b)", re.IGNORECASE
)
_MAX_DEPTH, _MAX_ATOMS = 5, 24

#: How many of one period are in another, and the words that must both be there for it.
_PERIODS: tuple[tuple[tuple[float, ...], str, str], ...] = (
    ((4.0, 4.3, 4.33), "week", "month"),
    ((7.0,), "day|dai|night", "week"),
    ((12.0,), "month", "year|annual"),
    ((30.0,), "day|dai|night", "month"),
    ((52.0,), "week", "year|annual"),
    ((60.0,), "minute", "hour"),
    ((24.0,), "hour", "day|dai"),
    ((365.0,), "day|dai|night", "year|annual"),
)
_TIME_NOUN = re.compile(r"(?:minute|hour|day|night|week|month|year)s?\b", re.IGNORECASE)
_HEDGE = re.compile(
    r"(?:\b(?:about|around|roughly|approximately|nearly|almost|close to|just (?:over|under))|[~≈])\s*$",
    re.IGNORECASE,
)
#: A count that must be reached rounds up ("you need 67", "the fewest is 9").
NEEDED = re.compile(
    r"\bneed\w*\b|\bat least\b|\bfewest\b|\bminimum\b|\bbreak(?:s|ing)?[- ]?even\b|\bcovers?\b|\b(?:un)?til\b|\bto match\b|"
    r"\bearn(?:ed)? (?:it |\S+ )?back\b|\bas much as\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Operand:
    value: float
    money: bool
    percent: bool
    #: factor (multiplied, or on either side of a division; a share beside a whole too), whole (the 1 of "1 − 30%"), term.
    role: str = "term"


@dataclass(frozen=True)
class Working:
    start: int
    end: int
    value: float
    operands: tuple[Operand, ...]


@dataclass(frozen=True)
class Stated:
    """One figure as it is written: its value, how fine it is written, and what it is of."""

    start: int
    end: int
    value: float
    unit: float
    hedged: bool
    money: bool
    percent: bool
    after: str


@dataclass(frozen=True)
class Read:
    #: The figures a supported working comes to, and the percentages one does.
    proven: frozenset[float] = frozenset()
    shares: frozenset[float] = frozenset()
    #: The figures written as the result of a working that does not come to them.
    wrong: frozenset[float] = frozenset()
    #: The text with every supported working blanked: what it still states must stand by itself.
    rest: str = ""

    def supports(self, value: float, percent: bool) -> bool:
        return value in (self.shares if percent else self.proven)


# Reading one working -------------------------------------------------------------------------------------------------


class _UnreadableError(ValueError):
    pass


@dataclass
class _Parser:
    text: str
    at: int
    operands: list[Operand] = field(default_factory=list)
    atoms: int = 0

    def operator(self, kinds: str) -> str | None:
        m = _OPERATOR.match(self.text, self.at)
        if m is None:
            return None
        sign = (m.group(1) or m.group(2)).lower()
        if sign not in kinds or self.text.startswith("**", m.start(1) if m.group(1) else m.start(2)):
            return None
        self.at = m.end()
        return sign

    def total(self, depth: int = 0) -> tuple[float, Operand | None]:
        """A sum of products. A lone number comes back as its operand too, so that its place in the sum can be told."""
        value, alone = self.product(depth)
        parts = [(value, alone)]
        while (sign := self.operator(_PLUS + _MINUS)) is not None:
            part, operand = self.product(depth)
            value = value + part if sign == _PLUS else value - part
            parts.append((part, operand))
        if len(parts) == 1:
            return value, alone
        lone = [o for _, o in parts if o is not None and not o.money]
        whole = [o for o in lone if o.value == (100 if o.percent else 1)]
        shares = [o for o in lone if (o.percent or o.value < 1) and o not in whole]
        share_only = len(shares) + len(whole) == len(parts)
        # "$40 − 30%" is not a number less 0.3: only a whole (1) or another share is added to a share.
        if any(o.percent for o in lone) and not share_only:
            raise _UnreadableError
        for i, (_, operand) in enumerate(parts):
            if operand is None:
                continue
            role = "term"
            if shares and share_only:
                role = "factor" if operand in shares else "whole" if i == 0 else "term"
            self.operands.append(replace(operand, role=role))
        return value, None

    def product(self, depth: int) -> tuple[float, Operand | None]:
        value, alone = self.atom(depth)
        while (sign := self.operator(_TIMES + _OVER)) is not None:
            if alone is not None:
                self.operands.append(replace(alone, role="factor"))
                alone = None
            part, operand = self.atom(depth)
            if sign in _OVER and part == 0:
                raise _UnreadableError
            value = value / part if sign in _OVER else value * part
            if operand is not None:
                self.operands.append(replace(operand, role="factor"))
        return value, alone

    def atom(self, depth: int) -> tuple[float, Operand | None]:
        self.atoms += 1
        if depth > _MAX_DEPTH or self.atoms > _MAX_ATOMS:
            raise _UnreadableError
        if self.text.startswith("(", self.at):
            self.at = _past_spaces(self.text, self.at + 1)
            value, alone = self.total(depth + 1)
            if alone is not None:
                self.operands.append(alone)
            self.at = _past_spaces(self.text, self.at)
            if not self.text.startswith(")", self.at):
                raise _UnreadableError
            self.at += 1
            self.unit()
            return value, None
        m = _NUMBER.match(self.text, self.at)
        if m is None or not (m.group(2) or m.group(3)):
            raise _UnreadableError
        value = float((m.group(2) or "0").replace(",", "") + (m.group(3) or ""))
        value = round(value * _SCALE[m.group(4).lower()], 6) if m.group(4) else value
        percent = bool(m.group(5) or m.group(6))
        self.at = m.end()
        self.unit()
        return (value / 100 if percent else value), Operand(value, bool(m.group(1)), percent)

    def unit(self) -> None:
        m = _UNIT.match(self.text, self.at)
        if m is not None:
            self.at = m.end()


def _past_spaces(text: str, at: int) -> int:
    while at < len(text) and text[at] in " \t":
        at += 1
    return at


_BEGINS = re.compile(r"(?<![\w.,$£€])(?:[$£€]\s?)?(?:\d|\.\d)|\(")


def readable(reply: str) -> str:
    """A reply as its workings are read: no citation keys, list numbers or bold marks; cents as dollars."""
    text = reading._LIST_MARK.sub("\n", reading.plain(reply)).replace("**", "").replace("\u00a0", " ")
    return reading._CENTS.sub(lambda m: f"${int(m.group(1)) / 100:.2f}", text)


def workings(text: str) -> list[Working]:
    """Every whole arithmetic expression of a (readable) text, in order. One cut short by what is no number is none."""
    out: list[Working] = []
    at = 0
    while (m := _BEGINS.search(text, at)) is not None:
        parser = _Parser(text, m.start())
        try:
            value, alone = parser.total()
        except (_UnreadableError, OverflowError):
            # A bracket that is none of a sum may hold one; a sum that breaks off supports nothing, nor does its tail.
            at = m.end() if m.group(0) == "(" else max(parser.at, m.end())
            continue
        at = max(parser.at, m.end())
        if alone is not None or len(parser.operands) < 2 or not math.isfinite(value):
            continue
        if _CUT_BEFORE.search(text[: m.start()]) or _CUT_AFTER.match(text, parser.at):
            continue
        out.append(Working(m.start(), parser.at, value, tuple(parser.operands)))
    return out


# The figures a text states ---------------------------------------------------------------------------------------------


def stated(text: str) -> list[Stated]:
    out = []
    for m in _FIGURE.finditer(text):
        currency, whole, frac, scale, pct = m.groups()
        size = _SCALE[scale.lower()] if scale else 1.0
        value = round(float(whole.replace(",", "") + (f".{frac}" if frac else "")) * size, 6)
        rest = text[m.end() : m.end() + 24]
        after = re.match(r"[ \t]+([a-z]+)", rest, re.IGNORECASE)
        word = after.group(1).lower() if after else ""
        out.append(
            Stated(
                m.start(),
                m.end(),
                value,
                size * 10.0 ** -len(frac or ""),
                bool(_HEDGE.search(text[max(0, m.start() - 24) : m.start()])),
                bool(currency) or word in ("dollar", "dollars", "usd", "bucks"),
                bool(pct) or bool(re.match(r"\s(?:percent|per cent)\b", rest, re.IGNORECASE)),
                word,
            )
        )
    return out


def _rounds_to(result: float, f: Stated, needed: bool) -> bool:
    """Whether a result is said as ``f``, to how finely ``f`` is written: "5.91" for 5.907, "$164k" for 164,384, "67" for
    66.82. A whole number stands for a fraction under ten only when it says about."""
    off, slack = abs(result - f.value), 1e-9 * max(1.0, abs(result))
    if f.unit < 1 or (f.unit == 1 and (f.hedged or abs(result) >= 10)):
        close = off <= f.unit / 2 + slack
    elif f.unit == 1:
        close = off <= 0.005
    else:
        close = off <= min(f.unit / 2, 0.01 * abs(result)) + slack
    if close:
        return True
    if f.hedged and f.value and f.value == int(f.value):
        digits = str(int(f.value))
        zeros = 10.0 ** (len(digits) - len(digits.rstrip("0")))
        if off <= min(zeros / 2, 0.01 * abs(result)):
            return True
    count = not (f.money or f.percent or _TIME_NOUN.match(f.after)) and f.value == int(f.value)
    return needed and count and result > 0 and f.value == math.ceil(result - 1e-9)


def _comes_to(w: Working, f: Stated, needed: bool) -> bool:
    hundred = any(o.value == 100 and o.role == "factor" and not (o.money or o.percent) for o in w.operands)
    if f.percent and not hundred:
        return _rounds_to(100 * w.value, f, False)
    return _rounds_to(w.value, f, needed)


def percents(text: str) -> set[float]:
    """Every percentage a text states, in digits or words."""
    found = {f.value for f in reading.figure_list(text) if "percent" in f.classes}
    number = "|".join(sorted({*_WORD_UNITS, *_WORD_SCALES, "hundred"}, key=len, reverse=True))
    for m in re.finditer(rf"((?:\b(?:{number})[\s-]+)+)(?:percent|per cent)\b", text or "", re.IGNORECASE):
        found |= reading.spelled_values(m.group(1))
    return found


def said_values(text: str) -> set[float]:
    """Every number a text gives, an amount that reads like a year ("$2000") with them."""
    return reading.values(text) | {f.value for f in stated(reading.plain(text)) if f.money}


_STEP_LINE = re.compile(r"\bdone when\b|^\W*(?:on your path, )?next\b", re.IGNORECASE)


def _line(text: str, at: int) -> str:
    return text[text.rfind("\n", 0, at) + 1 :].split("\n")[0]


def _period(o: Operand, around: str, text: str, figures: Iterable[Stated]) -> bool:
    """A number of weeks, months ... in a period whose two ends are named; never one the reply counts other things by."""
    if o.money or o.percent or o.role != "factor":
        return False
    for f in figures:
        counts = f.value == o.value and f.after and not _TIME_NOUN.match(f.after)
        if counts and not _STEP_LINE.search(_line(text, f.start)):
            return False
    low = around.lower()
    return any(
        o.value in numbers and re.search(rf"\b(?:{a})", low) and re.search(rf"\b(?:{b})", low)
        for numbers, a, b in _PERIODS
    )


_ENDS = re.compile(r"[.!?]\s")


def _near(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9


_EQUALS = re.compile(
    r"(?:[ \t]+[a-z'-]+){0,4}[ \t]*[=≈][ \t]*(?:about|around|roughly|approximately|nearly|almost|~)?[ \t]*"
)


def _results(text: str, w: Working, found: Iterable[Working], figures: Iterable[Stated]) -> list[Stated]:
    """The figure a working is written as coming to: right after its "=", or the only one before its colon."""
    m = _EQUALS.match(text, w.end)
    if m is not None:
        # "9 x 5 = 45 / 3": what follows is the next sum, not this one's result.
        next_sum = any(o.start == m.end() for o in found)
        return [] if next_sum else [f for f in figures if f.start == m.end()]
    if not text[: w.start].rstrip().endswith(":"):
        return []
    start = max([0, text.rfind("\n", 0, w.start) + 1, *(m.end() for m in _ENDS.finditer(text, 0, w.start))])
    before = [f for f in figures if start <= f.start < w.start]
    return before if len(before) == 1 else []


def read(reply: str, *, given: Iterable[float], shares: Iterable[float], around: str = "") -> Read:
    """What a reply's workings support. ``given``: the founder's and the record's numbers; ``shares``: their percentages;
    ``around``: the founder's message (it may name a period, or ask for a count that must be reached)."""
    text = readable(reply)
    found = workings(text)
    if not found:
        return Read(rest=reply)
    figures = stated(text)
    own, parts = set(given), set(shares)
    proven: set[float] = set()
    proven_shares: set[float] = set()
    periods = f"{text}\n{around}"

    def grounded(o: Operand) -> bool:
        known_shares = parts | proven_shares
        if o.role == "whole":
            return True
        if o.percent:
            return any(_near(o.value, p) for p in known_shares)
        if o.value in own or any(_near(o.value, v) for v in proven):
            return True
        if o.money:
            return False
        if o.role != "factor":
            return False
        if any(_near(o.value, x) for p in known_shares for x in (p / 100, 1 - p / 100, 1 + p / 100)):
            return True
        return _period(o, periods, text, figures)

    supported: list[Working] = []
    open_ = list(found)
    changed = True
    while changed:
        changed = False
        for w in list(open_):
            hundred = [
                o
                for o in w.operands
                if o.value == 100 and o.role == "factor" and not (o.money or o.percent) and not grounded(o)
            ]
            if not all(grounded(o) for o in w.operands if o not in hundred):
                continue
            hit = False
            for f in figures:
                if w.start <= f.start < w.end or (hundred and not f.percent):
                    continue
                if not _comes_to(w, f, _needed(text, f, around)):
                    continue
                (proven_shares if f.percent else proven).add(f.value)
                hit = True
            if hit:
                supported.append(w)
                open_.remove(w)
                changed = True
    wrong = set()
    for w in found:
        results = _results(text, w, found, figures)
        if results and not any(_comes_to(w, f, True) for f in results):
            wrong |= {f.value for f in results}
    rest = text
    for w in supported:
        rest = rest[: w.start] + " " * (w.end - w.start) + rest[w.end :]
    return Read(
        frozenset(proven), frozenset(proven_shares), frozenset(wrong - proven - proven_shares - own), rest
    )


def of_turn(t: ReplyTurn) -> Read:
    """What the workings of a turn's reply support, on what the founder and the venture's record said."""
    theirs = f"{t.founder_said}\n{t.known}"
    before = percents("\n".join(reply for _, reply in t.earlier)) & t.established
    return read(
        t.reply,
        given=said_values(theirs) | t.established,
        shares=percents(theirs) | before,
        around=t.founder,
    )


_LENGTH = re.compile(
    r"\bhow (?:long|many (?:minute|hour|day|night|week|month|year)s)\b|^\W*(?:minute|hour|day|night|week|month|year)s\b",
    re.IGNORECASE,
)


def _needed(text: str, f: Stated, around: str) -> bool:
    """Whether a figure is said as a count that must be reached (never as a length of time)."""
    start = max(text.rfind(c, 0, f.start) for c in ".!?\n") + 1
    said = text[start : f.end + 60].split("\n")[0]
    if _LENGTH.search(around) or _LENGTH.search(said):
        return False
    return bool(NEEDED.search(said) or NEEDED.search(around))


def counts_to_reach(reply: str, around: str) -> set[float]:
    """The whole counts a reply says must be reached."""
    text = readable(reply)
    return {
        f.value
        for f in stated(text)
        if not (f.money or f.percent or _TIME_NOUN.match(f.after))
        and f.value == int(f.value)
        and _needed(text, f, around)
    }
