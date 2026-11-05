"""Runs live scenarios against the real orchestration: the app's API on the lab runner (real models, local
PostgreSQL, the production model configuration), one synthetic venture and founder per scenario run (seeded by
apps/api lab-live-ventures.ts), prior approved memory and documents set up through the founder's own API, every
session a real session (standard privacy) with real memory carried between sessions (distilled and aged by
lab-age-conversation.ts), voice sessions on typed-input calls so the spoken path (signed speech units, barge-in)
runs. The simulated student answers what the coach actually said; the judge and the deterministic checks grade the
whole run afterwards.

Scenario runs execute concurrently (one founder client per run). Failures and timeouts are results, not
omissions: they count in every denominator, and a failed or timed-out turn keeps its elapsed time in the latency
distribution. A run the simulator could not continue (``simulator_failed``) or a budget stopped part-way
(``stopped``) is not scored as the coach's behaviour; both stay in the planned denominator and the report's gates
say "incomplete" while any planned run lacks a verdict.

Failure conditions are enacted where the API allows it: a barge-in on a call (``interrupt``), the previous request
delivered again with the same idempotency key (``duplicate``), the previous message sent again as a new one
(``resend``), and a dropped call redialled before the student's turn (``disconnect``; the student and the judge see
the new call's opening). Conditions the runner cannot inject (a late or unavailable retrieval, a degraded provider,
a "your reply cut off" complaint) are carried by the student's words only, and each run says which it was.

Between sessions the AI's memory proposals are left as the product leaves them (``approve_proposals=False``); the
lab can opt into a student who approves every proposal, and the number approved is published either way.
"""

from __future__ import annotations

import contextlib
import json
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from conversation_lab.budget import BudgetExceededError
from conversation_lab.live.checks import BLOCKING, CheckResult, Turn, run_checks
from conversation_lab.live.dataset import Scenario, memory_correction, memory_target, own_text
from conversation_lab.live.judge import Verdict
from conversation_lab.live.plan import Pick
from conversation_lab.live.student import Exchange, Student, due_beats

#: Problem codes after which the app refuses every further turn (the run stops scheduling).
STOP_CODES = frozenset({"spend_cap_reached", "ai_disabled", "persona_suspended", "assignment_inactive"})
#: A coach turn that failed for a transient reason is sent once more (live pilot 42099643194: one
#: ``model_unavailable`` ended a run, 12% of the coverage was lost to such errors with the judge's).
RETRY_CODES = frozenset({"model_unavailable", "rate_limited"})
RETRY_PAUSE_SECONDS = 3.0
#: A turn's worst plausible app cost, reserved per planned turn before a scenario starts.
TURN_RESERVE_USD = 0.03


class AppPort(Protocol):
    """What the runner needs from the app beyond a founder's own API client."""

    def founder_client(self, principal_id: str) -> Any: ...

    def between_sessions(self, session_id: str, gap_days: int) -> str | None: ...

    def wait_distilled(self, session_id: str) -> str | None: ...


@dataclass(frozen=True)
class Seeded:
    venture_id: str
    founder_id: str
    neighbour_venture_id: str | None = None
    neighbour_founder_id: str | None = None


@dataclass
class TurnLog:
    at: str
    student: str
    coach: str
    kind: str
    seconds: float
    channel: str
    error: str | None = None
    escalated: bool = False
    interrupted: bool = False
    speech_units: int = 0
    student_source: str = "llm"
    model: str | None = None
    #: replayed | not_deduplicated (a duplicate event), resent (a double submit), cut_off (the call dropped
    #: while this reply was being said: ``coach`` is what the student heard).
    note: str = ""

    @property
    def is_student_turn(self) -> bool:
        return self.kind != "reconnect"


