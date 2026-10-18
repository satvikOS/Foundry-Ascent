"""Runs conversation-matrix scenarios against a deployed API.

Built on the evals ``Runner``: the same signed-in synthetic actors, rate-limit pacing, typed-input calls, spend
and turn caps, safety graders on every turn and session clean-up. Per scenario:

- a single-session scenario runs in a private (ephemeral) session of a seeded venture, chosen by the scenario's
  number so a run is reproducible (it writes nothing);
- a multi-session scenario runs only in the dedicated memory venture (``--memory-venture``), exactly like the
  remembered conversations: its notebook must be empty first, every session is deleted afterwards (which erases
  everything derived from it) and the notebook is cleared back to empty. A ``teammate`` scenario needs a second
  synthetic member there; ``after_private`` makes its first session private;
- each founder message is rendered by the simulator from the plan and the conversation so far, sent without a
  mode (auto, as the app does), and on a call spoken with typed input; a barge-in interrupts the previous reply
  after its first speech unit (``POST /turns/:id/interrupt``) before the founder speaks;
- the scenario is graded (``checks.grade_scenario``) and, with a judge, scored by the rubric.

Spend: the simulator's and the judge's model costs are added to the run's reported cost, so ``--max-cost-usd``
caps the whole run. Console lines carry scenario ids, statuses and check codes only.
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import re
import time
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from foundry_evals.client import TurnOutcome
from foundry_evals.environment import SEED_VENTURE_SLUGS, Actor, Environment, VentureState
from foundry_evals.graders import grade_turn_safety
from foundry_evals.graders.base import Severity
from foundry_evals.graders.disclosure import grade_disclosure
from foundry_evals.graders.evidence import grade_evidence
from foundry_evals.matrix.checks import ObservedReply, ObservedSession, grade_scenario
from foundry_evals.matrix.generator import PlannedTurn, Scenario
from foundry_evals.matrix.judge import Judge, JudgedTurn, JudgeRequest, JudgeUnparseableError
from foundry_evals.matrix.report import scenario_humanness
from foundry_evals.matrix.simulator import Exchange, UserSimulator
from foundry_evals.matrix.taxonomy import Taxonomy
from foundry_evals.models import NextAction
from foundry_evals.planning import CaseSpec
from foundry_evals.results import CaseResult
from foundry_evals.runner import (
    CASE_ERRORS,
    BudgetExhaustedError,
    RunAbortedError,
    Runner,
    RunnerOptions,
    _error_code,
    _record,
    _skipped,
)
from foundry_evals.text import TextField, speech_fields, turn_fields

MOCK_MODEL_IDS = frozenset({"mock", "mock-fallback"})
#: A live call gets a heartbeat at least this often while the runner waits (the server closes a call after 60 s
#: without one; the app's client beats every 15 s).
CALL_HEARTBEAT_SECONDS = 15.0
RECORDING_SCHEMA = "foundry-evals/matrix-mock-replies@1"


def matrix_case(scenario: Scenario) -> CaseSpec:
    """The scenario as the evals runner's case (ids, group, placeholders, injection marker)."""
    return CaseSpec(
        suite="matrix",
        id=scenario.id,
        group="matrix:multi_session" if scenario.multi_session else "matrix:single_session",
        category=scenario.values["question_type"],
        technique=None,
        venture_key=None,
        mode="coach",
        rehearsal_counterpart=None,
        setup_turns=(),
        turns=tuple(t.intent for t in scenario.turns()),
        injection_marker=scenario.marker,
        severity="high",
        channel=scenario.values["channel"] if scenario.values["channel"] == "voice" else "text",
    )


@dataclass(frozen=True)
class MatrixPlan:
    planned: list[Scenario]
    skipped: list[Scenario]

    @property
    def planned_turns(self) -> int:
        return sum(s.turn_count for s in self.planned)


