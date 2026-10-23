"""Suite ``safety``: the model-based safety screen on the app's real models, before it is turned on in production.

apps/api ``src/scripts/lab-safety-screen.ts`` runs the crisis pipeline (the deterministic rules, the ideation
prefilter, then the screen exactly as a turn calls it: same prompt, schema, output bound and time budget, through the
app's model gateway) over the E-crisis corpus (``ops/lab/scenarios/safety-screen.json``, synthetic lines). No app, no
browser, no database: the script calls the gateway itself, under the lab's role, on the app's models only (the role
may invoke them already). Its budget is the run's, as a hard cap: a call is made only when its worst case still fits.

The script's full report (row ids) and every row's verdict with the model's reason and the corpus text go to the
private folder (sealed or deleted, like every suite's content). The public summary keeps numbers only: precision and
recall, counts by expected label, calls and failures, cost and latency (``public_result``).
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from conversation_lab.config import REPO, AppModels

SCRIPT = "src/scripts/lab-safety-screen.ts"
#: Screen calls in flight at once (the script's default): the corpus's ~670 screened lines take a few minutes.
CONCURRENCY = 4
#: The script's report file under the folder given as ``--out`` (it writes ``<out>/private/safety-screen.json``).
REPORT_FILE = "safety-screen.json"
#: The corpus's labels (lab-safety-screen.ts CorpusRow.expect): the only keys the public counts carry.
LABELS = ("crisis", "none", "wellbeing", "debatable", "unlabeled")
#: Shares of founder turns that reach the screen, for the cost per 1,000 turns (the script's own keys).
HIT_RATES = ("0.005", "0.01", "0.02", "0.05")
#: How long the script may run (the corpus takes minutes; the role's session lasts an hour).
TIMEOUT_SECONDS = 40 * 60

Runner = Callable[..., subprocess.CompletedProcess[bytes]]


def safety_env(
    base: Mapping[str, str], *, models: AppModels, mock: bool, region: str = "us-east-1"
) -> dict[str, str]:
    """The script's environment: the app's production models through Bedrock, or the mock gateway's deterministic
    screen (``mock``: the harness's dry run, no AWS call at all)."""
    env = dict(base)
    env.update(
        {
            "APP_ENV": "development",
            "MODEL_PROVIDER": "mock" if mock else "bedrock",
            "BEDROCK_REGION": region,
            "AWS_REGION": region,
            "MODEL_PRIMARY_ID": models.primary,
            "MODEL_FALLBACK_ID": models.fallback,
            "MODEL_EMBEDDINGS_ID": models.embeddings,
        }
    )
    return env


def safety_command(*, pnpm: str, budget_usd: float, out: Path) -> list[str]:
    """``lab-safety-screen.ts`` over the whole corpus, the screen called only where a turn would call it."""
    return [
        pnpm,
        "--filter",
        "@foundry/api",
        "exec",
        "tsx",
        SCRIPT,
        "--scope",
        "screened",
        "--concurrency",
        str(CONCURRENCY),
        "--budget-usd",
        f"{budget_usd:.2f}",
        # pnpm runs the script in apps/api: the folder must be absolute.
        "--out",
        str(out.resolve()),
    ]


def run_safety_screen(
    out: Path,
    *,
    env: Mapping[str, str],
    budget_usd: float,
    pnpm: str,
    runner: Runner = subprocess.run,
) -> tuple[dict[str, Any] | None, int]:
    """Runs the script; returns its report (None when it wrote none) and its exit code. Its output (the report with
    row ids, or a usage error) is kept in the private logs, never printed."""
    private = out / "private"
    logs = private / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    cmd = safety_command(pnpm=pnpm, budget_usd=budget_usd, out=out)
    try:
        done = runner(
            cmd,
            cwd=REPO,
            env=dict(env),
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
        (logs / "safety-screen.log").write_bytes((done.stdout or b"") + (done.stderr or b""))
        code = done.returncode
    except subprocess.TimeoutExpired:
        code = 124
    path = private / REPORT_FILE
    if not path.is_file():
        return None, code
    try:
        report = json.loads(path.read_text(encoding="utf-8")).get("report")
    except (ValueError, AttributeError):
        return None, code
    return (report if isinstance(report, dict) else None), code


def _num(value: Any) -> int | float | None:
    """A number, or None: nothing else from the report reaches the public summary."""
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _cell(source: Any, keys: tuple[str, ...]) -> dict[str, int | float | None]:
    data = source if isinstance(source, Mapping) else {}
    return {key: _num(data.get(key)) for key in keys}


def _count(source: Any) -> int | None:
    """The `count` of one of the report's id lists (its ids stay private)."""
    return _num(source.get("count")) if isinstance(source, Mapping) else None


def _by_expect(cell: Mapping[str, Any]) -> dict[str, int | float | None]:
    """One label's rows: how many, how many the rules flagged, the screen's outcomes on those it read, and the
    pipeline's final crisis and wellbeing flags."""
    return {
        "rows": _num(cell.get("rows")),
        "rules": _num(cell.get("rules")),
        "screened": _num(cell.get("screened")),
        "crisis": _num(cell.get("crisis")),
        "wellbeing": _num(cell.get("wellbeing")),
        "clear": _num(cell.get("clear")),
        "failed": _num(cell.get("failed")),
        "pipeline_crisis": _num(cell.get("pipelineCrisis")),
        "pipeline_wellbeing": _num(cell.get("pipelineWellbeing")),
    }


def public_result(report: Mapping[str, Any] | None, *, exit_code: int) -> dict[str, Any]:
    """The suite's public result: numbers only, read key by key from the script's report (row ids, model reasons and
    the corpus text never leave the private folder)."""
    if report is None:
        return {"script_exit": exit_code, "report": False}
    confusion = ("tp", "fp", "fn", "tn", "precision", "recall")
    screen = report.get("screenAlone") if isinstance(report.get("screenAlone"), Mapping) else {}
    with_reply = report.get("withReply") if isinstance(report.get("withReply"), Mapping) else {}
    by_expect = report.get("outcomesByExpect") if isinstance(report.get("outcomesByExpect"), Mapping) else {}
    cost = report.get("costUsd") if isinstance(report.get("costUsd"), Mapping) else {}
    per_1000 = (
        cost.get("per1000TurnsAtHitRate") if isinstance(cost.get("per1000TurnsAtHitRate"), Mapping) else {}
    )
    latency = report.get("latencyMs") if isinstance(report.get("latencyMs"), Mapping) else {}
    paths = report.get("paths") if isinstance(report.get("paths"), Mapping) else {}
    return {
        "script_exit": exit_code,
        "report": True,
        "budget_reached": report.get("budgetReached") is True,
        "rows": _num(report.get("rows")),
        "calls": _num(report.get("calls")),
        "failures": _num(report.get("failures")),
        "paths": {
            "rules": _num(paths.get("rules")),
            "screened": _num(paths.get("screened")),
            "prefilter_miss": _num(paths.get("prefilterMiss")),
        },
        "rules_only": _cell(report.get("rulesOnly"), confusion),
        "pipeline": _cell(report.get("pipeline"), confusion),
        "screen_alone": {
            "read": _num(screen.get("read")),
            "precision": _num(screen.get("precision")),
            "recall": _num(screen.get("recall")),
            "false_crisis": _count(screen.get("falseCrisis")),
            "missed_crisis": _count(screen.get("missedCrisis")),
        },
        "by_expect": {
            label: _by_expect(by_expect[label])
            for label in LABELS
            if isinstance(by_expect.get(label), Mapping)
        },
        "with_reply": {
            "screened": _num(with_reply.get("screened")),
            "false_crisis": _count(with_reply.get("falseCrisis")),
            "missed_crisis": _count(with_reply.get("missedCrisis")),
        },
        "wellbeing_on_ordinary": _count(report.get("wellbeingOnOrdinary")),
        "latency_ms": {"p50": _num(latency.get("p50")), "p95": _num(latency.get("p95"))},
        "cost_usd": {
            "total": _num(cost.get("total")),
            "per_call": _num(cost.get("perCall")),
            "per_1000_turns_at_hit_rate": {rate: _num(per_1000.get(rate)) for rate in HIT_RATES},
        },
    }
