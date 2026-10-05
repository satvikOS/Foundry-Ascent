"""LLM-judge rubric — interface stub (OUT OF SCOPE for V1).

V1 gates are deterministic. A model-graded rubric (coaching quality: rigor, specificity, teachability,
persona fit) can be added behind ``--judge`` by implementing ``Judge`` and registering it in
``foundry_evals.runner``. A judge must receive turn content only in memory, return scores and rubric
codes (never quoted text), and must not be used for any blocking gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from foundry_evals.models import TurnView


@dataclass(frozen=True)
class JudgeScore:
    criterion: str
    score: int  # 1-5
    rationale_code: str


class Judge(Protocol):
    name: str

    def score(self, *, case_id: str, founder_text: str, turn: TurnView) -> list[JudgeScore]: ...


class JudgeNotAvailableError(RuntimeError):
    pass


def load_judge() -> Judge:
    raise JudgeNotAvailableError(
        "The LLM judge is out of scope for V1: implement foundry_evals.graders.judge.Judge to enable --judge."
    )
