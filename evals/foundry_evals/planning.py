"""Case specs and the turn-budget planner.

Every scenario and attack becomes a ``CaseSpec``. The planner fits cases into the turn budget
(``--max-turns`` / ``--max-cost-usd``) round-robin across groups — high-risk scenarios, standard
scenarios and each attack category — so a capped run still covers every gate. Cases that do not fit are
reported as ``skipped`` with reason ``budget``.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from foundry_evals.datasets import Attack, AttackSetup, RedTeamFile, Scenario, ScenarioFile

GROUP_ORDER = (
    "scenario:high_risk",
    "redteam:cross_venture",
    "scenario:standard",
    "redteam:prompt_injection",
    "redteam:policy_bypass",
    "redteam:identity",
    "redteam:escalation_jailbreak",
    "redteam:exfiltration",
)


@dataclass(frozen=True)
class CaseSpec:
    suite: str  # "scenarios" | "redteam"
    id: str
    group: str
    category: str
    technique: str | None
    venture_key: str | None
    mode: str
    rehearsal_counterpart: str | None
    #: Context turns (scenarios): graded for safety only.
    setup_turns: tuple[str, ...]
    #: Graded turns.
    turns: tuple[str, ...]
    payload: str | None = None
    encode: str | None = None
    setup: AttackSetup | None = None
    injection_marker: str | None = None
    exfil_domains: tuple[str, ...] = ()
    expected_escalation: bool = False
    expected_category: str | None = None
    high_risk: bool = False
    risk_area: str | None = None
    advice_areas: tuple[str, ...] = ()
    must_include: tuple[str, ...] = ()
    must_not: tuple[str, ...] = ()
    severity: str = "high"
    #: "last": the final graded turn decides escalation (scenarios); "any": any turn (attacks).
    escalation_scope: str = "last"
    stage: str | None = None
    domain: str | None = None

    @property
    def turn_count(self) -> int:
        return len(self.setup_turns) + len(self.turns)


def scenario_case(s: Scenario) -> CaseSpec:
    return CaseSpec(
        suite="scenarios",
        id=s.id,
        group="scenario:high_risk" if s.risk == "high" else "scenario:standard",
        category=f"high_risk:{s.risk_area}" if s.risk == "high" else "standard",
        technique=None,
        venture_key=s.venture_key,
        mode=s.mode,
        rehearsal_counterpart=s.rehearsal_counterpart,
        setup_turns=tuple(s.setup_turns),
        turns=(s.prompt,),
        expected_escalation=s.expected_escalation,
        expected_category=s.expected_category,
        high_risk=s.risk == "high",
        risk_area=s.risk_area,
        advice_areas=tuple(s.advice_areas),
        must_include=tuple(s.must_include),
        must_not=tuple(s.must_not),
        severity="high" if s.risk == "high" else "medium",
        escalation_scope="last",
        stage=s.stage,
        domain=s.domain,
    )


def attack_case(a: Attack) -> CaseSpec:
    return CaseSpec(
        suite="redteam",
        id=a.id,
        group=f"redteam:{a.category}",
        category=a.category,
        technique=a.technique,
        venture_key=a.venture,
        mode=a.mode,
        rehearsal_counterpart=a.rehearsal_counterpart,
        setup_turns=(),
        turns=tuple(a.turns),
        payload=a.payload,
        encode=a.encode,
        setup=a.setup,
        injection_marker=a.injection_marker,
        exfil_domains=tuple(a.exfil_domains),
        expected_escalation=a.expected_escalation,
        expected_category=a.expected_category,
        high_risk=a.high_risk,
        advice_areas=tuple(a.advice_areas),
        must_include=tuple(a.must_include),
        must_not=tuple(a.must_not),
        severity=a.severity,
        escalation_scope="any",
    )


def build_cases(
    suite: str,
    scenarios: ScenarioFile | None,
    redteam: RedTeamFile | None,
    *,
    ids: Sequence[str] = (),
    categories: Sequence[str] = (),
) -> list[CaseSpec]:
    cases: list[CaseSpec] = []
    if suite in ("scenarios", "all") and scenarios is not None:
        cases += [scenario_case(s) for s in scenarios.scenarios]
    if suite in ("redteam", "all") and redteam is not None:
        cases += [attack_case(a) for a in redteam.attacks]
    if ids:
        wanted = set(ids)
        cases = [c for c in cases if c.id in wanted]
    if categories:
        wanted_categories = set(categories)
        cases = [
            c
            for c in cases
            if c.category in wanted_categories or c.group.split(":", 1)[1] in wanted_categories
        ]
    return cases


@dataclass(frozen=True)
class Budget:
    max_turns: int
    max_cost_usd: float | None
    est_cost_per_turn: float

    @property
    def turn_cap(self) -> int:
        if self.max_cost_usd is None:
            return self.max_turns
        affordable = (
            math.floor(self.max_cost_usd / self.est_cost_per_turn)
            if self.est_cost_per_turn > 0
            else self.max_turns
        )
        return max(0, min(self.max_turns, affordable))


@dataclass
class Plan:
    planned: list[CaseSpec] = field(default_factory=list)
    skipped: list[CaseSpec] = field(default_factory=list)

    @property
    def planned_turns(self) -> int:
        return sum(c.turn_count for c in self.planned)


def plan_cases(cases: Iterable[CaseSpec], turn_cap: int) -> Plan:
    """Round-robin across groups (``GROUP_ORDER``) while the turn cap allows; dataset order within a group."""
    queues: dict[str, list[CaseSpec]] = {}
    for case in cases:
        queues.setdefault(case.group, []).append(case)
    order = [g for g in GROUP_ORDER if g in queues] + sorted(g for g in queues if g not in GROUP_ORDER)
    plan = Plan()
    remaining = turn_cap
    progressed = True
    while progressed:
        progressed = False
        for group in order:
            queue = queues[group]
            while queue:
                case = queue.pop(0)
                if case.turn_count <= remaining:
                    plan.planned.append(case)
                    remaining -= case.turn_count
                    progressed = True
                    break
                plan.skipped.append(case)
    for group in order:
        plan.skipped += queues[group]
    return plan
