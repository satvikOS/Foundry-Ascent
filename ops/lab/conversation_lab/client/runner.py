"""Plays the client scenarios against the app: real sessions and typed-input calls in order, days passing between them,
every reply graded against its own guidance and evidence as the API returned it, the client's questions scored by the
judge. Failures and refusals are results: they count in every denominator.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import threading
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from conversation_lab.budget import BudgetExceededError
from conversation_lab.client import reading
from conversation_lab.client.app import Seeded, founder_intake, raw_turn, save_intake, save_profile
from conversation_lab.client.graders import Grade, ReplyTurn, grade_turn, nags, opener_names, same_step
from conversation_lab.client.judge import Scorecard, capped, card_text, reply_prompt
from conversation_lab.client.rubric import CRITERIA, question, weighted
from conversation_lab.client.scenarios import FounderTurn, Scenario, SessionPlan
from conversation_lab.live.runner import RETRY_CODES, RETRY_PAUSE_SECONDS, STOP_CODES, heard

#: What one turn may plausibly cost the app, reserved per planned turn before a scenario starts.
TURN_RESERVE_USD = 0.008


@dataclass
class TurnResult:
    at: str
    session: int
    channel: str
    plan: FounderTurn
    founder: str
    reply: str = ""
    kind: str = "error"
    error: str | None = None
    seconds: float = 0.0
    first_token_ms: int | None = None
    cost_usd: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    model: str | None = None
    guidance: dict[str, Any] | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    escalated: bool = False
    notes: list[str] = field(default_factory=list)
    grades: dict[str, Grade] = field(default_factory=dict)
    card: Scorecard | None = None
    #: Replies in a row up to this one that named the path's own step to a founder who asked something else.
    nag_row: int = 0

    @property
    def step_key(self) -> str | None:
        return reading.step_key(reading.step_of(self.guidance))

    @property
    def criteria(self) -> tuple[str, ...]:
        """What the judge scores: the question's criteria and the turn's own, in the sheet's order."""
        wanted = set(self.plan.judge)
        if self.plan.q:
            wanted |= set(question(self.plan.q).criteria)
        return tuple(c for c in CRITERIA if c in wanted)

    def public(self) -> dict[str, Any]:
        step = reading.step_of(self.guidance)
        return {
            "at": self.at,
            "channel": self.channel,
            "q": self.plan.q,
            "kind": self.kind,
            "error": self.error,
            "seconds": round(self.seconds, 2),
            "first_token_ms": self.first_token_ms,
            "cost_usd": None if self.cost_usd is None else round(self.cost_usd, 6),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "model": self.model,
            "guidance": None
            if self.guidance is None
            else {
                "intent": self.guidance.get("intent"),
                "play": self.guidance.get("playId"),
                "stage": self.guidance.get("stage"),
                "step": None if step is None else step.get("playId") or step.get("criterionId"),
                "referral": self.guidance.get("referral") is not None,
            },
            "escalated": self.escalated,
            "passed": sorted(k for k, g in self.grades.items() if g.passed),
            "failed": sorted(k for k, g in self.grades.items() if g.passed is False),
            "scores": self.card.public() if self.card else None,
        }

    def private(self) -> dict[str, Any]:
        return {
            **self.public(),
            "founder": self.founder,
            "reply": self.reply,
            "card": card_text(self.guidance),
            "guidance_full": self.guidance,
            "evidence": self.evidence,
            "why": {k: g.detail for k, g in self.grades.items() if g.passed is False},
            "judge_note": self.card.note if self.card else None,
            "judge_checks": self.card.checks if self.card else None,
            "judge_reasons": self.card.reasons if self.card else None,
            "weighted": weighted(self.card.scores) if self.card else None,
            "notes": self.notes,
        }


@dataclass
class ScenarioResult:
    scenario: Scenario
    #: completed | failed | stopped | skipped | error
    status: str = "not_run"
    reason: str = ""
    turns: list[TurnResult] = field(default_factory=list)
    openers: list[str] = field(default_factory=list)
    #: Grades of the whole scenario: the openers, and the repeats' same step.
    grades: dict[str, Grade] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    @property
    def failures(self) -> list[str]:
        out = [f"{t.at}:{k}" for t in self.turns for k, g in t.grades.items() if g.passed is False]
        return sorted(out) + sorted(k for k, g in self.grades.items() if g.passed is False)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.scenario.id,
            "group": self.scenario.group,
            "status": self.status,
            "reason": self.reason,
            "planned_turns": self.scenario.turns,
            "turns": [t.public() for t in self.turns],
            "scenario_failed": sorted(k for k, g in self.grades.items() if g.passed is False),
            "notes": sorted(set(self.notes)),
        }

    def private(self) -> dict[str, Any]:
        return {
            **self.public(),
            "title": self.scenario.title,
            "openers": self.openers,
            "transcript": [t.private() for t in self.turns],
            "scenario_why": {k: g.detail for k, g in self.grades.items() if g.passed is False},
        }


