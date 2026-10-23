"""Suite safety: the safety screen on the app's models (apps/api lab-safety-screen.ts), numbers-only summary."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from conversation_lab import cli, config, safety
from conversation_lab.compare import compare
from conversation_lab.config import AppModels
from conversation_lab.report import render

MODELS = AppModels(
    "us.amazon.nova-2-lite-v1:0", "global.amazon.nova-2-lite-v1:0", "amazon.titan-embed-text-v2:0"
)


def report(**overrides: Any) -> dict[str, Any]:
    """A lab-safety-screen.ts report as the script prints it (ids and model ids included: they must stay private)."""
    base: dict[str, Any] = {
        "provider": "bedrock",
        "primaryModelId": MODELS.primary,
        "fallbackModelId": MODELS.fallback,
        "scope": "screened",
        "budgetUsd": 2,
        "budgetReached": False,
        "wallMs": 123456,
        "rows": 1244,
        "paths": {"rules": 333, "screened": 669, "prefilterMiss": 242},
        "rulesOnly": {"tp": 194, "fp": 65, "fn": 186, "tn": 705, "precision": 0.749, "recall": 0.511},
        "pipeline": {"tp": 350, "fp": 70, "fn": 30, "tn": 700, "precision": 0.833, "recall": 0.921},
        "screenAlone": {
            "read": 650,
            "precision": 0.97,
            "recall": 0.84,
            "falseCrisis": {"count": 5, "firstIds": ["SS-0101", "SS-0102"]},
            "missedCrisis": {"count": 30, "firstIds": ["SS-0201"]},
        },
        "outcomesByExpect": {
            label: {
                "rows": 10,
                "rules": 2,
                "pipelineCrisis": 3,
                "pipelineWellbeing": 1,
                "screened": 8,
                "crisis": 1,
                "wellbeing": 1,
                "clear": 5,
                "failed": 1,
            }
            for label in ("crisis", "none", "wellbeing", "debatable", "unlabeled", "surprise")
        },
        "withReply": {
            "screened": 17,
            "falseCrisis": {"count": 1, "firstIds": ["SS-1230"]},
            "missedCrisis": {"count": 0, "firstIds": []},
        },
        "wellbeingOnOrdinary": {"count": 2, "firstIds": ["SS-0301", "SS-0302"]},
        "calls": 669,
        "failures": 3,
        "failureCodes": ["model_unavailable", "timeout_budget"],
        "models": [MODELS.primary],
        "latencyMs": {"p50": 640, "p90": 1100, "p95": 1300, "p99": 2100, "max": 2500},
        "tokens": {"meanInput": 1100, "meanOutput": 50},
        "costUsd": {
            "total": 0.334,
            "perCall": 0.0005,
            "per1000TurnsAtHitRate": {"0.005": 0.0025, "0.01": 0.005, "0.02": 0.01, "0.05": 0.025},
        },
    }
    base.update(overrides)
    return base


PRIVATE_STRINGS = (
    "SS-0101",
    "SS-0201",
    "SS-1230",
    "SS-0301",
    "model_unavailable",
    "timeout_budget",
    "surprise",
)


def test_safety_runs_on_its_own_with_the_whole_budget_for_the_screen() -> None:
    assert config.suites_for("safety") == ["safety"]
    assert "safety" not in config.suites_for("all")
    assert config.split_budget(2, config.suites_for("safety")) == {"safety": 2.0}
    assert config.budget_parts("safety", 2.0) == (2.0, 0.0)
    # The other suites' budgets are what they were.
    assert config.split_budget(5, config.suites_for("all")) == {
        "recall": 0.83,
        "voice": 0.83,
        "matrix": 1.66,
        "ui": 1.66,
    }


def test_plan_prints_the_safety_suite(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["plan", "--suite", "safety", "--budget-usd", "2"]) == 0
    assert json.loads(capsys.readouterr().out) == {"suites": ["safety"], "budgets": {"safety": 2.0}}


def test_the_script_runs_with_the_production_models_and_the_run_budget(tmp_path: Path) -> None:
    env = safety.safety_env({"PATH": "/bin", "AWS_SESSION_TOKEN": "x"}, models=MODELS, mock=False)
    assert env["MODEL_PROVIDER"] == "bedrock"
    assert (env["MODEL_PRIMARY_ID"], env["MODEL_FALLBACK_ID"]) == (MODELS.primary, MODELS.fallback)
    assert env["AWS_SESSION_TOKEN"] == "x"
    assert safety.safety_env({}, models=MODELS, mock=True)["MODEL_PROVIDER"] == "mock"
    cmd = safety.safety_command(pnpm="pnpm", budget_usd=2.5, out=tmp_path / "lab")
    assert cmd[:6] == ["pnpm", "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-safety-screen.ts"]
    assert cmd[cmd.index("--budget-usd") + 1] == "2.50"
    assert cmd[cmd.index("--scope") + 1] == "screened"
    out = Path(cmd[cmd.index("--out") + 1])
    assert out.is_absolute()
    assert out == (tmp_path / "lab").resolve()


def test_run_safety_screen_reads_the_private_report_and_keeps_the_output_private(tmp_path: Path) -> None:
    seen: dict[str, Any] = {}

    def runner(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen.update(kwargs, cmd=cmd)
        out = Path(cmd[cmd.index("--out") + 1])
        (out / "private").mkdir(parents=True, exist_ok=True)
        (out / "private" / "safety-screen.json").write_text(json.dumps({"report": report(), "rows": []}))
        return subprocess.CompletedProcess(cmd, 0, b'{"rows": 1244, "firstIds": ["SS-0101"]}', b"")

    got, code = safety.run_safety_screen(tmp_path, env={"A": "1"}, budget_usd=1.0, pnpm="pnpm", runner=runner)
    assert code == 0
    assert got is not None
    assert got["rows"] == 1244
    assert seen["env"] == {"A": "1"}
    assert seen["capture_output"] is True
    # The script's stdout (ids) goes to the private logs only.
    assert "SS-0101" in (tmp_path / "private" / "logs" / "safety-screen.log").read_text()

    def failing(cmd: list[str], **_: Any) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(cmd, 1, b"", b"lab-safety-screen: Error\n")

    assert safety.run_safety_screen(
        tmp_path / "other", env={}, budget_usd=1.0, pnpm="pnpm", runner=failing
    ) == (
        None,
        1,
    )


def test_public_result_is_numbers_only() -> None:
    result = safety.public_result(report(), exit_code=0)
    text = json.dumps(result)
    for private in PRIVATE_STRINGS:
        assert private not in text
    assert MODELS.primary not in text
    assert result["pipeline"] == {
        "tp": 350,
        "fp": 70,
        "fn": 30,
        "tn": 700,
        "precision": 0.833,
        "recall": 0.921,
    }
    assert result["screen_alone"] == {
        "read": 650,
        "precision": 0.97,
        "recall": 0.84,
        "false_crisis": 5,
        "missed_crisis": 30,
    }
    assert list(result["by_expect"]) == ["crisis", "none", "wellbeing", "debatable", "unlabeled"]
    assert result["by_expect"]["none"]["pipeline_crisis"] == 3
    assert result["latency_ms"] == {"p50": 640, "p95": 1300}
    assert result["cost_usd"]["total"] == 0.334
    assert result["cost_usd"]["per_1000_turns_at_hit_rate"]["0.01"] == 0.005
    assert (result["calls"], result["failures"], result["wellbeing_on_ordinary"]) == (669, 3, 2)
    assert result["with_reply"] == {"screened": 17, "false_crisis": 1, "missed_crisis": 0}

    # Every leaf is a number, a boolean flag or None: a string slipped into the report never reaches the summary.
    def leaves(value: Any) -> list[Any]:
        if isinstance(value, dict):
            return [leaf for v in value.values() for leaf in leaves(v)]
        return [value]

    hostile = report(rows="SS-0001 I'm thinking about ending it", latencyMs={"p50": "fast", "p95": None})
    hostile["pipeline"]["precision"] = "SS-0002"
    for leaf in leaves(safety.public_result(hostile, exit_code=0)):
        assert leaf is None or isinstance(leaf, int | float | bool), leaf
    assert safety.public_result(None, exit_code=2) == {"script_exit": 2, "report": False}


def test_the_summary_renders_the_numbers(tmp_path: Path) -> None:
    summary = {
        "suite": "safety",
        "budget_usd": 2,
        "stopped_by": None,
        "models": {
            "app": {"primary": MODELS.primary, "fallback": MODELS.fallback, "embeddings": MODELS.embeddings}
        },
        "result": safety.public_result(report(), exit_code=0),
        "spend": {
            "total_usd": 0.334,
            "app_usd": 0.334,
            "app_budget_usd": 2,
            "lab_usd": 0,
            "lab_budget_usd": 0,
        },
        "duration_seconds": 200,
    }
    text = render(summary)
    assert "| Rules + safety screen | 0.833 | 0.921 | 350 | 70 | 30 | 700 |" in text
    assert "| Rules only (as production today) | 0.749 | 0.511 |" in text
    assert "| none | 10 | 2 | 8 | 1 | 1 | 5 | 1 | 3 | 1 |" in text
    assert "Latency p50 640 ms, p95 1300 ms" in text
    for private in PRIVATE_STRINGS:
        assert private not in text
    assert "No report" in render({**summary, "result": safety.public_result(None, exit_code=1)})
    before = {**summary, "result": safety.public_result(report(pipeline={"recall": 0.9}), exit_code=0)}
    rows = {r["metric"]: r for r in compare(summary, before)["headline"]}
    assert rows["safety: rules + screen recall"]["change"] == pytest.approx(0.021)
    assert rows["safety: latency p95 (ms)"]["now"] == 1300


def run_suite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fake: Any, *extra: str
) -> tuple[int, dict[str, Any], str]:
    monkeypatch.setattr(safety, "run_safety_screen", fake)
    # The suite needs no app: no database, no owner code.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("E2E_OWNER_ACCESS_CODE", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    out = tmp_path / "lab"
    code = cli.main(["run", "--suite", "safety", "--budget-usd", "2", "--out", str(out), *extra])
    summary = json.loads((out / "public" / "summary.json").read_text())
    return code, summary, (out / "public" / "summary.md").read_text()


def test_the_suite_runs_the_script_with_the_run_budget_and_prints_numbers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[dict[str, Any]] = []

    def fake(out: Path, **kwargs: Any) -> tuple[dict[str, Any], int]:
        calls.append({"out": out, **kwargs})
        return report(), 0

    code, summary, text = run_suite(monkeypatch, tmp_path, fake)
    assert code == 0
    assert calls[0]["budget_usd"] == 2.0
    assert calls[0]["env"]["MODEL_PROVIDER"] == "bedrock"
    assert calls[0]["env"]["MODEL_PRIMARY_ID"] == config.app_models().primary
    assert summary["stopped_by"] is None
    assert summary["harness_error"] is None
    assert summary["spend"]["app_usd"] == 0.334
    assert summary["spend"]["app_budget_usd"] == 2.0
    assert summary["spend"]["lab_budget_usd"] == 0.0
    for private in PRIVATE_STRINGS:
        assert private not in json.dumps(summary)
        assert private not in text

    _, mocked, _ = run_suite(monkeypatch, tmp_path / "mock", fake, "--mock")
    assert calls[-1]["env"]["MODEL_PROVIDER"] == "mock"
    assert mocked["models"]["app"]["primary"] == "mock"


def test_the_suite_stops_at_the_budget_and_fails_without_a_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    code, summary, _ = run_suite(monkeypatch, tmp_path, lambda out, **_: (report(budgetReached=True), 0))
    assert code == 0
    assert summary["stopped_by"] == "budget_app"
    code, summary, text = run_suite(monkeypatch, tmp_path / "failed", lambda out, **_: (None, 1))
    assert code == 1
    assert summary["harness_error"] == "SafetyScreenScriptFailed"
    assert "No report from lab-safety-screen.ts (exit 1)" in text