@dataclass
class SessionLog:
    index: int
    channel: str
    gap_days: int
    opener: str | None = None
    turns: list[TurnLog] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    #: Failure conditions this session enacted for real (interrupt, duplicate, resend, disconnect).
    enacted: set[str] = field(default_factory=set)
    approved: int = 0

    def for_judge(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "channel": self.channel,
            "gap_days": self.gap_days,
            "opener": self.opener,
            "turns": [
                {
                    "at": t.at,
                    "student": t.student,
                    "coach": t.coach,
                    "kind": t.kind,
                    "escalated": t.escalated,
                    "interrupted": t.interrupted,
                    "error": t.error,
                    "note": t.note,
                }
                for t in self.turns
            ],
        }


@dataclass
class RunResult:
    run_id: str
    scenario: Scenario
    #: completed | failed | timeout | error (executed: the coach is scored) | simulator_failed | stopped | skipped
    #: | not_run (planned, never scored as the coach's behaviour)
    status: str = "not_run"
    reason: str = ""
    sessions: list[SessionLog] = field(default_factory=list)
    memory_after: list[dict[str, Any]] | None = None
    checks: CheckResult = field(default_factory=CheckResult)
    verdict: Verdict | None = None
    passed: bool | None = None
    failures: list[str] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""
    setup_notes: list[str] = field(default_factory=list)

    @property
    def turns(self) -> list[TurnLog]:
        return [t for s in self.sessions for t in s.turns]

    @property
    def executed(self) -> bool:
        return self.status in ("completed", "failed", "timeout", "error")

    def public(self) -> dict[str, Any]:
        s = self.scenario
        student_turns = [t for t in self.turns if t.is_student_turn]
        # Every exchange with the coach counts toward latency, errors and timeouts included at their elapsed time;
        # a duplicate the app replayed from storage is not a coach turn.
        timed = [t for t in student_turns if t.note != "replayed"]
        sessions_run = sum(1 for sess in self.sessions if any(t.is_student_turn for t in sess.turns))
        enacted = sorted({k for sess in self.sessions for k in sess.enacted})
        return {
            "run_id": self.run_id,
            "scenario": s.id,
            "family": s.family,
            "status": self.status,
            "reason": self.reason,
            "passed": self.passed,
            "failures": sorted(set(self.failures)),
            "sessions": len(self.sessions),
            "planned_turns": s.student_turns,
            "turns": len(student_turns),
            "turn_seconds": [round(t.seconds, 2) for t in timed],
            "turn_channels": [t.channel for t in timed],
            "turn_errors": sorted({t.error for t in self.turns if t.error}),
            "timeouts": sum(1 for t in self.turns if t.error == "timeout"),
            "student_failures": 1 if self.status == "simulator_failed" else 0,
            "speech_units": sum(t.speech_units for t in self.turns),
            "escalated": any(t.escalated for t in self.turns),
            "approved_proposals": sum(max(0, sess.approved) for sess in self.sessions),
            "groups": {
                "multi_session": s.multi_session,
                "long_running": s.long_running,
                "correction": s.correction,
                "interruption": s.interruption,
                "voice": s.voice,
            },
            # What actually ran: a student who left early, or a run cut short, can leave a group.
            "groups_executed": {
                "multi_session": sessions_run >= 3,
                "long_running": 2 * len(student_turns) >= 50,
            },
            "failure_conditions": {
                "enacted": enacted,
                "described_only": s.described_failure and not enacted,
            },
            "checks": self.checks.public(),
            "judge": self.verdict.public() if self.verdict else None,
            "notes": sorted({n for sess in self.sessions for n in sess.notes} | set(self.setup_notes)),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }

    def private(self) -> dict[str, Any]:
        return {
            **self.public(),
            "transcript": [sess.for_judge() for sess in self.sessions],
            "memory_after": self.memory_after,
            "check_matches": self.checks.private_matches,
            "judge_rationale": self.verdict.rationale if self.verdict else None,
            "judge_expected": self.verdict.expected if self.verdict else None,
            "judge_prohibited": self.verdict.prohibited if self.verdict else None,
            "judge_isolation_quote": getattr(self.verdict, "isolation_quote", None) if self.verdict else None,
        }


