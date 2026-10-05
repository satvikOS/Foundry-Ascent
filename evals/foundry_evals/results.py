"""Result records. Everything here is content-free: ids, labels, flags, counts, grader codes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from foundry_evals.graders.base import Finding, Severity
from foundry_evals.graders.escalation import EscalationObservation


@dataclass
class TurnRecord:
    index: int
    graded: bool
    kind: str  # completed | blocked | error
    turn_id: str | None = None
    blocked_reason: str | None = None
    escalation_id: str | None = None
    error_code: str | None = None
    escalated: bool = False
    escalation_category: str | None = None
    facts: int = 0
    grounded_facts: int = 0
    evidence_items: int = 0
    phases: list[str] = field(default_factory=list)
    model_id: str | None = None
    fallback_used: bool | None = None
    cost_usd: float | None = None
    latency_ms: int | None = None
    duration_s: float = 0.0
    validator: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "graded": self.graded,
            "kind": self.kind,
            "turnId": self.turn_id,
            "blockedReason": self.blocked_reason,
            "escalationId": self.escalation_id,
            "errorCode": self.error_code,
            "escalated": self.escalated,
            "escalationCategory": self.escalation_category,
            "facts": self.facts,
            "groundedFacts": self.grounded_facts,
            "evidenceItems": self.evidence_items,
            "phases": self.phases,
            "modelId": self.model_id,
            "fallbackUsed": self.fallback_used,
            "costUsd": self.cost_usd,
            "latencyMs": self.latency_ms,
            "durationSeconds": round(self.duration_s, 3),
            "validator": self.validator,
        }


@dataclass
class CaseResult:
    suite: str
    case_id: str
    group: str
    category: str
    technique: str | None
    venture_key: str | None
    actor: str | None
    status: str  # passed | failed | error | skipped
    reason: str | None = None
    high_risk: bool = False
    severity: str = "high"
    session_ids: list[str] = field(default_factory=list)
    sessions_created: int = 0
    sessions_with_disclosure: int = 0
    escalation: EscalationObservation | None = None
    limited: bool | None = None
    behaviours: dict[str, bool] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)
    turns: list[TurnRecord] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def executed(self) -> bool:
        return self.status in ("passed", "failed", "error")

    @property
    def graded_turns(self) -> list[TurnRecord]:
        return [t for t in self.turns if t.kind in ("completed", "blocked")]

    def worst(self) -> Severity | None:
        return max((f.severity for f in self.findings), default=None)

    def finalize(self) -> None:
        if self.status in ("error", "skipped"):
            return
        worst = self.worst()
        self.status = "failed" if worst is not None and worst >= Severity.HIGH else "passed"

    def to_dict(self) -> dict[str, Any]:
        esc = self.escalation
        return {
            "suite": self.suite,
            "id": self.case_id,
            "group": self.group,
            "category": self.category,
            "technique": self.technique,
            "venture": self.venture_key,
            "actor": self.actor,
            "status": self.status,
            "reason": self.reason,
            "highRisk": self.high_risk,
            "severity": self.severity,
            "sessionIds": self.session_ids,
            "disclosure": {"sessions": self.sessions_created, "ok": self.sessions_with_disclosure},
            "escalation": None
            if esc is None
            else {
                "expected": esc.expected,
                "expectedCategory": esc.expected_category,
                "observed": esc.escalated,
                "observedCategory": esc.category,
                "categoryMatch": esc.category_match,
            },
            "limited": self.limited,
            "behaviours": self.behaviours,
            "findings": [f.to_dict() for f in self.findings],
            "turns": [t.to_dict() for t in self.turns],
            "notes": self.notes,
        }


@dataclass
class ProbeResult:
    probe_id: str
    title: str
    actor: str | None
    method: str
    status: str  # passed | failed | skipped | error
    http_status: int | None = None
    problem_code: str | None = None
    expected: list[int] = field(default_factory=list)
    reason: str | None = None
    findings: list[Finding] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.probe_id,
            "title": self.title,
            "actor": self.actor,
            "method": self.method,
            "status": self.status,
            "httpStatus": self.http_status,
            "problemCode": self.problem_code,
            "expected": self.expected,
            "reason": self.reason,
            "findings": [f.to_dict() for f in self.findings],
        }


@dataclass
class RunResults:
    run_id: str
    suite: str
    base_url: str
    started_at: str
    finished_at: str | None = None
    app_version: str | None = None
    datasets: dict[str, str] = field(default_factory=dict)
    budget: dict[str, Any] = field(default_factory=dict)
    environment: dict[str, Any] = field(default_factory=dict)
    cases: list[CaseResult] = field(default_factory=list)
    probes: list[ProbeResult] = field(default_factory=list)
    aborted: str | None = None
    turns_used: int = 0
    cost_usd_reported: float = 0.0
