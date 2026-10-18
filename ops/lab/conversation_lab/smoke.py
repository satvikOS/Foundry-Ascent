"""The built-in matrix smoke set: real conversations with the app's API (real model), founder turns from the
LLM simulator, graded by the deterministic graders (evals' conversation craft and identity graders, the presence
policy) and the LLM judge. Transcripts and rationales go to the private folder; results hold ids, codes and
numbers only."""

from __future__ import annotations

import contextlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from conversation_lab.budget import BudgetExceededError, SpendGuard
from conversation_lab.config import SCENARIOS_DIR
from conversation_lab.judge import Judge, Verdict, transcript_text
from conversation_lab.presence import grade_presence
from conversation_lab.simulator import Simulator
from foundry_evals.client import ApiError, ApiUnreachableError, FoundryClient, TurnOutcome
from foundry_evals.graders.base import GradingContext, Severity, VentureRef
from foundry_evals.graders.conversation import ConversationReply, grade_conversation, reply_of
from foundry_evals.graders.identity import grade_identity
from foundry_evals.text import turn_fields

#: Problem codes that end the run (the app refuses every further turn).
STOP_CODES = frozenset({"spend_cap_reached", "ai_disabled", "persona_suspended", "assignment_inactive"})
#: A turn's worst plausible app cost (model + distillation share), reserved before it starts.
TURN_RESERVE_USD = 0.03
#: The judge's bar for a pass.
FELT_HEARD_MIN = 4


def load_smoke(path: Path = SCENARIOS_DIR / "smoke.json") -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class TurnRecord:
    founder: str
    heard: str
    kind: str
    seconds: float
    error_code: str | None = None
    #: Private diagnostics: every text field the founder could see or hear, and the validators' verdict.
    detail: dict[str, Any] = field(default_factory=dict)


def turn_detail(outcome: TurnOutcome) -> dict[str, Any]:
    turn = outcome.turn
    response = turn.response if turn is not None else None
    validator = turn.validator if turn is not None else None
    return {
        "answer": response.answer if response is not None else None,
        "spoken": response.spoken if response is not None else None,
        "speech_units": list(outcome.speech),
        "phases": list(outcome.phases),
        "model": turn.usage.model_id if turn is not None and turn.usage is not None else None,
        "fallback_used": turn.usage.fallback_used if turn is not None and turn.usage is not None else None,
        "validator": validator.model_dump() if validator is not None else None,
    }


@dataclass
class ScenarioResult:
    id: str
    tags: dict[str, str]
    channel: str
    turns: list[TurnRecord] = field(default_factory=list)
    craft: list[str] = field(default_factory=list)
    high: list[str] = field(default_factory=list)
    presence: list[str] = field(default_factory=list)
    verdict: Verdict | None = None
    passed: bool = False
    reason: str = "not_run"

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tags": self.tags,
            "channel": self.channel,
            "passed": self.passed,
            "reason": self.reason,
            "turns": len(self.turns),
            "turn_seconds": [round(t.seconds, 2) for t in self.turns],
            "craft_findings": sorted(self.craft),
            "blocking_findings": sorted(self.high),
            "presence_findings": sorted(self.presence),
            "judge": None
            if self.verdict is None
            else {
                "error": self.verdict.error,
                "scores": self.verdict.scores,
                "mean": self.verdict.mean(),
                "expectation_met": self.verdict.expectation_met,
                "presence_violation": self.verdict.presence_violation,
            },
        }

    def private(self) -> dict[str, Any]:
        return {
            **self.public(),
            "transcript": [{"founder": t.founder, "vEIR": t.heard, "kind": t.kind} for t in self.turns],
            "turn_detail": [t.detail for t in self.turns],
            "judge_rationale": self.verdict.rationale if self.verdict else None,
        }