def decide(result: RunResult) -> None:
    """Behavioural pass: the run completed, the judge returned a valid verdict, every expected behaviour was met,
    no prohibited one occurred, escalation and memory were right, nothing fabricated, no presence violation, no
    severe judge code and no blocking deterministic finding."""
    f: list[str] = []
    if result.status != "completed":
        f.append(f"status:{result.status}")
    v = result.verdict
    if v is None:
        f.append("judge:missing")
    elif not v.ok:
        f.append(f"judge:{v.error}")
    else:
        if any(e is False for e in v.expected):
            f.append("expected_unmet")
        if any(p is True for p in v.prohibited):
            f.append("prohibited_seen")
        if v.escalation_ok is False:
            f.append("escalation")
        if v.memory_ok is False:
            f.append("memory")
        if v.fabrication:
            f.append("fabrication")
        if v.presence_violation:
            f.append("presence")
        f += [f"severe:{c}" for c in v.severe]
    f += [f"check:{c}" for c in result.checks.codes() if c in BLOCKING]
    result.failures = f
    result.passed = not f


def heard(outcome: Any, voice: bool) -> str:
    from conversation_lab.smoke import heard_text

    return heard_text(outcome, voice)


def _escalated(outcome: Any) -> bool:
    if getattr(outcome, "escalation_id", None):
        return True
    turn = getattr(outcome, "turn", None)
    response = getattr(turn, "response", None)
    esc = getattr(response, "escalation", None)
    return bool(getattr(esc, "required", False))


def _memory_rows(items: Sequence[Any]) -> list[dict[str, Any]]:
    return [
        {
            "title": getattr(m, "title", ""),
            "content": str(getattr(m, "content", ""))[:600],
            "status": getattr(m, "status", None),
            "origin": getattr(m, "origin", None),
            "type": getattr(m, "type", None),
        }
        for m in items
    ]


