"""What every client grader reads: one exchange with its own guidance and evidence, and what a grade is."""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from conversation_lab.client import reading
from conversation_lab.client.scenarios import STEP_KINDS, Expect


@dataclass(frozen=True)
class Grade:
    #: None: the grader does not apply to this turn.
    passed: bool | None
    detail: str = ""


NA = Grade(None)
PASS = Grade(True)


def fail(detail: str = "") -> Grade:
    return Grade(False, detail[:240])


def verdict(ok: bool, detail: str = "") -> Grade:
    return PASS if ok else fail(detail)


@dataclass(frozen=True)
class ReplyTurn:
    """One exchange as the graders read it."""

    founder: str
    reply: str
    channel: str = "chat"
    #: completed | blocked | error
    kind: str = "completed"
    expect: Expect = field(default_factory=Expect)
    guidance: Mapping[str, Any] | None = None
    evidence: tuple[Mapping[str, Any], ...] = ()
    #: Founder and coach texts of the earlier turns (every session of the scenario), oldest first.
    earlier: tuple[tuple[str, str], ...] = ()
    #: The venture, its record, the founder's intake: what the coach may know before anyone speaks.
    known: str = ""
    facts: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    first_time: bool = False
    founder_name: str = ""
    venture_name: str = ""
    neighbour: Mapping[str, Any] | None = None
    today: dt.date | None = None
    #: The step of the turn before (``reading.step_key``), for a reported step.
    previous_step: str | None = None
    #: Figures and dates of earlier replies that were grounded there (a recall may state a result without its working).
    established: frozenset[float] = frozenset()
    established_dates: frozenset[tuple[int, int]] = frozenset()
    #: How many replies in a row, just before this one, named the path's step to a founder who asked something else
    #: (:func:`nags`).
    nagged_before: int = 0
    #: The coach's earlier replies in this same session, oldest first.
    same_session: tuple[str, ...] = ()

    @property
    def text(self) -> str:
        return reading.plain(self.reply)

    @property
    def step(self) -> Mapping[str, Any] | None:
        return reading.step_of(self.guidance)

    @property
    def path_step(self) -> Mapping[str, Any] | None:
        """The path's own open step, when the turn's step answers what they asked instead."""
        step = (self.guidance or {}).get("pathStep")
        return step if isinstance(step, Mapping) else None

    @property
    def wants_step(self) -> bool:
        return self.expect.kind in STEP_KINDS

    @property
    def shown(self) -> str:
        """What the founder reads: the reply, and on a typed turn the card under it."""
        return self.text if self.channel == "call" else f"{self.text}\n{reading.leaf_text(self.guidance)}"

    @property
    def founder_said(self) -> str:
        return "\n".join([*(f for f, _ in self.earlier), self.founder])

    @property
    def sources(self) -> str:
        """Where a figure, date or name may come from."""
        evidence = "\n".join(f"{e.get('title', '')} {e.get('excerpt', '')}" for e in self.evidence)
        return "\n".join(
            (self.founder_said, self.known, reading.leaf_text(self.guidance), evidence, self.founder_name)
        )


#: They ask what is next, or where they stand: the path's own step is what they asked for.
_ASKS_NEXT = re.compile(
    r"\b(?:what(?:'s| is| do i| should i| now| comes)?[^?.!]{0,24}\bnext\b|next steps?\b|what now\b|where (?:am i|are we|do (?:i|we) stand)|"
    r"organi[sz]ed?\b|my path\b|where (?:do|should) i (?:start|begin)|what should i (?:do|work on|focus on))",
    re.IGNORECASE,
)


def asks_next(founder: str) -> bool:
    return bool(_ASKS_NEXT.search(reading.plain(founder)))


def fact_named(text: str, synonyms: Sequence[str]) -> bool:
    low = reading.plain(text).lower()
    squeezed = low.replace(",", "")
    said = reading.values(text)
    for s in synonyms:
        word = s.lower().strip()
        number = re.fullmatch(r"\$?(\d+(?:\.\d+)?)%?", word.replace(",", ""))
        if number and float(number.group(1)) in said:
            return True
        tail = r"\w*" if word.endswith("*") else r"(?!\w)"
        if re.search(r"(?<!\w)" + re.escape(word.rstrip("*")) + tail, squeezed if number else low):
            return True
    return False
