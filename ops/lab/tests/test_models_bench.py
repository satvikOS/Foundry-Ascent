"""Suite models: the candidate models' benchmark (apps/api lab-models.ts), a numbers, ids and codes only summary."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from conversation_lab import cli, config, models_bench
from conversation_lab.report import render

LUNA = "us.openai.gpt-6-luna"
TITAN = "amazon.titan-embed-text-v2:0"
COHERE_RERANK = "cohere.rerank-v3-5:0"


def quality(**overrides: Any) -> dict[str, Any]:
    return {
        "answerable": 130,
        "noAnswer": 28,
        "recallAt1": 0.61,
        "recallAt3": 0.78,
        "recallAt5": 0.84,
        "recallAt20": 0.95,
        "mrr": 0.71,
        "hardNegativeFirst": 0.12,
        "noAnswerAuc": 0.9,
        "noAnswerCaught": 0.5,
        **overrides,
    }


def measured(**overrides: Any) -> dict[str, Any]:
    return {
        "recall": 0.6,
        "precision": 0.4,
        "perQuery": 1.9,
        "answerableEmpty": 0.1,
        "noAnswerEmpty": 0.7,
        "perNoAnswer": 0.5,
        "quality": quality(noAnswerAuc=None, noAnswerCaught=None),
        **overrides,
    }


def search() -> dict[str, Any]:
    """A row of the script's measure of production's own search (lab-retrieval.ts)."""
    return {
        "id": TITAN,
        "dimensions": 1024,
        "calibration": {
            "suggested": {"floor": 0.31, "weak": 0.22},
            "strict": {"floor": 0.4, "weak": 0.3},
            "current": {"floor": 0.3, "weak": 0.2},
            "curve": [
                {"floor": 0.1, "answered": 1, "caught": 0},
                {"floor": 0.3, "answered": 0.8, "caught": 0.5},
            ],
            "related": [0.2, 0.4, 0.6],
            "unrelated": [0.1, 0.2, 0.3],
        },
        "ranking": {name: quality(recallAt1=0.5) for name in models_bench.FUSIONS},
        "floors": {name: measured() for name in models_bench.FLOORS},
        "production": {
            "questions": 350,
            "playAnswers": 0.05,
            "retrieval": {name: measured() for name in ("equal_weights", *models_bench.FLOORS)},
            "pack": measured(precision=0.55),
            "families": {name: {"questions": 10, "found": 0.5} for name in models_bench.FAMILIES},
        },
        "searchMs": {"p50": 14, "p95": 22},
    }


def report(**overrides: Any) -> dict[str, Any]:
    """A lab-models.ts report as the script prints it."""
    base: dict[str, Any] = {
        "provider": "bedrock",
        "wallMs": 240_000,
        "budgetUsd": 2,
        "budgetReached": False,
        "corpus": {
            "passages": 182,
            "characters": 114682,
            "queries": 158,
            "answerable": 130,
            "noAnswer": 28,
        },
        "access": [
            {"id": LUNA, "kind": "reasoning", "ok": True, "code": None, "latencyMs": 400},
            {"id": "cohere.embed-v4:0", "kind": "embedding", "ok": False, "code": "AccessDeniedException"},
            {"id": "some.other-model", "kind": "reasoning", "ok": True, "code": None},
        ],
        "reasoning": [
            {
                "id": LUNA,
                "effort": "none",
                "requests": 6,
                "failures": 1,
                "codes": ["ThrottlingException"],
                "firstTokenMs": {"p50": 480, "p95": 900},
                "totalMs": {"p50": 1900, "p95": 2600},
                "tokens": {"input": 5929, "cachedInput": 4800, "output": 160},
                "costUsd": {"total": 0.0011, "perRequest": 0.000183},
                "structured": {
                    "requests": 4,
                    "validFirst": 3,
                    "validRepaired": 1,
                    "failed": 0,
                    "codes": [],
                    "totalMs": {"p50": 1500, "p95": 2100},
                    "costUsd": 0.0009,
                },
                "droppedFields": ["dropped:temperature"],
            }
        ],
        "lexical": quality(recallAt1=0.162),
        "embeddings": [
            {
                "id": TITAN,
                "dimensions": 1024,
                "code": None,
                "queryMs": {"p50": 90, "p95": 180},
                "usdPerMillionTokens": 0.02,
                "corpusTokens": 29000,
                "tokensReported": True,
                "vector": quality(),
                "hybrid": quality(mrr=0.77, noAnswerAuc=None, noAnswerCaught=None),
            },
            {
                "id": "amazon.nova-2-multimodal-embeddings-v1:0",
                "dimensions": 256,
                "code": "ThrottlingException",
                "queryMs": {"p50": None, "p95": None},
                "vector": None,
                "hybrid": None,
            },
        ],
        "search": [search()],
        "rerank": {
            "base": {"id": TITAN, "dimensions": 1024, "by": "search"},
            "sample": 40,
            "before": quality(noAnswerAuc=None),
            "models": [
                {
                    "id": COHERE_RERANK,
                    "region": "us-east-1",
                    "code": None,
                    "ms": {"p50": 130, "p95": 260},
                    "usdPerThousandQueries": 2,
                    "quality": quality(mrr=0.88),
                    "ambiguousOnly": {
                        "share": 0.4,
                        "usdPerThousandQuestions": 0.8,
                        "quality": quality(mrr=0.8),
                    },
                }
            ],
        },
        "costUsd": {
            "total": 0.2412,
            "access": 0.0001,
            "reasoning": 0.09,
            "embeddings": 0.03,
            "rerank": 0.1211,
        },
    }
    base.update(overrides)
    return base


def test_models_runs_on_its_own_with_the_whole_budget_at_most_two_dollars() -> None:
    assert config.suites_for("models") == ["models"]
    assert "models" not in config.suites_for("all")
    assert config.split_budget(2, ["models"]) == {"models": 2.0}
    assert config.budget_parts("models", 2.0) == (2.0, 0.0)
    with pytest.raises(ValueError, match="at most 2 USD"):
        config.split_budget(2.01, ["models"])
    # The other suites' limit is what it was.
    assert config.split_budget(40, ["recall"]) == {"recall": 40.0}


def test_plan_prints_the_models_suite(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["plan", "--suite", "models", "--budget-usd", "2"]) == 0
    assert json.loads(capsys.readouterr().out) == {"suites": ["models"], "budgets": {"models": 2.0}}
    assert cli.main(["plan", "--suite", "models", "--budget-usd", "3"]) == 2


def test_the_script_runs_with_the_run_budget(tmp_path: Path) -> None:
    env = models_bench.models_env({"PATH": "/bin", "AWS_SESSION_TOKEN": "x"}, mock=False)
    assert (env["MODEL_PROVIDER"], env["BEDROCK_REGION"], env["AWS_SESSION_TOKEN"]) == (
        "bedrock",
        "us-east-1",
        "x",
    )
    assert models_bench.models_env({}, mock=True)["MODEL_PROVIDER"] == "mock"
    # The job's own database is the script's; the owner's access code of the seeded app is not.
    job = models_bench.models_env(
        {"DATABASE_URL": "postgresql://localhost/foundry", "E2E_OWNER_ACCESS_CODE": "x"}, mock=True
    )
    assert job["DATABASE_URL"] == "postgresql://localhost/foundry"
    assert "E2E_OWNER_ACCESS_CODE" not in job
    cmd = models_bench.models_command(pnpm="pnpm", budget_usd=1.5, out=tmp_path / "lab")
    assert cmd[:6] == ["pnpm", "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-models.ts"]
    assert cmd[cmd.index("--budget-usd") + 1] == "1.50"
    assert Path(cmd[cmd.index("--out") + 1]) == (tmp_path / "lab").resolve()


def test_run_reads_the_private_report_and_keeps_the_output_private(tmp_path: Path) -> None:
    def runner(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        assert kwargs["capture_output"] is True
        out = Path(cmd[cmd.index("--out") + 1])
        (out / "private").mkdir(parents=True, exist_ok=True)
        (out / "private" / "models-benchmark.json").write_text(json.dumps({"report": report()}))
        return subprocess.CompletedProcess(cmd, 0, b"{}", b"")

    got, code = models_bench.run_models_bench(tmp_path, env={}, budget_usd=1.0, pnpm="pnpm", runner=runner)
    assert code == 0
    assert got is not None
    assert got["wallMs"] == 240_000
    assert (tmp_path / "private" / "logs" / "models-benchmark.log").is_file()

    def failing(cmd: list[str], **_: Any) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(cmd, 1, b"", b"lab-models: Error\n")

    assert models_bench.run_models_bench(
        tmp_path / "other", env={}, budget_usd=1.0, pnpm="pnpm", runner=failing
    ) == (None, 1)


def test_public_result_keeps_numbers_candidate_ids_and_codes_only() -> None:
    result = models_bench.public_result(report(), exit_code=0)
    assert [a["id"] for a in result["access"]] == [LUNA, "cohere.embed-v4:0"]
    assert result["access"][1] == {"id": "cohere.embed-v4:0", "ok": False, "code": "AccessDeniedException"}
    luna = result["reasoning"][0]
    assert luna["first_token_ms"] == {"p50": 480, "p95": 900}
    assert luna["structured"]["valid_repaired"] == 1
    assert luna["dropped_fields"] == ["dropped:temperature"]
    assert result["embeddings"][0]["hybrid"]["mrr"] == 0.77
    assert result["embeddings"][1]["code"] == "ThrottlingException"
    assert result["rerank"]["models"][0]["quality"]["mrr"] == 0.88
    assert result["cost_usd"]["total"] == 0.2412
    found = result["search"][0]
    assert found["ranking"]["default"]["recall_at_1"] == 0.5
    assert found["production"]["pack"]["precision"] == 0.55
    assert found["production"]["families"]["play"] == {"questions": 10, "found": 0.5}
    assert found["calibration"]["curve"][1] == {"floor": 0.3, "answered": 0.8, "caught": 0.5}
    assert result["rerank"]["base"]["by"] == "search"
    assert result["rerank"]["models"][0]["ambiguous_only"]["share"] == 0.4

    secret = "arn:aws:bedrock:us-east-1:123456789012 What do I write to the budget owner?"
    hostile = report()
    hostile["access"][1]["code"] = secret
    hostile["access"].append({"id": secret, "ok": True, "code": None})
    hostile["reasoning"][0].update(
        effort=secret, codes=[secret], droppedFields=[secret, 7], firstTokenMs=secret, requests=secret
    )
    hostile["embeddings"][0].update(vector=secret, dimensions=secret)
    hostile["rerank"]["base"] = {"id": secret, "dimensions": 1}
    hostile["rerank"]["models"][0]["quality"]["mrr"] = secret
    hostile["costUsd"]["total"] = secret
    hostile["rerank"]["base"]["by"] = secret
    hostile["rerank"]["models"][0]["ambiguousOnly"]["share"] = secret
    row = hostile["search"][0]
    row["calibration"].update(suggested=secret, curve=[{"floor": secret}], related=[secret])
    row["ranking"][secret] = quality()
    row["ranking"]["default"] = secret
    row["production"].update(questions=secret, families={secret: {"questions": secret}}, pack=secret)
    hostile["search"].append({"id": secret})
    hostile["refusals"] = [{"id": LUNA, "message": secret}]
    text = json.dumps(models_bench.public_result(hostile, exit_code=0))
    assert secret not in text
    assert "123456789012" not in text
    assert '"code": "Error"' in text
    assert models_bench.public_result(None, exit_code=2) == {"script_exit": 2, "report": False}


def test_the_summary_renders_the_numbers() -> None:
    summary = {
        "suite": "models",
        "budget_usd": 2,
        "stopped_by": None,
        "models": {"app": {}},
        "result": models_bench.public_result(report(), exit_code=0),
        "spend": {"total_usd": 0.2412, "app_usd": 0.2412, "app_budget_usd": 2},
        "duration_seconds": 240,
    }
    text = render(summary)
    assert f"| {LUNA} | yes |" in text
    assert "| cohere.embed-v4:0 | AccessDeniedException |" in text
    assert "| 480 / 900 | 1900 / 2600 | 5929 (4800) / 160 | 0.000183 | 3 / 1 / 0 of 4 |" in text
    assert f"| {TITAN} (hybrid) | 1024 | 90 / 180 | 0.02 | 0.61 | 0.78 | 0.84 | 0.77 |" in text
    assert "| word search alone | - | - | - | 0.162 |" in text
    assert "budget reached: no" in text
    assert f"Production's search with {TITAN} (1024), 14 / 22 ms a search." in text
    assert "| default | 0.5 | 0.78 | 0.84 | 0.71 | 0.12 |" in text
    assert (
        "| a turn's evidence with its play | 0.61 | 0.78 | 0.71 | 0.6 | 0.55 | 1.9 | 0.1 | 0.7 | 0.5 |"
        in text
    )
    assert f"| {COHERE_RERANK}, only when ambiguous (0.4 of questions) | 130 / 260 | 0.8 |" in text
    assert "| no-answer caught | 0 | 0.5 |" in text
    assert "App models" not in text
    # Every row of a table has as many cells as its header.
    width = 0
    for line in text.splitlines():
        if line.startswith("| ---"):
            width = line.count("|")
        elif not line.startswith("|"):
            width = 0
        elif width:
            assert line.count("|") == width, line
    assert "No report" in render({**summary, "result": models_bench.public_result(None, exit_code=1)})


def run_suite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *extra: str, budget: str = "2"
) -> tuple[int, Path]:
    # The suite needs no app: no database, no owner code.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("E2E_OWNER_ACCESS_CODE", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    out = tmp_path / "lab"
    code = cli.main(["run", "--suite", "models", "--budget-usd", budget, "--out", str(out), *extra])
    return code, out


def test_the_suite_runs_the_script_and_prints_numbers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[dict[str, Any]] = []

    def fake(out: Path, **kwargs: Any) -> tuple[dict[str, Any], int]:
        calls.append(kwargs)
        return report(), 0

    monkeypatch.setattr(models_bench, "run_models_bench", fake)
    code, out = run_suite(monkeypatch, tmp_path)
    summary = json.loads((out / "public" / "summary.json").read_text())
    assert code == 0
    assert (calls[0]["budget_usd"], calls[0]["env"]["MODEL_PROVIDER"]) == (2.0, "bedrock")
    assert summary["spend"]["app_usd"] == 0.2412
    assert summary["stopped_by"] is None
    run_suite(monkeypatch, tmp_path / "mock", "--mock")
    assert calls[-1]["env"]["MODEL_PROVIDER"] == "mock"
    # Never above the owner's cap, whatever was approved.
    assert run_suite(monkeypatch, tmp_path / "over", budget="2.5")[0] == 2
    assert len(calls) == 2


def test_the_suite_stops_at_the_budget_and_fails_without_a_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(models_bench, "run_models_bench", lambda *_, **__: (report(budgetReached=True), 0))
    code, out = run_suite(monkeypatch, tmp_path)
    assert code == 0
    assert json.loads((out / "public" / "summary.json").read_text())["stopped_by"] == "budget_app"
    monkeypatch.setattr(models_bench, "run_models_bench", lambda *_, **__: (None, 1))
    code, out = run_suite(monkeypatch, tmp_path / "failed")
    assert code == 1
    assert json.loads((out / "public" / "summary.json").read_text())["harness_error"] == (
        "ModelsBenchScriptFailed"
    )


def test_the_candidates_are_the_committed_ones() -> None:
    ids = models_bench.candidate_ids()
    assert {LUNA, "global.openai.gpt-6-luna", TITAN, COHERE_RERANK} <= ids
    # Mantle's bare id is not granted to the lab role, so it is no candidate.
    assert "openai.gpt-6-luna" not in ids


@pytest.mark.skipif(
    shutil.which("pnpm") is None or not (config.REPO / "node_modules").is_dir(),
    reason="needs the repository's node_modules",
)
def test_the_dry_run_runs_the_real_script_on_the_mock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    code, out = run_suite(monkeypatch, tmp_path, "--mock")
    assert code == 0
    summary = json.loads((out / "public" / "summary.json").read_text())
    assert all(a["ok"] for a in summary["result"]["access"])
    assert {a["id"] for a in summary["result"]["access"]} == models_bench.candidate_ids()
    assert len(summary["result"]["reasoning"]) == 5
    assert summary["result"]["embeddings"][0]["vector"]["answerable"] >= 220
    # No database in this run: the models alone.
    assert summary["result"]["search"] == []
    assert (out / "private" / "models-benchmark.json").is_file()
    text = (out / "public" / "summary.md").read_text()
    private = json.loads((out / "private" / "models-benchmark.json").read_text())
    assert private["replies"]
    for reply in private["replies"]:
        assert reply["text"][:40] not in text