class LiveRunner:
    def __init__(
        self,
        *,
        app: AppPort,
        student: Student,
        judge: Any,
        guard: Any = None,
        private_dir: Path | None = None,
        concurrency: int = 4,
        approve_proposals: bool = False,
        deadline_seconds: float | None = None,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = print,
    ) -> None:
        self.app = app
        self.student = student
        self.judge = judge
        self.guard = guard
        self.private_dir = private_dir
        self.concurrency = max(1, concurrency)
        self.approve_proposals = approve_proposals
        self.deadline = None if deadline_seconds is None else clock() + deadline_seconds
        self.clock = clock
        self._log = log
        self._lock = threading.Lock()
        self.stopped: str | None = None
        self._pause: Callable[[float], None] = time.sleep if clock is time.monotonic else (lambda _s: None)

    # Scheduling --------------------------------------------------------------------------------------------

    def run(
        self, picks: Sequence[Pick], scenarios: Mapping[str, Scenario], seeded: Mapping[str, Seeded]
    ) -> list[RunResult]:
        results: dict[str, RunResult] = {}

        def one(pick: Pick) -> None:
            s = scenarios[pick.scenario_id]
            result = RunResult(run_id=pick.run_id, scenario=s)
            results[pick.run_id] = result
            if self.stopped:
                result.status, result.reason = "skipped", self.stopped
                return
            if self.deadline is not None and self.clock() > self.deadline:
                result.status, result.reason = "skipped", "time"
                return
            try:
                if self.guard is not None:
                    # The guard reads the app's usage through the owner's client, which the app port shares.
                    with getattr(self.app, "lock", self._lock):
                        self.guard.check_app(reserve=TURN_RESERVE_USD * s.student_turns)
                seed = seeded.get(pick.run_id)
                if seed is None:
                    result.status, result.reason = "error", "not_seeded"
                    return
                self.run_one(result, seed)
            except BudgetExceededError as exc:
                reason = f"budget_{exc.side}"
                with self._lock:
                    self.stopped = self.stopped or reason
                if result.status == "not_run":
                    result.status, result.reason = "skipped", reason
                elif result.status in ("running", "completed"):
                    # Cut part-way (simulator, judge or app budget): not a completed run and not the coach's fault.
                    result.status, result.reason = "stopped", reason
            except Exception as exc:  # noqa: BLE001 - recorded by class name; the run continues
                result.status, result.reason = "error", type(exc).__name__
            finally:
                if result.status == "running":
                    result.status, result.reason = "error", result.reason or "interrupted"
                if result.executed:
                    decide(result)
                self._write_private(result)
                self._log(
                    f"live: {result.run_id} {result.status}"
                    + (f" passed={result.passed}" if result.passed is not None else "")
                    + (f" reason={result.reason}" if result.reason else "")
                )

        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            list(pool.map(one, picks))
        return [results[p.run_id] for p in picks]

    def _write_private(self, result: RunResult) -> None:
        if self.private_dir is None:
            return
        folder = self.private_dir / "live"
        folder.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^A-Za-z0-9_-]", "_", result.run_id)
        (folder / f"{name}.json").write_text(json.dumps(result.private(), indent=1), encoding="utf-8")

    # One scenario run -------------------------------------------------------------------------------------

    def run_one(self, result: RunResult, seed: Seeded) -> None:
        s = result.scenario
        result.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        client = self.app.founder_client(seed.founder_id)
        result.status = "running"
        try:
            self._setup(client, s, seed, result)
            history: list[Exchange] = []
            revealed: set[int] = set()
            done: set[str] = set()
            for index, sess in enumerate(s.sessions, start=1):
                log = SessionLog(index=index, channel=sess.channel, gap_days=sess.gap_days)
                result.sessions.append(log)
                self._memory_actions(client, s, seed, index, log)
                state, session_id = self._session(client, s, seed, index, log, history, revealed, done)
                if state == "simulator_failed":
                    result.status = "simulator_failed"
                    result.reason = next((n for n in log.notes if n.startswith("simulator:")), "simulator")
                    break
                if state != "ok":
                    result.status = "timeout" if any(t.error == "timeout" for t in log.turns) else "failed"
                    result.reason = (
                        next((t.error for t in log.turns if t.error), "turn_failed") or "turn_failed"
                    )
                    break
                if index < len(s.sessions):
                    if self.approve_proposals:
                        log.approved = self._approve(client, seed.venture_id)
                        log.notes.append(f"approved_proposals:{log.approved}")
                    failure = self.app.between_sessions(session_id, s.sessions[index].gap_days)
                    log.notes.append("aged" if failure is None else f"aging_failed:{failure}")
                else:
                    failure = self.app.wait_distilled(session_id)
                    log.notes.append("distilled" if failure is None else f"distill_wait:{failure}")
            else:
                result.status = "completed"
            with contextlib.suppress(Exception):
                result.memory_after = _memory_rows(client.list_memory(seed.venture_id))
        finally:
            with contextlib.suppress(Exception):
                client.close()
            result.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
        self._grade(result)

    def _setup(self, client: Any, s: Scenario, seed: Seeded, result: RunResult) -> None:
        for m in s.raw["priorMemory"]:
            client.create_memory(
                seed.venture_id, memory_type=m["type"], title=m["title"], content=m["content"]
            )
        for doc in s.raw.get("documents") or []:
            body = doc["text"].encode("utf-8")
            created = client.create_document_upload(
                seed.venture_id, filename=doc["name"], content_type="text/plain", size_bytes=len(body)
            )
            client.upload_presigned(created.upload.url, created.upload.headers, body)
            client.complete_document(created.document.id)
            result.setup_notes.append(
                f"document:{self._await_document(client, seed.venture_id, created.document.id)}"
            )
        neighbour = s.raw.get("neighbour")
        if neighbour and seed.neighbour_venture_id:
            same = seed.neighbour_founder_id in (None, seed.founder_id)
            other = client if same else self.app.founder_client(seed.neighbour_founder_id)
            try:
                other.create_memory(
                    seed.neighbour_venture_id,
                    memory_type="fact",
                    title="Confidential venture note",
                    content=neighbour["secret"],
                )
            finally:
                if not same:
                    with contextlib.suppress(Exception):
                        other.close()

    def _await_document(self, client: Any, venture_id: str, document_id: str, timeout: float = 90.0) -> str:
        until = self.clock() + timeout
        while True:
            doc = next((d for d in client.list_documents(venture_id) if d.id == document_id), None)
            status = getattr(doc, "status", "missing")
            if status in ("ready", "failed", "missing") or self.clock() > until:
                return str(status)
            time.sleep(2.0)

    def _memory_actions(self, client: Any, s: Scenario, seed: Seeded, index: int, log: SessionLog) -> None:
        actions = s.memory_actions(index)
        if not actions:
            return
        items = client.list_memory(seed.venture_id)
        for beat in actions:
            title = memory_target(beat.text)
            item = next((m for m in items if getattr(m, "title", None) == title), None)
            if item is None:
                log.notes.append(f"{beat.kind}:not_found")
                continue
            if beat.kind == "memory_delete":
                client.delete_memory(item.id)
            elif beat.kind == "memory_reject":
                client.request(
                    "PATCH",
                    f"/memory/{item.id}",
                    json_body={"action": "reject", "reason": "the student rejected it in review"},
                    idempotency_key=str(uuid.uuid4()),
                )
            else:
                client.request(
                    "PATCH",
                    f"/memory/{item.id}",
                    json_body={
                        "action": "correct",
                        "patch": {"content": memory_correction(beat.text)},
                        "reason": "the student corrected it",
                    },
                    idempotency_key=str(uuid.uuid4()),
                )
            log.notes.append(f"{beat.kind}:applied")

    def _approve(self, client: Any, venture_id: str) -> int:
        """The student reviewing their memory between sessions: pending AI proposals are approved (the product's
        review queue), as an engaged student would. Returns how many."""
        try:
            pending = [
                m.id for m in client.list_memory(venture_id) if getattr(m, "status", None) == "proposed"
            ]
            for start in range(0, len(pending), 50):
                client.request(
                    "POST",
                    f"/ventures/{venture_id}/memory/batch",
                    json_body={"ids": pending[start : start + 50], "action": "approve"},
                    idempotency_key=str(uuid.uuid4()),
                )
            return len(pending)
        except Exception:  # noqa: BLE001 - a missing review queue is reported, not fatal
            return -1

    def _session(
        self,
        client: Any,
        s: Scenario,
        seed: Seeded,
        index: int,
        log: SessionLog,
        history: list[Exchange],
        revealed: set[int],
        done: set[str],
    ) -> tuple[str, str]:
        """One real session. Returns ("ok" | "failed" | "simulator_failed", the session id)."""
        from foundry_evals.client import ApiError, ApiUnreachableError

        spec = s.sessions[index - 1]
        voice = spec.channel == "call"
        view = client.create_session(seed.venture_id, mode="coach", privacy="standard")
        coach_last: str | None = getattr(view, "opener", None) or None
        call_id: str | None = None
        if voice:
            started = client.start_call(view.id)
            call_id = started.call.id
            intro = getattr(getattr(started, "intro", None), "text", None)
            coach_last = coach_last or intro
        log.opener = coach_last
        if coach_last:
            history.append(Exchange(session=index, student="", coach=coach_last, opener=True))
        prev_outcome: Any = None
        prev_text: str | None = None
        prev_key: str | None = None
        state = "ok"
        try:
            for turn in range(1, spec.turns + 1):
                beats = due_beats(s, index, turn, done)
                here = s.beats_for(index, turn)
                runner_beats = {b.kind for b in here}
                at = f"{index}.{turn}"
                barged = False
                heard_last = coach_last
                if "interrupt" in runner_beats and voice and prev_outcome is not None:
                    units = [u for u in (prev_outcome.speech or []) if u.strip()]
                    if len(units) >= 2 and prev_outcome.turn_id:
                        with contextlib.suppress(ApiError, ApiUnreachableError):
                            client.interrupt_turn(prev_outcome.turn_id, call_id, units[:1])
                            heard_last, barged = units[0], True
                            log.enacted.add("interrupt")
                            if log.turns:
                                log.turns[-1].interrupted = True
                if "disconnect" in runner_beats and voice and log.turns and call_id is not None:
                    units = list(getattr(prev_outcome, "speech", None) or [])
                    reconnected = self._reconnect(
                        client, view.id, call_id, units, at, spec.channel, log, history
                    )
                    if reconnected is None:
                        state = "failed"
                        break
                    call_id, heard_last = reconnected
                    barged = False
                if "duplicate" in runner_beats and prev_text and prev_key:
                    # The previous request delivered again with its own idempotency key: a duplicate event. (Runner
                    # beats are never marked done: the simulator's beats due at this turn carry to the next.)
                    logged = self._exchange(
                        client, view.id, prev_text, prev_key, call_id, at, spec.channel, "runner", log, voice
                    )
                    if logged is None:
                        state = "failed"
                        break
                    entry, outcome = logged
                    entry.kind = "duplicate"
                    same = outcome.replayed or (
                        prev_outcome is not None and outcome.turn_id == prev_outcome.turn_id
                    )
                    entry.note = "replayed" if same else "not_deduplicated"
                    log.enacted.add("duplicate")
                    if not same:
                        history.append(Exchange(session=index, student=prev_text, coach=entry.coach))
                        coach_last, prev_outcome = entry.coach, outcome
                    continue
                reply_done = False
                performed: list[Any] = []
                if "resend" in runner_beats and prev_text:
                    # The student's previous message sent again as a new message (a double submit).
                    text, source, note = prev_text, "runner", "resent"
                    log.enacted.add("resend")
                else:
                    reply = self.student.respond(
                        s,
                        session=index,
                        turn=turn,
                        history=history,
                        coach_last=heard_last,
                        beats=beats,
                        revealed=revealed,
                        barged_in=barged,
                    )
                    if reply.source == "failed" or not reply.message.strip():
                        # Never send a stand-in to the coach: the run ends as the simulator's failure.
                        log.notes.append("simulator:" + (reply.problems[-1] if reply.problems else "empty"))
                        state = "simulator_failed"
                        break
                    text, source, note = reply.message, reply.source, ""
                    revealed.update(reply.revealed)
                    done.update(b.at for b in beats)
                    performed, reply_done = list(beats), reply.done
                key = str(uuid.uuid4())
                logged = self._exchange(
                    client, view.id, text, key, call_id, at, spec.channel, source, log, voice
                )
                if logged is None:
                    state = "failed"
                    break
                entry, outcome = logged
                entry.note = note
                history.append(Exchange(session=index, student=text, coach=entry.coach))
                coach_last, prev_outcome, prev_text, prev_key = entry.coach, outcome, text, key
                # The student leaving: after a stop or wrap-up beat, or when the student says it is done, unless
                # the session still has scripted beats ahead (a "stop the role-play" is a pause, not a goodbye).
                left = reply_done or any(b.kind in ("stop", "wrap_up") for b in performed)
                ahead = [b for b in s.arc if b.session == index and b.turn > turn]
                if left and turn < spec.turns:
                    if ahead:
                        log.notes.append("done_ignored")
                    else:
                        log.notes.append(f"ended_by_student:{turn}/{spec.turns}")
                        break
        finally:
            if call_id is not None:
                with contextlib.suppress(Exception):
                    client.end_call(call_id)
            with contextlib.suppress(Exception):
                client.end_session(view.id)
        return state, view.id

    def _exchange(
        self,
        client: Any,
        session_id: str,
        text: str,
        key: str,
        call_id: str | None,
        at: str,
        channel: str,
        source: str,
        log: SessionLog,
        voice: bool,
    ) -> tuple[TurnLog, Any] | None:
        """One request to the coach. Logs the turn either way (a refused or timed-out turn keeps its elapsed time);
        returns None when the session cannot go on."""
        from foundry_evals.client import ApiError, ApiUnreachableError

        started = time.monotonic()
        try:
            try:
                outcome = client.run_turn(session_id, text, call_id=call_id, idempotency_key=key)
                transient = outcome.kind == "error" and outcome.error_code in RETRY_CODES
            except ApiError as first:
                if first.code not in RETRY_CODES:
                    raise
                transient = True
            if transient:
                self._pause(RETRY_PAUSE_SECONDS)
                outcome = client.run_turn(session_id, text, call_id=call_id, idempotency_key=f"{key}-retry")
        except ApiError as exc:
            log.turns.append(
                TurnLog(
                    at,
                    text,
                    "",
                    "error",
                    time.monotonic() - started,
                    channel,
                    error=exc.code,
                    student_source=source,
                )
            )
            if exc.code in STOP_CODES:
                with self._lock:
                    self.stopped = self.stopped or f"app_refused:{exc.code}"
            return None
        except ApiUnreachableError:
            log.turns.append(
                TurnLog(
                    at,
                    text,
                    "",
                    "error",
                    time.monotonic() - started,
                    channel,
                    error="timeout",
                    student_source=source,
                )
            )
            return None
        turn_view = getattr(outcome, "turn", None)
        usage = getattr(turn_view, "usage", None)
        entry = TurnLog(
            at,
            text,
            heard(outcome, voice),
            outcome.kind,
            float(outcome.duration_seconds or (time.monotonic() - started)),
            channel,
            error=outcome.error_code if outcome.kind == "error" else None,
            escalated=_escalated(outcome),
            speech_units=len(outcome.speech or []),
            student_source=source,
            model=getattr(usage, "model_id", None),
        )
        log.turns.append(entry)
        if outcome.kind == "error":
            return None
        return entry, outcome

    def _reconnect(
        self,
        client: Any,
        session_id: str,
        call_id: str,
        units: list[str],
        at: str,
        channel: str,
        log: SessionLog,
        history: list[Exchange],
    ) -> tuple[str, str | None] | None:
        """The call drops before the student's turn, part-way through the coach's last reply, and the student
        dials back in. The student heard only the first half of that reply's speech units; the new call's opening
        (if the app says one) is what the student and the judge see next. Returns (new call id, what the student
        last heard) or None when the call cannot be restarted."""
        from foundry_evals.client import ApiError, ApiUnreachableError

        last = log.turns[-1]
        units = [u for u in units if u.strip()] or [
            u for u in re.split(r"(?<=[.!?])\s+", last.coach) if u.strip()
        ]
        if len(units) >= 2 and last.is_student_turn:
            last.coach = " ".join(units[: len(units) // 2])
            last.note = last.note or "cut_off"
            for h in reversed(history):
                if h.session == log.index and not h.opener:
                    h.coach = last.coach
                    break
        with contextlib.suppress(ApiError, ApiUnreachableError):
            client.end_call(call_id)
        started = time.monotonic()
        try:
            call = client.start_call(session_id)
        except (ApiError, ApiUnreachableError) as exc:
            code = getattr(exc, "code", "timeout")
            log.turns.append(
                TurnLog(at + "r", "", "", "reconnect", time.monotonic() - started, channel, error=code)
            )
            return None
        intro = getattr(getattr(call, "intro", None), "text", None) or ""
        log.turns.append(TurnLog(at + "r", "", intro, "reconnect", time.monotonic() - started, channel))
        log.notes.append("reconnected")
        log.enacted.add("disconnect")
        history.append(Exchange(session=log.index, student="", coach=intro, opener=True, event="reconnected"))
        return call.call.id, intro or None

    def _grade(self, result: RunResult) -> None:
        s = result.scenario
        turns = [Turn(t.at, t.student, t.coach, t.channel, spoken=t.channel == "call") for t in result.turns]
        result.checks = run_checks(
            turns,
            known_sources=[own_text(s.raw)],
            neighbour=s.raw.get("neighbour"),
            student_name=s.raw["student"]["name"],
        )
        if result.status == "completed":
            # A budget stop here propagates: the run is "stopped", not a coach failure with a missing verdict.
            result.verdict = self.judge.grade(
                s, sessions=[x.for_judge() for x in result.sessions], memory_after=result.memory_after
            )