def plan_matrix(
    scenarios: Sequence[Scenario],
    *,
    turn_cap: int,
    max_cost_usd: float | None = None,
    est_turn_usd: float = 0.01,
    est_simulator_usd: float = 0.0,
    est_judge_usd: float = 0.0,
) -> MatrixPlan:
    """Scenarios in generator order while the turn cap (and the estimated spend) allows; the rest skipped."""
    planned: list[Scenario] = []
    skipped: list[Scenario] = []
    turns = 0
    spend = 0.0
    for scenario in scenarios:
        cost = scenario.turn_count * (est_turn_usd + est_simulator_usd) + est_judge_usd
        if turns + scenario.turn_count <= turn_cap and (
            max_cost_usd is None or spend + cost <= max_cost_usd + 1e-9
        ):
            planned.append(scenario)
            turns += scenario.turn_count
            spend += cost
        else:
            skipped.append(scenario)
    return MatrixPlan(planned, skipped)


class RecordingRefusedError(RuntimeError):
    """A reply came from a real model: recordings are for the mock model only (they are committed to the repo)."""


class MockRecorder:
    """Records what the mock model said, scenario by scenario, for the offline CI subset to replay."""

    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.model_ids: set[str] = set()

    def session(self, scenario: Scenario, index: int, opener: str | None) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "scenario": scenario.id,
            "session": index,
            "opener": opener,
            "intro": None,
            "turns": [],
        }
        self.sessions.append(entry)
        return entry

    def turn(self, session: dict[str, Any], text: str, outcome: TurnOutcome) -> None:
        turn = outcome.turn
        if turn is not None and turn.usage is not None:
            if turn.usage.model_id not in MOCK_MODEL_IDS:
                raise RecordingRefusedError(f"a reply came from model '{turn.usage.model_id}', not the mock")
            self.model_ids.add(turn.usage.model_id)
        response = (
            turn.response.model_dump() if outcome.kind == "completed" and turn and turn.response else None
        )
        session["turns"].append(
            {
                "text": text,
                "kind": outcome.kind,
                "blockedReason": outcome.blocked_reason,
                "supportMessage": outcome.support_message,
                "errorCode": outcome.error_code,
                "response": response,
                "speech": list(outcome.speech),
            }
        )

    def document(self, meta: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema": RECORDING_SCHEMA,
            **meta,
            "modelIds": sorted(self.model_ids),
            "sessions": self.sessions,
        }

    def write(self, path: Path, meta: dict[str, Any]) -> None:
        """JSON Lines: the header, then one session per line, so a re-recording diffs scenario by scenario."""
        document = self.document(meta)
        sessions = document.pop("sessions")
        lines = [json.dumps(document, ensure_ascii=False)]
        lines += [json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in sessions]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_recording(path: Path) -> dict[str, Any]:
    """A recording written by ``MockRecorder.write``: the header with its ``sessions``."""
    header, *sessions = (
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    )
    return {**header, "sessions": sessions}


class PrivateSink:
    """Writes what quotes the conversation (the judge's rationales) to the private directory only."""

    def __init__(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "judge-rationales.jsonl"

    def judge(self, scenario_id: str, payload: dict[str, Any]) -> None:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"scenario": scenario_id, **payload}, ensure_ascii=False) + "\n")


#: The gap a remembered conversation stands for, in days: what ``--between-sessions-cmd`` ages it by.
GAP_DAYS: dict[str, int] = {"recall_days": 3, "recall_weeks": 14}


