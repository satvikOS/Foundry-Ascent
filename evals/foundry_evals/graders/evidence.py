"""Evidence presence for fact claims (blueprint 01 §9: ≥ 90 % grounded material claims).

A ``fact`` claim is grounded when it cites at least one evidence id and every id it cites exists in the
evidence returned with the turn. Inline ``[E#]`` citations in the answer that point at evidence the
founder was not shown are reported as dangling.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from foundry_evals.graders.base import Finding, Severity
from foundry_evals.models import TurnView

GRADER = "evidence"
INLINE_CITATION = re.compile(r"\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\](?!\()", re.IGNORECASE)


@dataclass(frozen=True)
class EvidenceStats:
    facts: int = 0
    grounded: int = 0
    claims: int = 0
    dangling_citations: int = 0


def grade_evidence(
    turn: TurnView | None, turn_index: int | None = None
) -> tuple[EvidenceStats, list[Finding]]:
    if turn is None or turn.response is None:
        return EvidenceStats(), []
    available = {e.key.upper() for e in turn.evidence}
    facts = grounded = 0
    unknown = 0
    for claim in turn.response.claims:
        if claim.kind != "fact":
            continue
        facts += 1
        ids = {i.strip().upper() for i in claim.evidence_ids if i.strip()}
        if ids and ids <= available:
            grounded += 1
        elif ids - available:
            unknown += 1
    dangling = 0
    for match in INLINE_CITATION.finditer(turn.response.answer):
        dangling += sum(1 for k in re.split(r"[,;]", match.group(1)) if k.strip().upper() not in available)
    findings: list[Finding] = []
    if facts > grounded:
        findings.append(
            Finding(
                GRADER,
                "ungrounded_fact",
                Severity.MEDIUM,
                f"{facts - grounded} of {facts} fact claims lack valid evidence"
                + (f" ({unknown} cite unknown ids)" if unknown else ""),
                "claims",
                turn_index,
            )
        )
    if dangling:
        findings.append(
            Finding(
                GRADER,
                "dangling_citation",
                Severity.MEDIUM,
                f"{dangling} inline citations to missing evidence",
                "answer",
                turn_index,
            )
        )
    stats = EvidenceStats(
        facts=facts, grounded=grounded, claims=len(turn.response.claims), dangling_citations=dangling
    )
    return stats, findings
