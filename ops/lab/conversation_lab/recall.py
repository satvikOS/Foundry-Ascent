"""Grades the recall suite: what the browser run (apps/web/e2e/lab/recall.lab.ts) captured of each scenario in
the private folder, against ops/lab/scenarios/recall.json. Rules: the distinctive facts of the earlier
conversation are named (synonym groups). Judge: accuracy, invention, naturalness. Presence policy on every
reply of the later conversation."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from conversation_lab.bedrock import LabModelClient
from conversation_lab.config import SCENARIOS_DIR
from conversation_lab.judge import RecallVerdict, grade_recall
from conversation_lab.presence import grade_presence

#: The judge's bar for a recalled answer.
ACCURACY_MIN = 4


def load_recall(path: Path = SCENARIOS_DIR / "recall.json") -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def groups_matched(text: str, groups: Sequence[Sequence[str]]) -> list[bool]:
    folded = text.lower().replace("’", "'")
    return [any(term.lower() in folded for term in group) for group in groups]


def rules_pass(text: str, check: Mapping[str, Any]) -> tuple[bool, int]:
    hits = groups_matched(text, check["expect"])
    required = all(hits[i] for i in check.get("require", []))
    return required and sum(hits) >= int(check["minGroups"]), sum(hits)


@dataclass
class CheckResult:
    line: int
    groups: int
    matched: int
    rules_ok: bool
    verdict: RecallVerdict | None = None
    passed: bool = False


@dataclass
class RecallResult:
    id: str
    checks: list[CheckResult] = field(default_factory=list)
    presence: list[str] = field(default_factory=list)
    turn_seconds: list[float] = field(default_factory=list)
    error: str | None = None
    passed: bool = False
    reason: str = "not_run"

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "passed": self.passed,
            "reason": self.reason,
            "error": self.error,
            "presence_findings": sorted(self.presence),
            "turn_seconds": [round(s, 2) for s in self.turn_seconds],
            "checks": [
                {
                    "line": c.line,
                    "facts_named": f"{c.matched}/{c.groups}",
                    "rules_ok": c.rules_ok,
                    "passed": c.passed,
                    "judge": None
                    if c.verdict is None
                    else {
                        "error": c.verdict.error,
                        "accuracy": c.verdict.accuracy,
                        "natural": c.verdict.natural,
                        "invented": c.verdict.invented,
                    },
                }
                for c in self.checks
            ],
        }


def grade_scenario(
    scenario: Mapping[str, Any],
    captured: Mapping[str, Any] | None,
    *,
    models: LabModelClient | None,
    judge_model: str | None,
) -> RecallResult:
    result = RecallResult(id=scenario["id"])
    if captured is None:
        result.reason = "not_captured"
        return result
    result.turn_seconds = [float(s) for s in captured.get("turnSeconds", [])]
    if captured.get("error"):
        result.error = str(captured["error"])[:64]
        result.reason = "run_error"
        return result
    replies: list[str] = [str(r or "") for r in captured.get("second", {}).get("replies", [])]
    earlier: list[str] = list(scenario["first"]["lines"])
    questions: list[str] = list(scenario["second"]["lines"])
    for check in scenario["checks"]:
        line = int(check["line"])
        reply = replies[line - 1] if line - 1 < len(replies) else ""
        ok, matched = rules_pass(reply, check)
        item = CheckResult(line=line, groups=len(check["expect"]), matched=matched, rules_ok=ok)
        if models is not None and judge_model is not None and reply:
            item.verdict = grade_recall(
                models, judge_model, earlier=earlier, question=questions[line - 1], reply=reply
            )
        judged_ok = (
            item.verdict is None
            or item.verdict.error is not None
            or (
                item.verdict.accuracy is not None
                and item.verdict.accuracy >= ACCURACY_MIN
                and item.verdict.invented is False
            )
        )
        item.passed = bool(reply) and ok and judged_ok
        result.checks.append(item)
    result.presence = [f.code for f in grade_presence(replies)]
    if not replies:
        result.reason = "no_reply"
    elif result.presence:
        result.reason = "presence"
    elif all(c.passed for c in result.checks):
        result.reason = "pass"
        result.passed = True
    elif not all(c.rules_ok for c in result.checks):
        result.reason = "facts_missing"
    else:
        result.reason = "judge"
    return result


def captured_scenarios(private_dir: Path) -> dict[str, dict[str, Any]]:
    folder = private_dir / "recall"
    out: dict[str, dict[str, Any]] = {}
    if folder.is_dir():
        for path in sorted(folder.glob("RC-*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            out[str(data.get("id", path.stem))] = data
    return out