def heard_text(outcome: TurnOutcome, voice: bool) -> str:
    """What the founder read (chat) or heard (call: the speech units, else the spoken reply)."""
    turn = outcome.turn
    response = turn.response if turn is not None else None
    if outcome.kind == "blocked":
        # A crisis support message, or the reply the blocked turn stored (a refusal is still what they read).
        return outcome.support_message or (response.answer if response is not None else "")
    if response is None:
        return ""
    if voice:
        return " ".join(u.strip() for u in outcome.speech if u.strip()) or response.spoken or response.answer
    return response.answer


def decide(result: ScenarioResult) -> tuple[bool, str]:
    """A scenario passes when every turn was answered, no blocking grader finding, no presence finding, and the
    judge (when it ran) found the expectation met, the founder heard (felt_heard >= 4) and no presence
    violation."""
    if any(t.kind == "error" for t in result.turns):
        return False, "turn_error"
    if result.high:
        return False, "blocking_finding"
    if result.presence:
        return False, "presence"
    verdict = result.verdict
    if verdict is not None and verdict.ok:
        if verdict.presence_violation:
            return False, "judge_presence"
        if not verdict.expectation_met:
            return False, "judge_expectation"
        felt = verdict.scores.get("felt_heard")
        if not isinstance(felt, int) or felt < FELT_HEARD_MIN:
            return False, "judge_felt_heard"
        return True, "pass"
    if verdict is not None and not verdict.ok:
        return False, "judge_error"
    return True, "pass_rules_only"


def _replies(
    scenario: Mapping[str, Any], outcomes: Sequence[TurnOutcome | None], voice: bool
) -> list[ConversationReply]:
    checks = {c["turn"]: c for c in scenario.get("checks", [])}
    out: list[ConversationReply] = []
    for index, outcome in enumerate(outcomes, start=1):
        check = checks.get(index, {})
        reply = reply_of(
            outcome.turn if outcome is not None else None,
            session=1,
            index=index,
            case_turn=index,
            speech=outcome.speech if outcome is not None else (),
            check=check.get("check"),
            expect_any=check.get("expectAny", ()),
            voice=voice,
        )
        if reply is not None:
            out.append(reply)
    return out


