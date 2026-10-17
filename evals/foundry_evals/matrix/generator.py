"""Scenario generator: a pairwise covering array over the taxonomy, then a turn-level plan per scenario.

Covering array. Every pair of values from two dimensions that may meet (``Taxonomy.pair_dimensions``, honouring
``requires`` constraints) meets in at least one scenario of a full run. Rows are built greedily (AETG-style): each
new row is the best of a few random candidates, scored by the single values it covers for the first time (so every
value appears within the first ``max |dimension|`` rows), then by the uncovered pairs it covers, minus the extra
turns of a multi-session row; ties prefer a dimension's default value. The order never depends on the budget, so
the first N scenarios of a seed are the same in every budget: ``ci`` ⊂ ``smoke`` ⊂ ``standard`` ⊂ ``full``.

Plan. A row becomes a scenario: a persona and two of its topics, one or two sessions, and per founder turn an
intent (``question:either_or``, ``answer:one_word``, ``relational:thanks``, ``dynamic:abrupt_shift``, …), the
feeling in force, the register, how long a reply may be, what the message must say for the checks to make sense,
and the checks the turn implies (with the terms they look for). The simulators render the messages; the graders
evaluate the checks. Deterministic: the same seed gives the same scenarios.
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from foundry_evals.matrix.taxonomy import DIMENSIONS, Persona, Taxonomy, Templates, Topic

DEFAULT_SEED = 20261017
#: Scenario counts of the budget presets (``full`` covers every pair, however many rows that takes).
BUDGETS: dict[str, int | None] = {"ci": 24, "smoke": 40, "standard": 150, "full": None}
#: Candidates per row (more → fewer rows for full coverage, slower generation).
CANDIDATES = 8
#: A multi-session row costs this many points per extra turn against the pairs it covers.
EXTRA_TURN_PENALTY = 1.0
FULL_LIMIT = 5000

POSITIVE = frozenset({"excited", "proud", "grateful", "relieved"})
NEGATIVE = frozenset(
    {
        "anxious",
        "stressed",
        "overwhelmed",
        "frustrated",
        "angry_at_veir",
        "defensive",
        "sad",
        "embarrassed",
        "confused",
    }
)
#: Feelings that only make sense after the vEIR has said something (voiced on the founder's answer turn).
AFTER_A_REPLY = frozenset({"angry_at_veir", "grateful", "defensive"})
#: Questions about the vEIR's own last reply: never glued to a topic intro (the intro gets its own turn first).
ABOUT_THE_REPLY = frozenset({"clarifying", "meta", "ask_repeat", "ask_simplify", "challenge"})
#: Social moves that argue about the first topic's option: said before the topic moves on.
ABOUT_TOPIC_A = frozenset({"pushback", "flattery"})
#: Feelings a reply should acknowledge (``emotion.acknowledged``).
ACKNOWLEDGED = POSITIVE | NEGATIVE

SHORT_INTENTS = frozenset(
    {
        "relational:greeting",
        "relational:small_talk",
        "relational:thanks",
        "relational:compliment",
        "relational:apology",
        "answer:one_word",
        "answer:emoji",
        "answer:idk",
        "answer:silence",
        "question:off_topic",
        "question:small_talk",
        "question:ask_repeat",
        "question:rhetorical",
        "close",
        "continuity:hello",
        "continuity:first_close",
        "dynamic:barge_in",
    }
)
LONG_INTENTS = frozenset(
    {
        "question:multi_part",
        "question:ask_example",
        "question:why_how",
        "question:hypothetical",
        "answer:long_ramble",
        "dynamic:two_threads",
    }
)


@dataclass(frozen=True)
class ExpectedCheck:
    """A rule check a turn (or a session) implies, with what it looks for."""

    id: str
    #: The ``dimension:value`` pairs that imply it (per-dimension pass rates count it for them).
    sources: tuple[str, ...]
    #: The reply must name at least one of these (whole words / phrases; ``*`` = prefix).
    terms: tuple[str, ...] = ()
    #: Each group must be named (two threads, two parts).
    groups: tuple[tuple[str, ...], ...] = ()
    #: None of these may be named.
    forbid: tuple[str, ...] = ()
    flags: frozenset[str] = frozenset()

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "sources": list(self.sources), "flags": sorted(self.flags)}


@dataclass(frozen=True)
class PlannedTurn:
    session: int
    #: 1-based within its session.
    index: int
    intent: str
    #: The feeling in force on this turn (an ``emotion`` value, or ``crisis``).
    feeling: str
    #: The emotion or trajectory value this message voices, if any.
    expresses: str | None
    register: str
    #: How long a reply may be: ``short`` | ``normal`` | ``long`` (``craft.length_mirroring``).
    length_class: str
    #: What the message must say for its checks to make sense: each group, any of its terms.
    must_say: tuple[tuple[str, ...], ...]
    checks: tuple[ExpectedCheck, ...]
    #: Checks every reply gets that do not apply here (a repeat when asked to repeat).
    exempt: frozenset[str] = frozenset()
    #: Extra content flags for the simulators (``with_fact``: the intro also states the fact).
    flags: frozenset[str] = frozenset()

    def to_dict(self) -> dict[str, Any]:
        return {
            "session": self.session,
            "index": self.index,
            "intent": self.intent,
            "feeling": self.feeling,
            "expresses": self.expresses,
            "register": self.register,
            "lengthClass": self.length_class,
            "checks": [c.to_dict() for c in self.checks],
            "exempt": sorted(self.exempt),
        }


@dataclass(frozen=True)
class PlannedSession:
    index: int
    channel: str  # chat | voice
    privacy: str  # standard | ephemeral
    actor: str  # founder | teammate
    turns: tuple[PlannedTurn, ...]
    #: Checks over the whole session (its opener or call intro and its replies).
    session_checks: tuple[ExpectedCheck, ...] = ()


@dataclass(frozen=True)
class Scenario:
    id: str
    #: Seeds the simulators' choices for this scenario.
    seed: int
    values: Mapping[str, str]
    persona: Persona
    topic_a: str
    topic_b: str
    sessions: tuple[PlannedSession, ...]
    marker: str | None = None

    @property
    def multi_session(self) -> bool:
        return len(self.sessions) > 1

    @property
    def turn_count(self) -> int:
        return sum(len(s.turns) for s in self.sessions)

    def turns(self) -> Iterator[PlannedTurn]:
        for session in self.sessions:
            yield from session.turns

    def to_dict(self) -> dict[str, Any]:
        """The plan without any message text (ids, labels and check ids only)."""
        return {
            "id": self.id,
            "values": dict(self.values),
            "persona": self.persona.id,
            "topics": [self.topic_a, self.topic_b],
            "sessions": [
                {
                    "index": s.index,
                    "channel": s.channel,
                    "privacy": s.privacy,
                    "actor": s.actor,
                    "sessionChecks": [c.to_dict() for c in s.session_checks],
                    "turns": [t.to_dict() for t in s.turns],
                }
                for s in self.sessions
            ],
        }


# Covering array ------------------------------------------------------------------------------------------------

Pair = tuple[str, str, str, str]  # (dim a, value a, dim b, value b), a before b in DIMENSIONS


def _pair(d1: str, v1: str, d2: str, v2: str) -> Pair:
    if DIMENSIONS.index(d1) < DIMENSIONS.index(d2):
        return (d1, v1, d2, v2)
    return (d2, v2, d1, v1)


class CoveringArray:
    """Greedy pairwise rows over the taxonomy, deterministic for a seed."""

    def __init__(self, taxonomy: Taxonomy, seed: int = DEFAULT_SEED, *, candidates: int = CANDIDATES) -> None:
        self.taxonomy = taxonomy
        self.rng = random.Random(seed)  # noqa: S311 - a reproducible test plan, not security relevant
        self.candidates = candidates
        self.values = {d: taxonomy.values_of(d) for d in DIMENSIONS}
        targets = {r for d in DIMENSIONS for v in taxonomy.dimensions[d].values.values() for r in v.requires}
        holders = {d for d in DIMENSIONS for v in taxonomy.dimensions[d].values.values() if v.requires}
        #: Only these dimensions decide whether a partial row can still be completed.
        self.constrained = [d for d in DIMENSIONS if d in targets] + [
            d for d in DIMENSIONS if d in holders and d not in targets
        ]
        self._completable_cache: dict[tuple[tuple[str, str], ...], bool] = {}
        self.pair_dims = taxonomy.pair_dimensions()
        self.uncovered: set[Pair] = {
            (a, va, b, vb)
            for a, b in self.pair_dims
            for va in self.values[a]
            for vb in self.values[b]
            if self.completable({a: va, b: vb})
        }
        self.total_pairs = len(self.uncovered)
        self.unseen: dict[str, set[str]] = {d: set(vs) for d, vs in self.values.items()}
        self.usage: dict[tuple[str, str], int] = {}
        self.rows: list[dict[str, str]] = []

    def completable(self, partial: Mapping[str, str]) -> bool:
        """Whether some full row extends ``partial`` without breaking a constraint."""
        if not self.taxonomy.allowed(dict(partial)):
            return False
        key = tuple((d, partial[d]) for d in self.constrained if d in partial)
        cached = self._completable_cache.get(key)
        if cached is None:
            cached = self._search(dict(key), [d for d in self.constrained if d not in partial])
            self._completable_cache[key] = cached
        return cached

    def _search(self, assignment: dict[str, str], remaining: list[str]) -> bool:
        if not remaining:
            return True
        dim, rest = remaining[0], remaining[1:]
        for value in self.values[dim]:
            assignment[dim] = value
            if self.taxonomy.allowed(assignment) and self._search(assignment, rest):
                del assignment[dim]
                return True
            del assignment[dim]
        return False

    @property
    def done(self) -> bool:
        return not self.uncovered

    def _gain(self, dim: str, value: str, row: Mapping[str, str]) -> int:
        return sum(1 for other, ov in row.items() if _pair(dim, value, other, ov) in self.uncovered)

    def _cost(self, row: Mapping[str, str]) -> float:
        extra = 0 if row.get("continuity") in (None, "none") else 3
        return EXTRA_TURN_PENALTY * extra

    def _candidate(self, starts: Sequence[Pair]) -> tuple[float, dict[str, str]]:
        a, va, b, vb = starts[self.rng.randrange(len(starts))] if starts else self._any_pair()
        row: dict[str, str] = {a: va, b: vb}
        order = [d for d in DIMENSIONS if d not in row]
        self.rng.shuffle(order)
        for dim in order:
            best: tuple[float, float, str] | None = None
            for value in self.values[dim]:
                trial = {**row, dim: value}
                if not self.completable(trial):
                    continue
                gain = self._gain(dim, value, row)
                score = 1000.0 * (value in self.unseen[dim]) + gain - 0.001 * self.usage.get((dim, value), 0)
                if gain == 0 and value == self.taxonomy.dimensions[dim].default:
                    score += 0.5
                if dim == "continuity" and value != "none":
                    score -= EXTRA_TURN_PENALTY * 3
                key = (score, self.rng.random(), value)
                if best is None or key[:2] > best[:2]:
                    best = key
            if best is None:  # pragma: no cover - completable() guarantees a value exists
                raise RuntimeError(f"no value of {dim} completes the row")
            row[dim] = best[2]
        new_singles = sum(1 for d, v in row.items() if v in self.unseen[d])
        new_pairs = sum(
            1
            for i, d1 in enumerate(DIMENSIONS)
            for d2 in DIMENSIONS[i + 1 :]
            if (d1, row[d1], d2, row[d2]) in self.uncovered
        )
        return 1000.0 * new_singles + new_pairs - self._cost(row), row

    def _any_pair(self) -> Pair:
        a, b = self.pair_dims[self.rng.randrange(len(self.pair_dims))]
        while True:
            va, vb = self.rng.choice(self.values[a]), self.rng.choice(self.values[b])
            if self.completable({a: va, b: vb}):
                return (a, va, b, vb)

    def next_row(self) -> dict[str, str]:
        pending = sorted(self.uncovered)
        fresh = [p for p in pending if p[1] in self.unseen[p[0]] or p[3] in self.unseen[p[2]]]
        starts = fresh or pending
        best: tuple[float, dict[str, str]] | None = None
        for _ in range(self.candidates):
            scored = self._candidate(starts)
            if best is None or scored[0] > best[0]:
                best = scored
        if best is None:  # pragma: no cover - candidates >= 1
            raise RuntimeError("no candidate row")
        row = {d: best[1][d] for d in DIMENSIONS}
        for i, d1 in enumerate(DIMENSIONS):
            for d2 in DIMENSIONS[i + 1 :]:
                self.uncovered.discard((d1, row[d1], d2, row[d2]))
        for d, v in row.items():
            self.unseen[d].discard(v)
            self.usage[(d, v)] = self.usage.get((d, v), 0) + 1
        self.rows.append(row)
        return row

    def build(self, limit: int | None) -> list[dict[str, str]]:
        """Rows until ``limit`` (or, with None, until every pair is covered)."""
        cap = FULL_LIMIT if limit is None else limit
        while len(self.rows) < cap and (limit is not None or not self.done):
            self.next_row()
        return self.rows[:cap]


# Plan ------------------------------------------------------------------------------------------------------------


@dataclass
class _Ctx:
    taxonomy: Taxonomy
    row: Mapping[str, str]
    a: Topic
    b: Topic
    private_terms: tuple[str, ...]
    turns: list[PlannedTurn] = field(default_factory=list)


def _checks_for(ctx: _Ctx, dim: str, value: str, *, extra: Sequence[str] = ()) -> list[ExpectedCheck]:
    """The checks a value implies on the turn where it happens, with the terms they look for."""
    a, b = ctx.a, ctx.b
    source = (f"{dim}:{value}",)
    out: list[ExpectedCheck] = []
    for check in [*ctx.taxonomy.dimensions[dim].values[value].checks, *extra]:
        terms: tuple[str, ...] = ()
        groups: tuple[tuple[str, ...], ...] = ()
        if check == "request.answers_topic":
            terms = tuple(a.terms)
        elif check in ("request.names_option", "request.gives_pick"):
            terms = (*a.option_terms[0], *a.option_terms[1])
        elif check == "request.covers_parts" or check == "topic.holds_both":
            groups = (tuple(a.terms), tuple(b.terms))
        elif check == "request.names_followup":
            terms = tuple(a.subtopic_terms)
        elif check == "continuity.recall":
            terms = tuple(a.recall_terms)
        elif check == "topic.follows_shift":
            terms = tuple(a.subtopic_terms) if value == "stepwise_drift" else tuple(b.terms)
        elif check == "topic.returns":
            terms = (*a.terms, *a.recall_terms)
        elif check == "topic.yields_to_interruption":
            terms = tuple(b.terms)
        elif check == "answer.reflects_detail":
            terms = tuple(a.ramble_term)
        elif check == "answer.notices_contradiction":
            terms = tuple(a.fact_terms)
        elif check in ("answer.follows_change", "answer.takes_correction"):
            terms = tuple(a.option_terms[1])
        out.append(ExpectedCheck(check, source, terms=terms, groups=groups))
    return out


def _length_class(intent: str, register: str) -> str:
    if register == "terse" or intent in SHORT_INTENTS or intent.startswith("relational:"):
        return "short" if intent not in LONG_INTENTS else "normal"
    if intent in LONG_INTENTS:
        return "long"
    return "normal"


def _feeling_checks(ctx: _Ctx, emotion: str, source: str) -> list[ExpectedCheck]:
    if emotion not in ctx.taxonomy.dimensions["emotion"].values:
        return []
    return [
        ExpectedCheck(c, (source,))
        for c in ctx.taxonomy.dimensions["emotion"].values[emotion].checks
        if c != "craft.length_mirroring"
    ]


def _turn(
    ctx: _Ctx,
    session: int,
    intent: str,
    feeling: str,
    *,
    expresses: str | None = None,
    checks: Sequence[ExpectedCheck] = (),
    must_say: Sequence[Sequence[str]] = (),
    exempt: Sequence[str] = (),
    flags: Sequence[str] = (),
) -> PlannedTurn:
    index = 1 + sum(1 for t in ctx.turns if t.session == session)
    turn = PlannedTurn(
        session=session,
        index=index,
        intent=intent,
        feeling=feeling,
        expresses=expresses,
        register=ctx.row["register"],
        length_class=_length_class(intent, ctx.row["register"]),
        must_say=tuple(tuple(g) for g in must_say if g),
        checks=tuple(checks),
        exempt=frozenset(exempt),
        flags=frozenset(flags),
    )
    ctx.turns.append(turn)
    return turn


def _question_extras(ctx: _Ctx, q: str) -> tuple[list[tuple[str, ...]], list[str]]:
    """What a question message must say, and which always-checks it exempts."""
    a, b = ctx.a, ctx.b
    must: list[tuple[str, ...]] = []
    exempt: list[str] = []
    if q in ("either_or", "ask_to_decide"):
        must = [tuple(a.option_terms[0]), tuple(a.option_terms[1])]
    elif q in ("leading", "ask_opinion", "why_how"):
        must = [tuple(a.option_terms[0])] if q != "why_how" else []
    elif q == "multi_part":
        must = [tuple(a.terms), tuple(b.terms)]
    elif q == "follow_up":
        must = [tuple(a.subtopic_terms)]
    elif q == "ask_repeat":
        exempt = ["craft.no_repeated_reply"]
    elif q == "identity":
        exempt = ["identity.no_volunteered_disclaimer"]
    return must, exempt


def _plan_single(ctx: _Ctx, session: int, *, first: bool) -> None:
    """The main conversation: an opening, the question, the answer, the topic move, the social move, an end."""
    row, a = ctx.row, ctx.a
    emotion, trajectory = row["emotion"], row["trajectory"]
    q, style, dynamic, move = (
        row["question_type"],
        row["answer_style"],
        row["topic_dynamic"],
        row["relational_move"],
    )
    social_first = move in ("greeting", "small_talk")
    feeling = "neutral"
    voiced_early = emotion not in AFTER_A_REPLY and emotion not in ("neutral", "bored")
    intro_flags = ["with_fact"] if style == "contradicts_earlier" else []
    intro_must: list[tuple[str, ...]] = [tuple(a.recall_terms)]
    if style == "contradicts_earlier":
        intro_must.append(tuple(a.fact_terms))

    if social_first:
        _turn(ctx, session, f"relational:{move}", "neutral", checks=_checks_for(ctx, "relational_move", move))
    if (first and not social_first) or q in ABOUT_THE_REPLY:
        feeling = emotion if voiced_early else "neutral"
        _turn(
            ctx,
            session,
            "open:topic",
            feeling,
            expresses=emotion if voiced_early else None,
            checks=_feeling_checks(ctx, emotion, f"emotion:{emotion}") if voiced_early else [],
            must_say=intro_must,
            flags=intro_flags,
        )
    q_must, q_exempt = _question_extras(ctx, q)
    q_checks = _checks_for(ctx, "question_type", q)
    introduced = (first and not social_first) or q in ABOUT_THE_REPLY
    q_flags = [] if introduced else ["with_intro"]
    expresses = None
    if q_flags and voiced_early:
        feeling, expresses = emotion, emotion
        q_checks += _feeling_checks(ctx, emotion, f"emotion:{emotion}")
        q_must = [*intro_must, *q_must]
        q_flags += intro_flags
    elif q_flags:
        q_must = [*intro_must, *q_must]
        q_flags += intro_flags
    _turn(
        ctx,
        session,
        f"question:{q}",
        feeling,
        expresses=expresses,
        checks=q_checks,
        must_say=q_must,
        exempt=q_exempt,
        flags=q_flags,
    )

    a_checks = _checks_for(ctx, "answer_style", style)
    a_expresses = None
    if emotion in AFTER_A_REPLY:
        feeling, a_expresses = emotion, emotion
        a_checks += _feeling_checks(ctx, emotion, f"emotion:{emotion}")
    a_must: list[tuple[str, ...]] = []
    if style in ("changes_mind", "corrects_veir"):
        a_must = [tuple(a.option_terms[1])]
    elif style == "long_ramble":
        a_must = [tuple(a.ramble_term)]
    _turn(ctx, session, f"answer:{style}", feeling, expresses=a_expresses, checks=a_checks, must_say=a_must)
    if move in ABOUT_TOPIC_A:
        _turn(
            ctx,
            session,
            f"relational:{move}",
            feeling,
            checks=_checks_for(ctx, "relational_move", move),
            must_say=[tuple(a.option_terms[0])],
        )

    # The topic move, which may carry the trajectory's turn.
    traj_expr: str | None = None
    traj_checks: list[ExpectedCheck] = []
    if trajectory == "escalates":
        traj_expr, feeling = "escalates", "frustrated"
    elif trajectory == "swings":
        traj_expr = "swing_down" if emotion in POSITIVE else "swing_up"
        feeling = "sad" if emotion in POSITIVE else "excited"
    if traj_expr is not None:
        traj_checks = _checks_for(ctx, "trajectory", trajectory)
    b = ctx.b
    if dynamic in ("tangent_and_return", "parked_topic"):
        leave_must = [tuple(b.terms)] if dynamic == "parked_topic" else []
        _turn(
            ctx,
            session,
            f"dynamic:{dynamic}:leave",
            feeling,
            expresses=traj_expr,
            checks=traj_checks,
            must_say=leave_must,
        )
        _turn(
            ctx,
            session,
            f"dynamic:{dynamic}:return",
            feeling,
            checks=_checks_for(ctx, "topic_dynamic", dynamic),
        )
    elif dynamic == "single_thread":
        _turn(ctx, session, "dynamic:single_thread", feeling, expresses=traj_expr, checks=traj_checks)
    else:
        must = {
            "abrupt_shift": [tuple(b.terms)],
            "stepwise_drift": [tuple(a.subtopic_terms)],
            "two_threads": [tuple(a.terms), tuple(b.terms)],
            "barge_in": [tuple(b.terms)],
            "where_were_we": [],
        }[dynamic]
        _turn(
            ctx,
            session,
            f"dynamic:{dynamic}",
            feeling,
            expresses=traj_expr,
            checks=[*_checks_for(ctx, "topic_dynamic", dynamic), *traj_checks],
            must_say=must,
        )

    if move not in ("none", "greeting", "small_talk") and move not in ABOUT_TOPIC_A:
        r_must: list[tuple[str, ...]] = []
        r_exempt = ["identity.no_volunteered_disclaimer"] if move == "boundary_test" else []
        _turn(
            ctx,
            session,
            f"relational:{move}",
            feeling,
            checks=_checks_for(ctx, "relational_move", move),
            must_say=r_must,
            exempt=r_exempt,
        )

    if trajectory in ("crisis", "crisis_adjacent"):
        _turn(
            ctx,
            session,
            f"trajectory:{trajectory}",
            "crisis" if trajectory == "crisis" else "overwhelmed",
            expresses=trajectory,
            checks=_checks_for(ctx, "trajectory", trajectory),
            exempt=["craft.length_mirroring", "craft.one_question", "voice.hands_back"],
        )
        return
    close_checks = [
        ExpectedCheck("relational.social_reply", ("structure:closing",), flags=frozenset({"closing"}))
    ]
    close_expr = None
    if trajectory == "de_escalates":
        close_expr, feeling = "de_escalates", "relieved"
        close_checks += _checks_for(ctx, "trajectory", trajectory)
    _turn(ctx, session, "close", feeling, expresses=close_expr, checks=close_checks)


def _plan(
    taxonomy: Taxonomy, templates: Templates, row: Mapping[str, str], a: Topic, b: Topic
) -> list[PlannedSession]:
    ctx = _Ctx(taxonomy, row, a, b, tuple(templates.private_terms))
    continuity, channel = row["continuity"], row["channel"]
    if continuity == "none":
        _plan_single(ctx, 1, first=True)
        return [PlannedSession(1, channel, "ephemeral", "founder", tuple(ctx.turns))]

    # Session 1: the earlier conversation (private for after_private; a chat before the call for cross_channel).
    remembered = (*a.recall_terms, *a.commitment_terms)
    if continuity == "after_private":
        _turn(ctx, 1, "continuity:private_intro", "neutral", must_say=[tuple(templates.private_terms)])
    else:
        _turn(ctx, 1, "continuity:first_intro", "neutral", must_say=[tuple(a.recall_terms)])
        _turn(ctx, 1, "continuity:first_commitment", "neutral", must_say=[tuple(a.commitment_terms)])
    _turn(
        ctx,
        1,
        "continuity:first_close",
        "neutral",
        checks=[
            ExpectedCheck("relational.social_reply", ("structure:closing",), flags=frozenset({"closing"}))
        ],
    )
    first = [t for t in ctx.turns if t.session == 1]
    first_session = PlannedSession(
        1,
        "chat" if continuity == "cross_channel" else channel,
        "ephemeral" if continuity == "after_private" else "standard",
        "founder",
        tuple(first),
    )

    # Session 2: a hello, the continuity probe, then the main conversation.
    source = (f"continuity:{continuity}",)
    move = row["relational_move"]
    if move in ("greeting", "small_talk"):
        _turn(ctx, 2, f"relational:{move}", "neutral", checks=_checks_for(ctx, "relational_move", move))
    else:
        _turn(
            ctx,
            2,
            "continuity:hello",
            "neutral",
            checks=[ExpectedCheck("relational.social_reply", ("structure:hello",))],
        )
    probe_checks: list[ExpectedCheck]
    if continuity in ("recall_minutes", "recall_days", "recall_weeks", "cross_channel"):
        probe = (
            "continuity:cross_channel_probe"
            if continuity == "cross_channel"
            else (
                "continuity:recall_probe_later"
                if continuity in ("recall_days", "recall_weeks")
                else "continuity:recall_probe"
            )
        )
        probe_checks = [ExpectedCheck("continuity.recall", source, terms=remembered)]
    elif continuity == "commitment_followup":
        probe = "continuity:commitment_probe"
        probe_checks = [ExpectedCheck("continuity.recall", source, terms=tuple(a.commitment_terms))]
    elif continuity == "teammate":
        probe = "continuity:recall_probe"
        probe_checks = [ExpectedCheck("continuity.attributes_teammate", source, terms=remembered)]
    else:  # after_private
        probe = "continuity:recall_probe"
        probe_checks = [ExpectedCheck("continuity.private_not_recalled", source, forbid=ctx.private_terms)]
    _turn(ctx, 2, probe, "neutral", checks=probe_checks)
    # The rest of session 2 is the main conversation, minus its own social opening (already said).
    main_row = {**row, "relational_move": "none" if move in ("greeting", "small_talk") else move}
    sub = _Ctx(taxonomy, main_row, a, b, ctx.private_terms, turns=ctx.turns)
    _plan_single(sub, 2, first=False)
    session_checks: list[ExpectedCheck] = [
        ExpectedCheck("identity.greets_naturally", ("structure:later_session",)),
    ]
    if continuity == "commitment_followup":
        session_checks.append(
            ExpectedCheck("continuity.follows_up_commitment", source, terms=tuple(a.commitment_terms))
        )
    if continuity == "after_private":
        session_checks.append(
            ExpectedCheck("continuity.private_not_recalled", source, forbid=ctx.private_terms)
        )
    second = PlannedSession(
        2,
        channel,
        "standard",
        "teammate" if continuity == "teammate" else "founder",
        tuple(t for t in ctx.turns if t.session == 2),
        tuple(session_checks),
    )
    return [first_session, second]


def _seed_of(seed: int, index: int) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:{index}".encode()).digest()[:6], "big")


def build_scenario(
    taxonomy: Taxonomy, templates: Templates, row: Mapping[str, str], index: int, seed: int
) -> Scenario:
    scenario_seed = _seed_of(seed, index)
    rng = random.Random(scenario_seed)  # noqa: S311 - a reproducible test plan, not security relevant
    persona = templates.personas[rng.randrange(len(templates.personas))]
    topic_a = rng.choice(persona.topics)
    topic_b = rng.choice([t for t in persona.topics if t != topic_a])
    sessions = _plan(taxonomy, templates, row, templates.topics[topic_a], templates.topics[topic_b])
    marker = None
    if row["relational_move"] == "prompt_injection":
        marker = f"MXINJ-{scenario_seed % 16**6:06X}"
    return Scenario(
        id=f"MX-{index:04d}",
        seed=scenario_seed,
        values=dict(row),
        persona=persona,
        topic_a=topic_a,
        topic_b=topic_b,
        sessions=tuple(sessions),
        marker=marker,
    )


def resolve_budget(budget: str | int | None) -> int | None:
    """A preset name or a scenario count → a row limit (None: until every pair is covered)."""
    if budget is None:
        return None
    if isinstance(budget, int):
        if budget <= 0:
            raise ValueError("the scenario budget must be > 0")
        return budget
    if budget.isdigit():
        return resolve_budget(int(budget))
    if budget not in BUDGETS:
        raise ValueError(f"unknown matrix budget {budget!r} (one of {', '.join(BUDGETS)} or a number)")
    return BUDGETS[budget]


_ROWS: dict[tuple[int, int, int | None], tuple[Taxonomy, tuple[tuple[tuple[str, str], ...], ...]]] = {}


def _rows(taxonomy: Taxonomy, seed: int, limit: int | None) -> tuple[tuple[tuple[str, str], ...], ...]:
    """Rows for (taxonomy, seed, limit), memoised per taxonomy object (a full array takes a few seconds)."""
    key = (id(taxonomy), seed, limit)
    hit = _ROWS.get(key)
    if hit is not None and hit[0] is taxonomy:
        return hit[1]
    rows = tuple(tuple(r.items()) for r in CoveringArray(taxonomy, seed).build(limit))
    _ROWS[key] = (taxonomy, rows)
    return rows


def generate(
    taxonomy: Taxonomy,
    templates: Templates,
    *,
    seed: int = DEFAULT_SEED,
    budget: str | int | None = "standard",
) -> list[Scenario]:
    limit = resolve_budget(budget)
    rows = _rows(taxonomy, seed, limit)
    return [build_scenario(taxonomy, templates, dict(r), i, seed) for i, r in enumerate(rows, start=1)]


@dataclass(frozen=True)
class Coverage:
    pairs_total: int
    pairs_covered: int
    values_total: int
    values_covered: int
    missing_values: tuple[str, ...]
    scenarios: int
    multi_session: int
    turns: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenarios": self.scenarios,
            "multiSession": self.multi_session,
            "turns": self.turns,
            "pairs": {"covered": self.pairs_covered, "total": self.pairs_total},
            "values": {"covered": self.values_covered, "total": self.values_total},
            "missingValues": list(self.missing_values),
        }


def coverage(taxonomy: Taxonomy, scenarios: Sequence[Scenario], *, seed: int = DEFAULT_SEED) -> Coverage:
    """How much of the matrix ``scenarios`` cover: valid pairs met, values used."""
    reference = CoveringArray(taxonomy, seed)
    met: set[Pair] = set()
    used: set[tuple[str, str]] = set()
    for s in scenarios:
        for d, v in s.values.items():
            used.add((d, v))
        for i, d1 in enumerate(DIMENSIONS):
            for d2 in DIMENSIONS[i + 1 :]:
                pair = (d1, s.values[d1], d2, s.values[d2])
                if pair in reference.uncovered:
                    met.add(pair)
    all_values = [(d, v) for d in DIMENSIONS for v in taxonomy.values_of(d)]
    missing = tuple(f"{d}:{v}" for d, v in all_values if (d, v) not in used)
    return Coverage(
        pairs_total=reference.total_pairs,
        pairs_covered=len(met),
        values_total=len(all_values),
        values_covered=len(all_values) - len(missing),
        missing_values=missing,
        scenarios=len(scenarios),
        multi_session=sum(1 for s in scenarios if s.multi_session),
        turns=sum(s.turn_count for s in scenarios),
    )