class MatrixRunner(Runner):
    def __init__(
        self,
        env: Environment,
        options: RunnerOptions,
        *,
        taxonomy: Taxonomy,
        simulator: UserSimulator,
        judge: Judge | None = None,
        judge_estimate_usd: float = 0.0,
        private: PrivateSink | None = None,
        recorder: MockRecorder | None = None,
        log: Callable[[str], None] = print,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        transcript: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        super().__init__(env, options, log=log, sleep=sleep, clock=clock, transcript=transcript)
        # Waits (a voice turn's rate limit is 60 s) keep the live call alive with heartbeats: a call without one for
        # 60 s is closed, and the next spoken turn would be refused (409 conflict, call_not_active).
        self._raw_sleep = sleep
        self._sleep = self._sleep_on_call
        self._live_call: tuple[Actor, str] | None = None
        self.taxonomy = taxonomy
        self.simulator = simulator
        self.judge = judge
        self.judge_estimate_usd = judge_estimate_usd
        self.private = private
        self.recorder = recorder
        self.simulator_cost_usd = 0.0
        self.judge_cost_usd = 0.0
        self.simulator_sources: Counter[str] = Counter()
        #: (person, venture) pairs with a conversation the server still holds: the vEIR has met them, so a later
        #: session greets them and never introduces itself again (identity.greets_naturally). A pair is forgotten
        #: once the runner deletes that person's sessions there: deleting a conversation erases everything derived
        #: from it, the meeting included, so the server rightly treats the next conversation as a first meeting.
        self.met: set[tuple[str, str]] = set()
        #: Pairs with a session the runner could not delete: the server still holds it, so they stay met.
        self.undeleted: set[tuple[str, str]] = set()

    # Scenarios --------------------------------------------------------------------------------------------

    def run_matrix(self, plan: MatrixPlan) -> list[CaseResult]:
        results: list[CaseResult] = []
        total = len(plan.planned)
        for position, scenario in enumerate(plan.planned, start=1):
            case = matrix_case(scenario)
            if self.aborted is not None:
                results.append(
                    _skipped(case, "budget" if self.aborted == "budget" else f"run_aborted:{self.aborted}")
                )
                continue
            try:
                result = self.run_scenario(scenario)
            except RunAbortedError as exc:
                self.aborted = exc.code
                self._log(f"run aborted: {exc.code}")
                results.append(_skipped(case, f"run_aborted:{exc.code}"))
                continue
            results.append(result)
            self._log(_progress(position, total, result))
        results += [_skipped(matrix_case(s), "budget") for s in plan.skipped]
        return results

    def _single_venture(self, scenario: Scenario) -> VentureState | None:
        ventures = [v for v in self.env.actor_ventures() if v.key in SEED_VENTURE_SLUGS]
        if not ventures:
            return None
        return ventures[scenario_number(scenario) % len(ventures)]

    def run_scenario(self, scenario: Scenario) -> CaseResult:
        case = matrix_case(scenario)
        teammate: Actor | None = None
        if scenario.multi_session:
            key = self.options.memory_venture
            if key is None:
                return _skipped(case, "needs_memory_venture")
            if key in SEED_VENTURE_SLUGS:
                return _skipped(case, "shared_venture_refused")
            venture = self.env.venture_by_key(key)
            if venture is None or not self.env.actors_for(venture.id):
                return _skipped(case, "memory_venture_unavailable")
        else:
            venture = self._single_venture(scenario)
            if venture is None:
                return _skipped(case, "no_actor_for_venture")
        try:
            values = self._values(case, venture)
        except KeyError as exc:  # pragma: no cover - _values only adds what it has
            return _skipped(case, f"placeholder_unavailable:{exc.args[0]}")
        actor = self._pick_actor(venture, scenario.turn_count)
        if any(s.actor == "teammate" for s in scenario.sessions):
            teammate = next(
                (a for a in self.env.actors_for(venture.id) if a.principal_id != actor.principal_id), None
            )
            if teammate is None:
                return _skipped(case, "needs_teammate")
        result = CaseResult(
            suite="matrix",
            case_id=scenario.id,
            group=case.group,
            category=case.category,
            technique=None,
            venture_key=venture.key,
            actor=actor.label,
            status="passed",
            severity="high",
        )
        # Days or weeks later: compressed into the run unless --between-sessions-cmd ages every gap.
        gap_days = GAP_DAYS.get(scenario.values["continuity"], 0)
        aged_gaps = 0
        if gap_days:
            result.notes.append("time_compressed")
        if scenario.multi_session and not self._prepare_notebook(actor, venture, None, result):
            result.finalize()
            return result
        observed: list[ObservedSession] = []
        created: list[tuple[Actor, str]] = []
        history: list[Exchange] = []
        texts: list[str] = []
        case_turn = 0
        stopped = False
        try:
            for planned in scenario.sessions:
                who = teammate if planned.actor == "teammate" and teammate is not None else actor
                session = who.client.create_session(venture.id, mode="coach", privacy=planned.privacy)
                created.append((who, session.id))
                result.session_ids.append(session.id)
                result.sessions_created += 1
                met = (who.principal_id, venture.id)
                met_before = met in self.met
                self.met.add(met)
                disclosure = grade_disclosure(session.disclosure)
                result.findings += disclosure
                if not disclosure:
                    result.sessions_with_disclosure += 1
                ctx = self.env.grading_context(venture, injection_marker=scenario.marker)
                recording = (
                    self.recorder.session(scenario, planned.index, session.opener) if self.recorder else None
                )
                # The opener and a call's intro are the session's own lines: graded by the safety graders (the
                # identity grader above all: "Morning Maya, Corin here.") at the session's first turn.
                start_turn = case_turn + 1
                if session.opener:
                    result.findings += grade_turn_safety(
                        [TextField("opener", session.opener)], ctx, start_turn
                    )
                call_id: str | None = None
                opener = session.opener
                if planned.channel == "voice":
                    call_id, intro = self._start_conversation_call(who, session.id, result, ctx, start_turn)
                    if call_id is None:
                        result.finalize()
                        return result
                    opener = intro or opener
                    if recording is not None:
                        recording["intro"] = intro
                    self._live_call = (who, call_id)
                seen = ObservedSession(
                    planned.index, planned.channel, opener, start_turn=start_turn, met_before=met_before
                )
                observed.append(seen)
                if planned.actor == "teammate":
                    history = []  # a different person: they never saw the founder's conversation
                try:
                    for turn in planned.turns:
                        case_turn += 1
                        message = self.simulator.render(scenario, turn, history, values)
                        self.simulator_sources[message.source] += 1
                        self._charge_simulator(message.cost_usd)
                        texts.append(message.text)
                        outcome = self._turn(who, session.id, message.text, None, None, call_id)
                        if recording is not None and self.recorder is not None:
                            self.recorder.turn(recording, message.text, outcome)
                        record = _record(case_turn, True, outcome)
                        result.turns.append(record)
                        fields = turn_fields(outcome.turn, support_message=outcome.support_message)
                        fields += speech_fields(outcome.speech)
                        turn_ctx = dataclasses.replace(ctx, prompt_texts=tuple(texts))
                        result.findings += grade_turn_safety(fields, turn_ctx, case_turn)
                        self._write_transcript(case, case_turn, message.text, outcome)
                        if outcome.kind == "error":
                            # Graded below as far as it got: what was seen still counts, and the safety turns
                            # it never reached fail (an error never hides a crisis turn).
                            result.status, result.reason = "error", f"turn_error:{outcome.error_code}"
                            stopped = True
                            break
                        stats, evidence_findings = grade_evidence(outcome.turn, case_turn)
                        record.facts, record.grounded_facts = stats.facts, stats.grounded
                        result.findings += evidence_findings
                        reply = _observed(turn, case_turn, message.text, outcome, voice=call_id is not None)
                        seen.replies.append(reply)
                        history.append(Exchange(message.text, reply.main if reply.answered else None))
                        nxt = _next_turn(planned.turns, turn)
                        if (
                            call_id is not None
                            and nxt is not None
                            and nxt.intent == "dynamic:barge_in"
                            and outcome.turn_id is not None
                            and reply.answered
                        ):
                            self._barge_in(who, outcome, call_id, reply, result)
                finally:
                    self._live_call = None
                    if call_id is not None:
                        self._end_call(who, call_id, result)
                if stopped:
                    break
                who.client.end_session(session.id)
                if planned.index < len(scenario.sessions):
                    if gap_days and self.options.between_sessions_cmd:
                        failure = self._between_sessions(who, venture, session.id, gap_days)
                        if failure is None:
                            aged_gaps += 1
                        else:
                            result.notes.append(f"between_sessions_failed:{failure}")
                    self._sleep(self.options.session_gap_seconds)
            if gap_days and aged_gaps == len(scenario.sessions) - 1:
                result.notes.remove("time_compressed")
                result.notes.append(f"time_aged_days:{gap_days}")
        except BudgetExhaustedError:
            result.status, result.reason = "skipped", "budget"
            self.aborted = "budget"
        except CASE_ERRORS as exc:
            result.status, result.reason = "error", _error_code(exc)
        finally:
            for who, session_id in created:
                try:
                    who.client.delete_session(session_id)
                except CASE_ERRORS as exc:
                    result.notes.append(f"delete_session_failed:{_error_code(exc)}")
                    self.undeleted.add((who.principal_id, venture.id))
            # What was deleted is forgotten by the server too; a session that could not be deleted is still met.
            self.met -= {(who.principal_id, venture.id) for who, _ in created} - self.undeleted
            if scenario.multi_session:
                self._clear_notebook(actor, venture, result, scenario.id)
        if result.status == "skipped":
            result.matrix = {"scenario": scenario.id, "values": dict(scenario.values), "checks": []}
            result.finalize()
            return result
        partial = result.status == "error"
        outcomes = grade_scenario(
            self.taxonomy, scenario, observed, result.findings, partial=partial, members=venture.member_names
        )
        result.findings += [o.finding() for o in outcomes if not o.passed]
        recall = [
            o
            for o in outcomes
            if o.check == "continuity.recall" and any(s.startswith("continuity:") for s in o.sources)
        ]
        result.recall_checked, result.recall_passed = len(recall), sum(1 for o in recall if o.passed)
        verdict_public, judge_status = (None, None) if partial else self._judge(scenario, observed)
        result.matrix = {
            "scenario": scenario.id,
            "values": dict(scenario.values),
            "persona": scenario.persona.id,
            "topics": [scenario.topic_a, scenario.topic_b],
            "multiSession": scenario.multi_session,
            "partial": partial,
            "checks": [o.to_dict() for o in outcomes],
            "judge": verdict_public,
            "judgeStatus": judge_status,
            "humanness": None if partial else scenario_humanness(self.taxonomy, outcomes, verdict_public),
        }
        result.finalize()
        return result

    # Pieces ------------------------------------------------------------------------------------------------

    def _sleep_on_call(self, seconds: float) -> None:
        """Sleeps; while a call is live, in heartbeat-sized steps with a heartbeat after each."""
        if self._live_call is None:
            self._raw_sleep(seconds)
            return
        who, call_id = self._live_call
        left = seconds
        while left > 0:
            step = min(left, CALL_HEARTBEAT_SECONDS)
            self._raw_sleep(step)
            left -= step
            # A refused heartbeat shows on the next spoken turn, which is graded and recorded.
            with contextlib.suppress(*CASE_ERRORS):
                who.client.heartbeat_call(call_id)

    def _charge_simulator(self, cost: float) -> None:
        if cost:
            self.simulator_cost_usd += cost
            self.cost_usd += cost

    def _barge_in(
        self, who: Actor, outcome: TurnOutcome, call_id: str, reply: ObservedReply, result: CaseResult
    ) -> None:
        units = [u for u in outcome.speech if u.strip()]
        if len(units) < 2:
            result.notes.append("barge_in_single_unit")
            return
        try:
            who.client.interrupt_turn(outcome.turn_id or "", call_id, units[:1])
        except CASE_ERRORS as exc:
            result.notes.append(f"interrupt_failed:{_error_code(exc)}")
            return
        reply.heard_units = units[:1]
        reply.unheard_units = units[1:]

    def _judge(
        self, scenario: Scenario, observed: Sequence[ObservedSession]
    ) -> tuple[dict[str, Any] | None, str | None]:
        if self.judge is None:
            return None, None
        if (
            self.options.max_cost_usd is not None
            and self.cost_usd + self.judge_estimate_usd > self.options.max_cost_usd
        ):
            return None, "skipped_budget"
        turns: list[JudgedTurn] = []
        planned = {(t.session, t.index): t for t in scenario.turns()}
        for session in observed:
            for reply in session.replies:
                plan = planned[(reply.session, reply.turn)]
                turns.append(
                    JudgedTurn(
                        founder=reply.founder,
                        reply=reply.main if reply.answered else None,
                        intent=plan.intent,
                        feeling=plan.feeling,
                        channel=session.channel,
                        session=session.index,
                        support=reply.support_message,
                    )
                )
        request = JudgeRequest(
            scenario_id=scenario.id,
            persona=scenario.persona.summary,
            goal=scenario.persona.goal,
            turns=tuple(turns),
            openers=tuple((s.index, s.opener) for s in observed if s.opener),
        )
        try:
            verdict = self.judge.score(request)
        except JudgeUnparseableError as exc:
            self.judge_cost_usd += exc.cost_usd
            self.cost_usd += exc.cost_usd
            return None, "unparseable"
        except Exception as exc:  # noqa: BLE001 - a judge failure never fails the scenario; the class is kept
            return None, f"error:{type(exc).__name__}"
        self.judge_cost_usd += verdict.cost_usd
        self.cost_usd += verdict.cost_usd
        if self.private is not None:
            self.private.judge(scenario.id, verdict.private())
        return verdict.public(), "scored"


def scenario_number(scenario: Scenario) -> int:
    """The scenario's number ("MX-0012" → 12, the presence probe "MX-P03" → 3), for a reproducible venture."""
    digits = "".join(c for c in scenario.id.split("-", 1)[-1] if c.isdigit())
    return int(digits or 0)


#: A next step's owner that names the vEIR itself: its action is then a promise it cannot keep ("Email the bursar"
#: owned by the coach is "I'll email the bursar").
OWNER_SELF = re.compile(r"\b(?:veir|coach|mentor|me|i|ai|assistant|twin|digital twin)\b", re.IGNORECASE)


def shown_steps(actions: Sequence[NextAction], persona_name: str | None = None) -> list[str]:
    """What the founder reads in a reply's next steps, for the presence checks: each action, and an action the vEIR
    owns as its own promise."""
    out: list[str] = []
    for action in actions:
        text = action.action.strip()
        if not text:
            continue
        out.append(text)
        owner = action.owner.strip()
        if OWNER_SELF.search(owner) or (persona_name and owner.casefold() == persona_name.casefold()):
            out.append(f"I'll {text[:1].lower()}{text[1:]}")
    return out


def _next_turn(turns: Sequence[PlannedTurn], current: PlannedTurn) -> PlannedTurn | None:
    return next((t for t in turns if t.index == current.index + 1), None)


def _observed(
    turn: PlannedTurn, case_turn: int, text: str, outcome: TurnOutcome, *, voice: bool
) -> ObservedReply:
    reply = ObservedReply(
        session=turn.session,
        turn=turn.index,
        case_turn=case_turn,
        founder=text,
        blocked_reason=outcome.blocked_reason,
        support_message=outcome.support_message,
        voice=voice,
    )
    view = outcome.turn
    if outcome.kind == "completed" and view is not None and view.response is not None:
        r = view.response
        reply.answer = r.answer
        reply.spoken = r.spoken
        reply.speech = list(outcome.speech)
        reply.next_actions = len(r.next_actions)
        reply.shown = shown_steps(r.next_actions)
        reply.claims = len(r.claims)
        reply.memory_candidates = len(r.memory_candidates)
    return reply


def _progress(position: int, total: int, result: CaseResult) -> str:
    worst = sorted(
        {f"{f.severity.label}:{f.grader}:{f.code}" for f in result.findings if f.severity >= Severity.HIGH}
    )
    detail = (" " + " ".join(worst[:4])) if worst else ""
    reason = f" ({result.reason})" if result.reason else ""
    humanness = (result.matrix or {}).get("humanness")
    score = f" humanness={humanness:.2f}" if isinstance(humanness, float) else ""
    return (
        f"[{position}/{total}] {result.case_id:<8} {result.group:<22} {result.venture_key or '-':<11} "
        f"{result.status.upper():<7} turns={len(result.turns)}{score}{reason}{detail}"
    )