class SmokeRunner:
    def __init__(
        self,
        *,
        client: FoundryClient,
        venture_id: str,
        founder: Mapping[str, str],
        simulator: Simulator,
        judge: Judge | None,
        guard: SpendGuard,
        context: GradingContext,
        private_dir: Path,
    ) -> None:
        self.client = client
        self.venture_id = venture_id
        self.founder = founder
        self.simulator = simulator
        self.judge = judge
        self.guard = guard
        self.context = context
        self.private_dir = private_dir

    def run(
        self, scenarios: Iterable[Mapping[str, Any]], max_scenarios: int
    ) -> tuple[list[ScenarioResult], str | None]:
        results: list[ScenarioResult] = []
        stopped: str | None = None
        for scenario in list(scenarios)[:max_scenarios]:
            try:
                self.guard.check_app(reserve=TURN_RESERVE_USD * len(scenario["turns"]))
                result = self.run_one(scenario)
            except BudgetExceededError as exc:
                stopped = f"budget_{exc.side}"
                break
            results.append(result)
            self._write_private(result)
            if result.reason == "stop":
                stopped = "app_refused"
                break
        return results, stopped

    def _write_private(self, result: ScenarioResult) -> None:
        folder = self.private_dir / "matrix"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{result.id}.json").write_text(json.dumps(result.private(), indent=1), encoding="utf-8")

    def run_one(self, scenario: Mapping[str, Any]) -> ScenarioResult:
        channel = scenario.get("channel", "chat")
        voice = channel == "call"
        result = ScenarioResult(id=scenario["id"], tags=dict(scenario.get("tags", {})), channel=channel)
        session = self.client.create_session(
            self.venture_id, mode="coach", privacy=scenario.get("privacy", "ephemeral")
        )
        call_id = self.client.start_call(session.id).call.id if voice else None
        outcomes: list[TurnOutcome | None] = []
        history: list[tuple[str, str]] = []
        try:
            for spec in scenario["turns"]:
                text = self.simulator.render(spec, founder=self.founder, history=history, channel=channel)
                try:
                    outcome = self.client.run_turn(session.id, text, call_id=call_id)
                except ApiError as exc:
                    result.turns.append(
                        TurnRecord(founder=text, heard="", kind="error", seconds=0.0, error_code=exc.code)
                    )
                    outcomes.append(None)
                    if exc.code in STOP_CODES:
                        result.reason = "stop"
                        return result
                    break
                except ApiUnreachableError:
                    result.turns.append(
                        TurnRecord(
                            founder=text, heard="", kind="error", seconds=0.0, error_code="unreachable"
                        )
                    )
                    outcomes.append(None)
                    break
                heard = heard_text(outcome, voice)
                result.turns.append(
                    TurnRecord(
                        founder=text,
                        heard=heard,
                        kind=outcome.kind,
                        seconds=outcome.duration_seconds,
                        error_code=outcome.error_code,
                        detail=turn_detail(outcome),
                    )
                )
                outcomes.append(outcome)
                history.append((text, heard))
                if outcome.kind == "error":
                    break
        finally:
            if call_id is not None:
                with contextlib.suppress(ApiError, ApiUnreachableError):
                    self.client.end_call(call_id)
        self._grade(scenario, result, outcomes, voice)
        return result

    def _grade(
        self,
        scenario: Mapping[str, Any],
        result: ScenarioResult,
        outcomes: list[TurnOutcome | None],
        voice: bool,
    ) -> None:
        grade = grade_conversation(_replies(scenario, outcomes, voice), had_history=True)
        for finding in grade.findings:
            (result.high if finding.severity >= Severity.HIGH else result.craft).append(finding.code)
        for index, outcome in enumerate(outcomes, start=1):
            if outcome is None or outcome.turn is None:
                continue
            for finding in grade_identity(turn_fields(outcome.turn), self.context, index):
                if finding.severity >= Severity.HIGH:
                    result.high.append(f"identity:{finding.code}")
        sincere = frozenset(scenario.get("sincereIdentity", []))
        result.presence = [f.code for f in grade_presence([t.heard for t in result.turns], sincere)]
        if self.judge is not None and result.turns and all(t.kind != "error" for t in result.turns):
            founder = (
                f"{self.founder['name']}, founder of {self.founder['venture']} ({self.founder['about']})"
            )
            result.verdict = self.judge.grade(
                founder_context=founder,
                expectation=scenario["expect"],
                transcript=transcript_text([(t.founder, t.heard) for t in result.turns], result.channel),
            )
        result.passed, result.reason = decide(result)


def grading_context(
    venture_id: str, venture_name: str, members: Sequence[str], persona: str, staff: Sequence[str]
) -> GradingContext:
    return GradingContext(
        own=VentureRef(
            id=venture_id, key=venture_name.lower(), name=venture_name, member_names=tuple(members)
        ),
        staff_names=tuple(staff),
        persona_name=persona,
    )


def dimension_rates(results: Sequence[ScenarioResult]) -> dict[str, dict[str, dict[str, int]]]:
    """Per tag dimension and value: scenarios passed / run."""
    out: dict[str, dict[str, dict[str, int]]] = {}
    for result in results:
        for dimension, value in result.tags.items():
            cell = out.setdefault(dimension, {}).setdefault(value, {"passed": 0, "run": 0})
            cell["run"] += 1
            cell["passed"] += int(result.passed)
    return out


def humanness(results: Sequence[ScenarioResult]) -> float | None:
    """Mean judge score over scenarios with a verdict, scaled 0-100 (1 -> 0, 5 -> 100)."""
    means = [r.verdict.mean() for r in results if r.verdict is not None and r.verdict.ok]
    values = [m for m in means if m is not None]
    if not values:
        return None
    return round((sum(values) / len(values) - 1) / 4 * 100, 1)