class ClientRunner:
    def __init__(
        self,
        *,
        app: Any,
        simulator: Any,
        judge: Any | None,
        today: dt.date,
        guard: Any = None,
        private_dir: Path | None = None,
        concurrency: int = 4,
        deadline_seconds: float | None = None,
        clock: Callable[[], float] = time.monotonic,
        pause: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] = print,
    ) -> None:
        self.app = app
        self.simulator = simulator
        self.judge = judge
        self.today = today
        self.guard = guard
        self.private_dir = private_dir
        self.concurrency = max(1, concurrency)
        self.deadline = None if deadline_seconds is None else clock() + deadline_seconds
        self.clock = clock
        self._pause = pause
        self._log = log
        self._lock = threading.Lock()
        self.stopped: str | None = None

    # Scheduling -------------------------------------------------------------------------------------------------

    def run(self, scenarios: Sequence[Scenario], seeded: Mapping[str, Seeded]) -> list[ScenarioResult]:
        results = {s.id: ScenarioResult(s) for s in scenarios}

        def one(s: Scenario) -> None:
            r = results[s.id]
            if self.stopped:
                r.status, r.reason = "skipped", self.stopped
            elif self.deadline is not None and self.clock() > self.deadline:
                r.status, r.reason = "skipped", "time"
            elif s.id not in seeded:
                r.status, r.reason = "error", "not_seeded"
            else:
                try:
                    if self.guard is not None:
                        with getattr(self.app, "lock", self._lock):
                            self.guard.check_app(reserve=TURN_RESERVE_USD * s.turns)
                    r.status = "running"
                    self.play(r, seeded[s.id])
                except BudgetExceededError as exc:
                    reason = f"budget_{exc.side}"
                    with self._lock:
                        self.stopped = self.stopped or reason
                    r.status, r.reason = ("stopped" if r.turns else "skipped"), reason
                except Exception as exc:  # noqa: BLE001 - recorded by class name; the run goes on
                    r.status, r.reason = "error", type(exc).__name__
            self._write(r)
            self._log(
                f"client: {s.id} {r.status} turns={len(r.turns)} failed={len(r.failures)}"
                + (f" reason={r.reason}" if r.reason else "")
            )

        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            list(pool.map(one, scenarios))
        return [results[s.id] for s in scenarios]

    def _write(self, r: ScenarioResult) -> None:
        if self.private_dir is None:
            return
        folder = self.private_dir / "client"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{r.scenario.id}.json").write_text(json.dumps(r.private(), indent=1), encoding="utf-8")

    # One scenario -----------------------------------------------------------------------------------------------

    def play(self, r: ScenarioResult, seed: Seeded) -> None:
        s = r.scenario
        client = self.app.founder_client(seed.founder_id)
        try:
            intake = founder_intake(s)
            if intake is not None:
                r.notes.append("profile:" + save_profile(client, seed.venture_id, s))
                r.notes.append("intake:" + save_intake(client, seed.venture_id, intake))
            sessions = list(s.sessions) * s.repeat
            for index, plan in enumerate(sessions, start=1):
                last = index == len(sessions)
                session_id, ok = self._session(r, client, seed, index, plan, last=last)
                if not ok:
                    r.status = "failed"
                    r.reason = (
                        next((t.error for t in reversed(r.turns) if t.error), "turn_failed") or "turn_failed"
                    )
                    break
                if index < len(sessions) and s.repeat == 1:
                    gap = sessions[index].gap_days
                    failure = self.app.between_sessions(session_id, gap)
                    r.notes.append("aged" if failure is None else f"aging_failed:{failure}")
                    age = getattr(self.app, "age_path", None)
                    if age is not None:
                        failure = age(seed.venture_id, gap)
                        r.notes.append("path_aged" if failure is None else f"path_aging_failed:{failure}")
            else:
                r.status = "completed"
        finally:
            with contextlib.suppress(Exception):
                client.close()
            self.grade(r)
        self._score(r)

    def _session(
        self,
        r: ScenarioResult,
        client: Any,
        seed: Seeded,
        index: int,
        plan: SessionPlan,
        *,
        last: bool = False,
    ) -> tuple[str, bool]:
        voice = plan.channel == "call"
        with contextlib.suppress(Exception):
            # New chat previews the opener and has a missing one written; a call finds it.
            if client.request("GET", f"/ventures/{seed.venture_id}/opener").json().get("missing") is True:
                client.request("POST", f"/ventures/{seed.venture_id}/opener")
        view = client.create_session(seed.venture_id, mode="coach", privacy="standard")
        opener = getattr(view, "opener", None) or ""
        call_id: str | None = None
        ok = True
        try:
            if voice:
                started = client.start_call(view.id)
                call_id = started.call.id
                opener = getattr(getattr(started, "intro", None), "text", None) or opener
            r.openers.append(opener)
            history: list[tuple[str, str]] = []
            for number, planned in enumerate(plan.turns, start=1):
                text = planned.say
                if planned.intent is not None:
                    text = self._simulated(r.scenario, planned, history, plan.channel)
                turn = TurnResult(f"{index}.{number}", index, plan.channel, planned, text)
                r.turns.append(turn)
                self._exchange(client, view.id, call_id, turn)
                history.append((text, turn.reply))
                if turn.kind == "error":
                    ok = False
                    break
        finally:
            if call_id is not None:
                with contextlib.suppress(Exception):
                    client.end_call(call_id)
            # Ended when another conversation follows: its recap and memory are what that one is graded on. Nobody reads
            # the last one's, and they cost about two turns each.
            if not last:
                with contextlib.suppress(Exception):
                    client.end_session(view.id)
        return view.id, ok

    def _simulated(
        self, s: Scenario, planned: FounderTurn, history: list[tuple[str, str]], channel: str
    ) -> str:
        founder = {"name": s.founder, "venture": s.venture["name"], "about": s.venture["oneLiner"]}
        turn = {
            "intent": planned.intent,
            "emotion": planned.emotion,
            "register": planned.register,
            "fallback": planned.say,
        }
        return self.simulator.render(turn, founder=founder, history=history, channel=channel)

    def _exchange(self, client: Any, session_id: str, call_id: str | None, turn: TurnResult) -> None:
        from foundry_evals.client import ApiError, ApiUnreachableError

        key = str(uuid.uuid4())
        started = time.monotonic()
        try:
            outcome = None
            try:
                outcome = client.run_turn(session_id, turn.founder, call_id=call_id, idempotency_key=key)
            except ApiError as first:
                if first.code not in RETRY_CODES:
                    raise
                turn.notes.append(f"retried:{first.code}")
            if outcome is None or (outcome.kind == "error" and outcome.error_code in RETRY_CODES):
                if outcome is not None:
                    turn.notes.append(f"retried:{outcome.error_code}")
                self._pause(RETRY_PAUSE_SECONDS)
                outcome = client.run_turn(
                    session_id, turn.founder, call_id=call_id, idempotency_key=f"{key}-retry"
                )
        except ApiError as exc:
            turn.error, turn.seconds = exc.code, time.monotonic() - started
            if exc.code in STOP_CODES:
                with self._lock:
                    self.stopped = self.stopped or f"app_refused:{exc.code}"
            return
        except ApiUnreachableError:
            turn.error, turn.seconds = "timeout", time.monotonic() - started
            return
        turn.kind = outcome.kind
        turn.error = outcome.error_code if outcome.kind == "error" else None
        turn.seconds = float(outcome.duration_seconds or (time.monotonic() - started))
        turn.reply = heard(outcome, turn.channel == "call") if outcome.kind != "error" else ""
        raw = raw_turn(client, session_id, outcome.turn_id)
        if raw is None:
            turn.notes.append("turn_not_read")
            return
        guidance = raw.get("guidance")
        turn.guidance = guidance if isinstance(guidance, dict) else None
        turn.evidence = [e for e in raw.get("evidence") or [] if isinstance(e, dict)]
        usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
        turn.cost_usd = _number(usage.get("costUsd"))
        turn.input_tokens = _whole(usage.get("inputTokens"))
        turn.output_tokens = _whole(usage.get("outputTokens"))
        turn.first_token_ms = _whole(usage.get("firstTokenMs"))
        turn.model = usage.get("modelId") if isinstance(usage.get("modelId"), str) else None
        response = raw.get("response") if isinstance(raw.get("response"), dict) else {}
        escalation = response.get("escalation") if isinstance(response.get("escalation"), dict) else {}
        turn.escalated = bool(getattr(outcome, "escalation_id", None)) or escalation.get("required") is True

    # Grading ----------------------------------------------------------------------------------------------------

    def reply_turn(self, r: ScenarioResult, index: int) -> ReplyTurn:
        s, turn = r.scenario, r.turns[index]
        before = r.turns[:index]
        if s.repeat > 1:
            before = [t for t in before if t.session == turn.session]
        figures: set[float] = set()
        dates: set[tuple[int, int]] = set()
        for t in before:
            back = self._days_back(s, t.session, turn.session)
            said = reading.dates_in(t.founder)
            if (g := t.grades.get("grounded_figures")) is not None and g.passed:
                figures |= reading.values(t.reply)
            if (g := t.grades.get("grounded_dates")) is not None and g.passed:
                said |= reading.dates_in(t.reply)
            due = reading.due_date(reading.step_of(t.guidance))
            if due is not None:
                said.add((due.month, due.day))
            held = self.today - dt.timedelta(days=back)
            dates |= reading.shifted(said, back, self.today) | {(held.month, held.day)}
        # The record is dated by when it was kept, and moves back with the conversations.
        aged = 0 if s.repeat > 1 else sum(plan.gap_days for plan in s.sessions[1 : turn.session])
        for item in s.record:
            for days in (item.days_ago, item.days_ago + aged):
                kept = self.today - dt.timedelta(days=days)
                dates.add((kept.month, kept.day))
        previous = next((t.step_key for t in reversed(before) if t.guidance is not None), None)
        last = before[-1] if before and before[-1].session == turn.session else None
        return ReplyTurn(
            founder=turn.founder,
            reply=turn.reply,
            channel=turn.channel,
            kind=turn.kind,
            expect=turn.plan.expect,
            guidance=turn.guidance,
            evidence=tuple(turn.evidence),
            earlier=tuple((t.founder, t.reply) for t in before),
            known=s.known_text,
            facts=s.facts,
            first_time=s.first_time,
            founder_name=s.founder,
            venture_name=s.venture["name"],
            neighbour=s.neighbour,
            today=self.today,
            previous_step=previous,
            established=frozenset(figures),
            established_dates=frozenset(dates),
            nagged_before=0 if last is None else last.nag_row,
            same_session=tuple(t.reply for t in before if t.session == turn.session and t.reply),
        )

    @staticmethod
    def _days_back(s: Scenario, earlier: int, now: int) -> int:
        """How many days ago session ``earlier`` was, seen from session ``now`` (the ageing between them)."""
        if s.repeat > 1:
            return 0
        return sum(plan.gap_days for plan in s.sessions[earlier:now])

    def grade(self, r: ScenarioResult) -> None:
        for index, turn in enumerate(r.turns):
            seen = self.reply_turn(r, index)
            turn.grades = grade_turn(seen)
            turn.nag_row = seen.nagged_before + 1 if nags(seen) else 0
        s = r.scenario
        if s.repeat > 1:
            for number in range(len(s.sessions[0].turns)):
                at = [t for t in r.turns if t.at.split(".")[1] == str(number + 1)]
                if len(at) == s.repeat:
                    r.grades["same_step"] = same_step([t.step_key for t in at])
        if s.same_step:
            asked = [t for t in r.turns if t.at in s.same_step]
            if len(asked) == len(s.same_step):
                r.grades["same_step"] = same_step([t.step_key for t in asked])
        for plan, opener in zip(s.sessions, r.openers, strict=False):
            if plan.opener:
                found = opener_names(opener, plan.opener, s.facts)
                if r.grades.get("opener_names", found).passed is not False:
                    r.grades["opener_names"] = found

    def _score(self, r: ScenarioResult) -> None:
        if self.judge is None:
            return
        for index, turn in enumerate(r.turns):
            if not turn.criteria or turn.kind == "error":
                continue
            prompt = self.judge_prompt(r, index)
            card = self.judge.score(prompt, turn.criteria)
            turn.card = capped(card, turn.grades) if card.error is None else card

    def judge_prompt(self, r: ScenarioResult, index: int) -> str:
        s, turn = r.scenario, r.turns[index]
        seen = self.reply_turn(r, index)
        tests = (
            f"{question(turn.plan.q).category}, {question(turn.plan.q).test_type}"
            if turn.plan.q
            else turn.plan.expect.kind
        )
        return reply_prompt(
            role=s.role,
            founder=f"{s.founder}, {s.studies}" if s.studies else s.founder,
            known=s.known_text,
            earlier=seen.earlier,
            founder_text=turn.founder,
            reply=turn.reply,
            card=card_text(turn.guidance) if turn.channel == "chat" else "",
            channel=turn.channel,
            seconds=turn.seconds,
            tests=tests,
            passing=s.passing,
            first_time=s.first_time,
        )


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _whole(value: Any) -> int | None:
    found = _number(value)
    return None if found is None else int(found)
