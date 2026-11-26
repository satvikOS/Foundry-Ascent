"""The client suite's scenarios (``ops/lab/scenarios/client/*.yaml``): fixed founder lines, so runs are comparable, and
a small simulated adversarial set. Every venture, person and record is invented.

A founder line whose wording is the client's own carries a ``wording`` key ("Q4", "P-Q4"): its committed ``say`` is our
equivalent, and the exact text replaces it when the run was given the client's pack (``client/pack.py``); the report
says which was used. Dates in lines and records are relative to the run's day (``{date+9}``, ``{weekday+3}``), so a
scenario never ages.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from conversation_lab.client.rubric import CRITERIA, EXTRA, QUESTIONS
from conversation_lab.config import SCENARIOS_DIR

CLIENT_DIR = SCENARIOS_DIR / "client"
#: Run order: the client's own protocol and questions first, so a budget stop cuts the least important.
GROUPS: tuple[str, ...] = (
    "protocol",
    "questions",
    "organise",
    "calls",
    "arcs",
    "numbers",
    "news",
    "followups",
    "novice",
    "odd",
    "memory",
    "hard",
    "repeats",
    "adversarial",
    "heldout",
    "heldoutb",
    "heldoutc",
    "heldoutd",
)
#: Never tuned against, and beside the whole set's price: played only when the group or the scenario is named.
HELD_OUT = frozenset({"heldout", "heldoutb", "heldoutc", "heldoutd"})
KINDS = frozenset({"coaching", "report", "recall", "social", "rehearsal", "new_idea", "crisis", "privacy"})
#: Kinds whose reply must carry a next step (the reply contract's exemptions: social, recall, rehearsal, crisis).
STEP_KINDS = frozenset({"coaching", "report", "new_idea"})
CHANNELS = frozenset({"chat", "call"})
ROLES = frozenset({"undergrad", "grad", "phd", "any"})
STAGES = frozenset(
    {"idea", "discovery", "validation", "business_model", "commercialization", "growth", "transition"}
)
DOMAINS = frozenset(
    {"consumer", "software", "hardware", "biomedical", "clinical", "energy", "social", "general"}
)
MEMORY_TYPES = frozenset(
    {
        "fact",
        "hypothesis",
        "decision",
        "experiment",
        "evidence",
        "action",
        "milestone",
        "risk",
        "preference",
        "relationship",
        "insight",
    }
)
#: Who a referral may name, by kind (the graders' ``REFERRAL_ROLES``).
REFERRALS = frozenset({"ip", "legal", "valuation", "equity", "immigration", "regulatory"})
_ID = re.compile(r"^[A-Z]{2}-[0-9]{2}$")
_FACT = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
_WORDING = re.compile(r"^(?:Q[0-9]{1,2}|P-(?:setup|X1|Q[0-9]{1,2}))$")
_TEMPLATE = re.compile(r"\{(date|weekday|iso)([+-]\d{1,3})\}")


class ScenarioError(ValueError):
    """A scenario file that does not match the schema (ids and field names only, never content)."""


@dataclass(frozen=True)
class Expect:
    kind: str = "coaching"
    #: Human referral kinds the reply must name a person or office for.
    referral: tuple[str, ...] = ()
    #: Friends' approval is offered as proof: the reply must say it is not and what would be.
    challenge_friends: bool = False
    #: The founder asks for praise: no flattery, an honest risk and the test that would prove it.
    no_flattery: bool = False
    #: The founder asks what another founder is doing: nothing of it, and a plain statement of separation.
    other_venture: bool = False
    #: Facts (scenario ``facts`` ids) the reply must state.
    remember: tuple[str, ...] = ()
    #: The reply must name at least one of the venture's earlier facts (``history`` ids, else any fact).
    history: tuple[str, ...] = ()
    #: An "A or B" question: the options, one of which (or an order) must be picked.
    pick: tuple[str, ...] = ()
    #: The founder reported the open step done: the step named now is a different one.
    advances: bool = False
    #: The reply must not be a crisis or policy block.
    must_answer: bool = True
    #: The step must fit the founder's stated hours per week.
    fits_hours: int | None = None
    #: The figure asked for, computable from the conversation or the record: any one of these values must be said.
    number: tuple[str, ...] = ()
    #: The founder brings a result: the reply must name at least one of these facts and say what it means.
    news: tuple[str, ...] = ()
    #: The founder is new to this and says so (or said so before): plain words, on their own idea.
    adapt: bool = False


@dataclass(frozen=True)
class FounderTurn:
    say: str
    q: str | None = None
    wording: str | None = None
    expect: Expect = field(default_factory=Expect)
    #: Criteria the judge scores this reply on besides a question's own.
    judge: tuple[str, ...] = ()
    #: A simulated turn: what the founder wants (``say`` is the line used without a simulator).
    intent: str | None = None
    emotion: str = "neutral"
    register: str = "casual"


@dataclass(frozen=True)
class SessionPlan:
    channel: str
    gap_days: int
    turns: tuple[FounderTurn, ...]
    #: Facts the opening line must name (the last commitment, for a returning founder).
    opener: tuple[str, ...] = ()


@dataclass(frozen=True)
class RecordItem:
    type: str
    title: str
    content: str
    days_ago: int


@dataclass(frozen=True)
class Scenario:
    id: str
    group: str
    title: str
    role: str
    founder: str
    studies: str
    first_time: bool
    venture: Mapping[str, str]
    sessions: tuple[SessionPlan, ...]
    record: tuple[RecordItem, ...] = ()
    intake: Mapping[str, Any] | None = None
    facts: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    neighbour: Mapping[str, Any] | None = None
    repeat: int = 1
    #: Turns (``1.2``) that ask the same thing in other words: the step they get must be the same one.
    same_step: tuple[str, ...] = ()
    #: What a passing conversation does, for the judge.
    passing: str = ""

    @property
    def turns(self) -> int:
        return self.repeat * sum(len(s.turns) for s in self.sessions)

    @property
    def known_text(self) -> str:
        """Everything the coach may legitimately know before the founder speaks: the venture and its record."""
        v = self.venture
        parts = [v["name"], v["oneLiner"], v["goal"], self.founder, self.studies]
        parts += [f"{r.title} {r.content}" for r in self.record]
        if self.intake:
            parts += _leaf_strings(self.intake)
        return "\n".join(parts)


def _leaf_strings(value: Any) -> list[str]:
    if isinstance(value, Mapping):
        return [s for v in value.values() for s in _leaf_strings(v)]
    if isinstance(value, list | tuple):
        return [s for v in value for s in _leaf_strings(v)]
    return [] if value is None or isinstance(value, bool) else [str(value)]


# Dates -------------------------------------------------------------------------------------------------------


def fill_dates(text: str, today: dt.date) -> str:
    """``{date+9}`` -> "December 3", ``{weekday+3}`` -> "Friday", ``{iso+9}`` -> "2026-12-03"."""

    def one(match: re.Match[str]) -> str:
        day = today + dt.timedelta(days=int(match.group(2)))
        if match.group(1) == "iso":
            return day.isoformat()
        return day.strftime("%A") if match.group(1) == "weekday" else f"{day:%B} {day.day}"

    return _TEMPLATE.sub(one, text)


def _filled(value: Any, today: dt.date) -> Any:
    if isinstance(value, str):
        return fill_dates(value, today)
    if isinstance(value, Mapping):
        return {k: _filled(v, today) for k, v in value.items()}
    if isinstance(value, list):
        return [_filled(v, today) for v in value]
    return value


# Loading -----------------------------------------------------------------------------------------------------


def _take(raw: Any, where: str, required: Iterable[str], optional: Iterable[str] = ()) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ScenarioError(f"{where}: not a mapping")
    names = {*required, *optional}
    unknown, missing = set(raw) - names, set(required) - set(raw)
    if unknown:
        raise ScenarioError(f"{where}: unknown field {sorted(map(str, unknown))[0]}")
    if missing:
        raise ScenarioError(f"{where}: missing field {sorted(missing)[0]}")
    return dict(raw)


def _one_of(value: Any, allowed: Iterable[str], where: str) -> str:
    if value not in set(allowed):
        raise ScenarioError(f"{where}: not an allowed value")
    return str(value)


def _strings(value: Any, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ScenarioError(f"{where}: not a list of strings")
    return tuple(value)


def _facts_named(value: Any, facts: Mapping[str, Any], where: str) -> tuple[str, ...]:
    names = _strings(value, where)
    for name in names:
        if name not in facts:
            raise ScenarioError(f"{where}: unknown fact {name}")
    return names


def _numbers(value: Any, where: str) -> tuple[str, ...]:
    found = _strings(value, where)
    for n in found:
        if not re.fullmatch(r"\d[\d,]*(?:\.\d+)?", n):
            raise ScenarioError(f"{where}: not a number")
    return found


def _expect(raw: Any, facts: Mapping[str, Any], where: str) -> Expect:
    e = _take(
        raw,
        where,
        (),
        (
            "kind",
            "referral",
            "challenge_friends",
            "no_flattery",
            "other_venture",
            "remember",
            "history",
            "pick",
            "advances",
            "must_answer",
            "fits_hours",
            "number",
            "news",
            "adapt",
        ),
    )
    referral = _strings(e.get("referral", []), f"{where}.referral")
    for r in referral:
        _one_of(r, REFERRALS, f"{where}.referral")
    history = e.get("history", [])
    return Expect(
        kind=_one_of(e.get("kind", "coaching"), KINDS, f"{where}.kind"),
        referral=referral,
        challenge_friends=bool(e.get("challenge_friends", False)),
        no_flattery=bool(e.get("no_flattery", False)),
        other_venture=bool(e.get("other_venture", False)),
        remember=_facts_named(e.get("remember", []), facts, f"{where}.remember"),
        history=_facts_named(history, facts, f"{where}.history"),
        pick=_strings(e.get("pick", []), f"{where}.pick"),
        advances=bool(e.get("advances", False)),
        must_answer=bool(e.get("must_answer", True)),
        fits_hours=int(e["fits_hours"]) if e.get("fits_hours") is not None else None,
        number=_numbers(e.get("number", []), f"{where}.number"),
        news=_facts_named(e.get("news", []), facts, f"{where}.news"),
        adapt=bool(e.get("adapt", False)),
    )


def _turn(raw: Any, facts: Mapping[str, Any], where: str) -> FounderTurn:
    t = _take(raw, where, ("say",), ("q", "wording", "expect", "judge", "intent", "emotion", "register"))
    q = t.get("q")
    if q is not None and q not in QUESTIONS and q not in EXTRA:
        raise ScenarioError(f"{where}.q: unknown question")
    wording = t.get("wording")
    if wording is not None and not _WORDING.match(str(wording)):
        raise ScenarioError(f"{where}.wording: malformed")
    judged = _strings(t.get("judge", []), f"{where}.judge")
    for name in judged:
        _one_of(name, CRITERIA, f"{where}.judge")
    return FounderTurn(
        say=str(t["say"]).strip(),
        q=q,
        wording=wording,
        expect=_expect(t.get("expect", {}), facts, f"{where}.expect"),
        judge=judged,
        intent=t.get("intent"),
        emotion=str(t.get("emotion", "neutral")),
        register=str(t.get("register", "casual")),
    )


def _session(raw: Any, facts: Mapping[str, Any], where: str) -> SessionPlan:
    s = _take(raw, where, ("turns",), ("channel", "gap_days", "opener"))
    gap = s.get("gap_days", 0)
    if not isinstance(gap, int) or not 0 <= gap <= 60:
        raise ScenarioError(f"{where}.gap_days: 0 to 60")
    turns = tuple(_turn(t, facts, f"{where}.turns[{i}]") for i, t in enumerate(s["turns"], start=1))
    if not turns:
        raise ScenarioError(f"{where}: no turns")
    return SessionPlan(
        channel=_one_of(s.get("channel", "chat"), CHANNELS, f"{where}.channel"),
        gap_days=gap,
        turns=turns,
        opener=_facts_named(s.get("opener", []), facts, f"{where}.opener"),
    )


def parse_scenario(raw: Any, group: str) -> Scenario:
    head = raw.get("id") if isinstance(raw, Mapping) else None
    if not isinstance(head, str) or not _ID.match(head):
        raise ScenarioError("a scenario without a valid id")
    s = _take(
        raw,
        head,
        ("id", "title", "role", "founder", "venture", "sessions"),
        (
            "studies",
            "first_time",
            "record",
            "intake",
            "facts",
            "neighbour",
            "repeat",
            "same_step",
            "passing",
        ),
    )
    venture = _take(s["venture"], f"{head}.venture", ("name", "oneLiner", "stage", "domain", "goal"))
    _one_of(venture["stage"], STAGES, f"{head}.venture.stage")
    _one_of(venture["domain"], DOMAINS, f"{head}.venture.domain")
    facts: dict[str, tuple[str, ...]] = {}
    for name, words in (s.get("facts") or {}).items():
        if not _FACT.match(str(name)):
            raise ScenarioError(f"{head}.facts: malformed name")
        facts[str(name)] = _strings(words, f"{head}.facts.{name}")
    record = []
    for i, item in enumerate(s.get("record") or [], start=1):
        r = _take(item, f"{head}.record[{i}]", ("type", "title", "content"), ("days_ago",))
        record.append(
            RecordItem(
                _one_of(r["type"], MEMORY_TYPES, f"{head}.record[{i}].type"),
                str(r["title"]),
                str(r["content"]),
                int(r.get("days_ago", 14)),
            )
        )
    neighbour = s.get("neighbour")
    if neighbour is not None:
        neighbour = _take(neighbour, f"{head}.neighbour", ("venture", "founder", "secret"), ("leaks",))
    repeat = s.get("repeat", 1)
    if not isinstance(repeat, int) or not 1 <= repeat <= 5:
        raise ScenarioError(f"{head}.repeat: 1 to 5")
    sessions = tuple(
        _session(x, facts, f"{head}.sessions[{i}]") for i, x in enumerate(s["sessions"], start=1)
    )
    if not sessions or sessions[0].gap_days != 0:
        raise ScenarioError(f"{head}.sessions: the first session has no gap")
    if repeat > 1 and len(sessions) != 1:
        raise ScenarioError(f"{head}: a repeated scenario has one session")
    same_step = _strings(s.get("same_step", []), f"{head}.same_step")
    positions = {f"{i}.{n}" for i, x in enumerate(sessions, 1) for n in range(1, len(x.turns) + 1)}
    if len(same_step) == 1 or set(same_step) - positions:
        raise ScenarioError(f"{head}.same_step: not two or more turns of the scenario")
    return Scenario(
        id=head,
        group=group,
        title=str(s["title"]),
        role=_one_of(s["role"], ROLES, f"{head}.role"),
        founder=str(s["founder"]),
        studies=str(s.get("studies", "")),
        first_time=bool(s.get("first_time", False)),
        venture={k: str(v) for k, v in venture.items()},
        sessions=sessions,
        record=tuple(record),
        intake=s.get("intake"),
        facts=facts,
        neighbour=neighbour,
        repeat=repeat,
        same_step=same_step,
        passing=str(s.get("passing", "")),
    )


@dataclass(frozen=True)
class ClientSet:
    scenarios: tuple[Scenario, ...]
    #: "exact" when every worded line came from the client's pack, "equivalent" when none did, else "mixed".
    wording: str = "equivalent"

    def by_id(self) -> dict[str, Scenario]:
        return {s.id: s for s in self.scenarios}

    @property
    def turns(self) -> int:
        return sum(s.turns for s in self.scenarios)


def load(today: dt.date, wording: Mapping[str, str] | None = None, directory: Path = CLIENT_DIR) -> ClientSet:
    """Every scenario, in run order, with dates filled for ``today`` and the client's exact wording laid over ours
    where ``wording`` has it."""
    found: list[Scenario] = []
    for path in sorted(directory.glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        top = _take(doc, path.name, ("group", "scenarios"))
        group = _one_of(top["group"], GROUPS, f"{path.name}.group")
        found += [parse_scenario(_filled(raw, today), group) for raw in top["scenarios"]]
    ids = [s.id for s in found]
    if len(ids) != len(set(ids)):
        raise ScenarioError("duplicate scenario id")
    given = dict(wording or {})
    used: list[bool] = []

    def overlay(t: FounderTurn) -> FounderTurn:
        if t.wording is None:
            return t
        exact = given.get(t.wording)
        used.append(exact is not None)
        return t if exact is None else replace(t, say=exact)

    found = [
        replace(
            s,
            sessions=tuple(replace(x, turns=tuple(overlay(t) for t in x.turns)) for x in s.sessions),
        )
        for s in found
    ]
    found.sort(key=lambda s: GROUPS.index(s.group))
    state = "exact" if used and all(used) else "equivalent" if not any(used) else "mixed"
    return ClientSet(tuple(found), state)


def choose(scenarios: Sequence[Scenario], ids: Sequence[str]) -> list[Scenario]:
    if not ids:
        return list(scenarios)
    missing = sorted(set(ids) - {s.id for s in scenarios})
    if missing:
        raise ScenarioError(f"unknown scenario ids: {', '.join(missing)}")
    return [s for s in scenarios if s.id in set(ids)]
