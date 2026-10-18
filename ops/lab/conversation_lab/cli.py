"""`python -m conversation_lab`: the conversation lab's runner (docs/runbooks/conversation-lab.md).

  plan --suite S --budget-usd B           which suites run and each one's hard cap (JSON; standard library only)
  run  --suite S --budget-usd B --out DIR  starts the app with the real models and runs one suite

Everything printed is public-safe (ids, codes, counts, timings, dollars). Content (transcripts, judge rationales,
screenshots, server logs) is written under DIR/private only; the workflow seals it to the operator's key or
deletes it. Exceptions print their class name, never their message.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from conversation_lab.config import (
    MAX_BUDGET_USD,
    REPO,
    SUITES,
    app_models,
    budget_parts,
    lab_models,
    polly_usd_per_million_characters,
    split_budget,
    suites_for,
)

PUBLIC_REPORTER = REPO / "apps" / "web" / "e2e" / "lab" / "public-reporter.ts"
LAB_CONFIG = "e2e/lab/playwright.config.ts"


def cmd_plan(args: argparse.Namespace) -> int:
    try:
        suites = suites_for(args.suite)
        budgets = split_budget(float(args.budget_usd), suites)
    except ValueError as exc:
        print(f"plan: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"suites": suites, "budgets": budgets}))
    return 0


@dataclass
class Context:
    suite: str
    out: Path
    budget_usd: float
    max_scenarios: int
    recall_gap_seconds: int | None
    env: dict[str, str] = field(default_factory=dict)

    @property
    def private(self) -> Path:
        return self.out / "private"

    @property
    def public(self) -> Path:
        return self.out / "public"


def percentiles(values: Sequence[float]) -> dict[str, float] | None:
    """Nearest-rank p50 and p95 of turn times, in seconds."""
    from conversation_lab.voice import percentile

    p50, p95 = percentile(values, 0.5), percentile(values, 0.95)
    return None if p50 is None or p95 is None else {"p50": p50, "p95": p95}


def run_playwright(
    ctx: Context,
    *,
    specs: list[str],
    config: str | None,
    report: Path,
    extra_env: dict[str, str],
    timeout: int,
) -> int:
    """Runs Playwright with the public reporter only (titles and outcomes) and the JSON report in the private folder.
    `CI` is unset so the configs reuse the servers this run started instead of starting their own."""
    report.parent.mkdir(parents=True, exist_ok=True)
    env = {**ctx.env, **extra_env, "PLAYWRIGHT_JSON_OUTPUT_NAME": str(report)}
    env.pop("CI", None)
    from conversation_lab.stack import PNPM

    cmd = [PNPM, "--filter", "@foundry/web", "exec", "playwright", "test"]
    if config:
        cmd += ["--config", config]
    cmd += [*specs, f"--reporter={PUBLIC_REPORTER},json"]
    try:
        done = subprocess.run(cmd, cwd=REPO, env=env, timeout=timeout, check=False)  # noqa: S603 - fixed arguments
    except subprocess.TimeoutExpired:
        print("playwright: timed out")
        return 124
    return done.returncode


def browser_env(
    ctx: Context, stack_api: str, stack_web: str, owner_code: str, app_budget: float, baseline: float
) -> dict[str, str]:
    return {
        "E2E_BASE_URL": stack_web,
        "E2E_API_URL": stack_api,
        "E2E_OWNER_ACCESS_CODE": owner_code,
        "LAB_OUT_PRIVATE": str(ctx.private),
        "LAB_APP_BUDGET_USD": f"{app_budget:.2f}",
        "LAB_APP_BASELINE_USD": f"{baseline:.6f}",
    }


def cmd_run(args: argparse.Namespace) -> int:
    import boto3
    from botocore.config import Config
    from pydantic import SecretStr

    from conversation_lab.app import AppAdmin
    from conversation_lab.bedrock import LabModelClient
    from conversation_lab.budget import BudgetExceededError, Ledger, SpendGuard
    from conversation_lab.report import purpose_delta, write
    from conversation_lab.stack import Stack, api_env, run_backfill

    suite = args.suite
    if suite not in SUITES:
        print(f"run: suite must be one of {', '.join(SUITES)}", file=sys.stderr)
        return 2
    budget = float(args.budget_usd)
    if not 0 < budget <= MAX_BUDGET_USD:
        print("run: budget out of range", file=sys.stderr)
        return 2
    if args.mock and suite == "voice":
        print(
            "run: the voice suite needs Amazon Polly and Transcribe; it has no mock dry run", file=sys.stderr
        )
        return 2
    owner_code = os.environ.get("E2E_OWNER_ACCESS_CODE", "").strip()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not owner_code or not database_url:
        print(
            "run: E2E_OWNER_ACCESS_CODE and DATABASE_URL must be set (pnpm db:reset prints both)",
            file=sys.stderr,
        )
        return 2
    ctx = Context(
        suite=suite,
        out=Path(args.out),
        budget_usd=budget,
        max_scenarios=int(args.max_scenarios),
        recall_gap_seconds=args.recall_gap_seconds,
    )
    ctx.private.mkdir(parents=True, exist_ok=True)
    ctx.public.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    app_budget, lab_budget = budget_parts(suite, budget)
    ledger = Ledger(ctx.public / "lab-ledger.jsonl")
    guard = SpendGuard(app_budget=app_budget, lab_budget=lab_budget, ledger=ledger)
    models = app_models()
    lab = lab_models()
    session = boto3.Session(region_name=os.environ.get("AWS_REGION", "us-east-1"))
    retry = Config(retries={"mode": "standard", "max_attempts": 4}, read_timeout=120, connect_timeout=10)
    lab_client = LabModelClient(
        client=session.client("bedrock-runtime", config=retry), prices=lab.prices, guard=guard, ledger=ledger
    )
    summary: dict[str, Any] = {
        "suite": suite,
        "budget_usd": budget,
        "max_scenarios": ctx.max_scenarios,
        "stopped_by": None,
        "models": {
            "app": {"primary": models.primary, "fallback": models.fallback, "embeddings": models.embeddings}
        },
    }
    probes: dict[str, str] = {}
    simulator_model: str | None = None
    judge_model: str | None = None
    try:
        if args.mock:
            pass  # a dry run of the harness: no lab model is called
        elif suite == "matrix":
            result = lab_client.probe(lab.simulator)
            probes.update(result.outcomes)
            simulator_model = result.chosen
        if suite in ("matrix", "recall") and not args.mock:
            result = lab_client.probe(lab.judge)
            probes.update(result.outcomes)
            judge_model = result.chosen
    except BudgetExceededError as exc:
        summary["stopped_by"] = f"budget_{exc.side}"
    summary["models"].update({"simulator": simulator_model, "judge": judge_model, "probes": probes})

    env = api_env(
        os.environ,
        models=models,
        database_url=database_url,
        speech=suite in ("recall", "voice"),
        api_port=args.api_port,
        web_port=args.web_port,
        mock=args.mock,
    )
    ctx.env = env
    if args.mock:
        summary["models"]["app"] = {"primary": "mock", "fallback": "mock", "embeddings": "mock"}
    error: str | None = None
    stack_cm = Stack(
        env=env,
        log_dir=ctx.private / "logs",
        web=suite != "matrix",
        api_port=args.api_port,
        web_port=args.web_port,
    )
    try:
        with stack_cm as stack:
            admin = AppAdmin(stack.api_url, SecretStr(owner_code))
            try:
                admin.sign_in()
                usage_before = admin.usage()
                admin.apply_lab_settings(app_budget, ui=suite == "ui")
                guard.attach_app(admin.spent_since_start)
                summary["backfill"] = (
                    "skipped (mock)" if args.mock else run_backfill(env, ctx.private / "logs")
                )
                browser = browser_env(
                    ctx, stack.api_url, stack.web_url, owner_code, app_budget, admin.baseline_usd
                )
                runner: Callable[..., dict[str, Any]] = SUITE_RUNNERS[suite]
                if summary["stopped_by"] is None:
                    summary["result"] = runner(
                        ctx,
                        browser=browser,
                        admin=admin,
                        guard=guard,
                        lab_client=lab_client,
                        session=session,
                        simulator_model=simulator_model,
                        judge_model=judge_model,
                        ledger=ledger,
                    )
                    summary["stopped_by"] = summary["result"].pop("stopped_by", None) or guard.stopped_by
                usage_after = admin.usage()
                summary["spend_app_by_purpose"] = purpose_delta(usage_before, usage_after)
            except BudgetExceededError as exc:
                # A clean stop, not a failure: what ran is reported.
                summary["stopped_by"] = f"budget_{exc.side}"
            except Exception as exc:  # noqa: BLE001 - reported by class name only; the job fails
                error = type(exc).__name__
            finally:
                # The app's spend is read while it is still running; afterwards only this frozen figure remains.
                try:
                    final = guard.app_spent()
                except Exception:  # noqa: BLE001 - the API may be the thing that failed
                    final = guard.last_app_usd
                guard.attach_app(lambda: final)
                admin.close()
    except Exception as exc:  # noqa: BLE001 - the app did not start (or stop); its logs are sealed
        error = error or type(exc).__name__
    spend = guard.snapshot()
    spend["app_by_purpose"] = summary.pop("spend_app_by_purpose", [])
    spend["lab_by_purpose"] = ledger.by_purpose()
    summary["spend"] = spend
    summary["duration_seconds"] = round(time.monotonic() - started, 1)
    summary["harness_error"] = error
    text = write(summary, ctx.public)
    print(text)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with Path(step_summary).open("a", encoding="utf-8") as fh:
            fh.write(text)
    if error:
        print(
            f"run: the harness failed ({error}); the server logs are in the sealed artifact", file=sys.stderr
        )
        return 1
    return 0


# ---- suites --------------------------------------------------------------------------------------------------


def suite_recall(
    ctx: Context, *, browser: dict[str, str], lab_client: Any, judge_model: str | None, **_: Any
) -> dict[str, Any]:
    from conversation_lab.budget import BudgetExceededError
    from conversation_lab.recall import captured_scenarios, grade_scenario, load_recall

    extra = dict(browser)
    if ctx.recall_gap_seconds is not None:
        extra["LAB_RECALL_GAP_SECONDS"] = str(ctx.recall_gap_seconds)
    scenarios = load_recall()["scenarios"][: ctx.max_scenarios]
    grep = "|".join(s["id"] for s in scenarios)
    rc = run_playwright(
        ctx,
        specs=["--project=recall", f"--grep={grep}"],
        config=LAB_CONFIG,
        report=ctx.private / "recall" / "playwright.json",
        extra_env=extra,
        timeout=45 * 60,
    )
    captured = captured_scenarios(ctx.private)
    results = []
    stopped = None
    for scenario in scenarios:
        try:
            results.append(
                grade_scenario(
                    scenario,
                    captured.get(scenario["id"]),
                    models=lab_client if judge_model else None,
                    judge_model=judge_model,
                )
            )
        except BudgetExceededError as exc:
            stopped = f"budget_{exc.side}"
            results.append(
                grade_scenario(scenario, captured.get(scenario["id"]), models=None, judge_model=None)
            )
    seconds = [s for r in results for s in r.turn_seconds]
    return {
        "playwright_exit": rc,
        "passed": sum(r.passed for r in results),
        "run": len(results),
        "turn_seconds": percentiles(seconds),
        "scenarios": [r.public() for r in results],
        "stopped_by": stopped,
    }


def suite_voice(
    ctx: Context, *, browser: dict[str, str], session: Any, guard: Any, ledger: Any, **_: Any
) -> dict[str, Any]:
    from conversation_lab.voice import load_voice, prepare, score

    script = load_voice()
    manifest = prepare(
        script,
        ctx.private / "voice",
        client=session.client("polly"),
        guard=guard,
        ledger=ledger,
        usd_per_million=polly_usd_per_million_characters(),
    )
    rc = run_playwright(
        ctx,
        specs=["--project=voice"],
        config=LAB_CONFIG,
        report=ctx.private / "voice" / "playwright.json",
        extra_env={
            **browser,
            "LAB_VOICE_MANIFEST": str(ctx.private / "voice" / "manifest.json"),
            "LAB_FAKE_MIC_WAV": manifest["deviceFile"],
        },
        timeout=20 * 60,
    )
    result_file = ctx.private / "voice" / "result.json"
    captured = json.loads(result_file.read_text(encoding="utf-8")) if result_file.is_file() else None
    scored = score(script, captured)
    return {
        "playwright_exit": rc,
        "passed": int(scored.passed),
        "run": 1,
        "voice": scored.public(),
    }


def suite_matrix(
    ctx: Context,
    *,
    admin: Any,
    guard: Any,
    lab_client: Any,
    simulator_model: str | None,
    judge_model: str | None,
    **_: Any,
) -> dict[str, Any]:
    from conversation_lab.app import FOUNDER_NAME
    from conversation_lab.judge import Judge
    from conversation_lab.simulator import LlmSimulator, TemplateSimulator
    from conversation_lab.smoke import SmokeRunner, dimension_rates, grading_context, humanness, load_smoke

    smoke = load_smoke()
    founder = admin.founder(FOUNDER_NAME)
    try:
        ventures = founder.list_ventures()
        venture = next((v for v in ventures if v.my_role == "founder"), ventures[0])
        detail = founder.get_venture(venture.id)
        persona = detail.persona.name if detail.persona else "the vEIR"
        rows = admin.client.list_admin_principals()
        staff = [r.principal.display_name for r in rows if {"eir", "program_lead"} & set(r.roles)]
        members = [
            r.principal.display_name
            for r in rows
            if any(getattr(m, "venture_id", None) == venture.id for m in r.memberships)
        ]
        runner = SmokeRunner(
            client=founder,
            venture_id=venture.id,
            founder=smoke["founder"],
            simulator=LlmSimulator(lab_client, simulator_model) if simulator_model else TemplateSimulator(),
            judge=Judge(lab_client, judge_model) if judge_model else None,
            guard=guard,
            context=grading_context(venture.id, venture.name, members, persona, staff),
            private_dir=ctx.private,
        )
        results, stopped = runner.run(smoke["scenarios"], ctx.max_scenarios)
    finally:
        founder.close()
    seconds = [t.seconds for r in results for t in r.turns if t.kind != "error"]
    return {
        "source": "built-in smoke set",
        "simulator": "llm" if simulator_model else "template",
        "passed": sum(r.passed for r in results),
        "run": len(results),
        "humanness": humanness(results),
        "turn_seconds": percentiles(seconds),
        "dimensions": dimension_rates(results),
        "scenarios": [r.public() for r in results],
        "stopped_by": stopped,
    }


def suite_ui(ctx: Context, *, browser: dict[str, str], **_: Any) -> dict[str, Any]:
    from conversation_lab.ui import load, summarize

    report = ctx.private / "ui" / "report.json"
    rc = run_playwright(
        ctx,
        # Steps that genuinely cannot hold for a real model carry the @mock-only tag (with their reason); CI runs
        # them on the mock, the lab leaves them out.
        specs=[
            "--retries=1",
            "--trace=off",
            "--grep-invert=@mock-only",
            f"--output={ctx.private / 'ui' / 'test-results'}",
        ],
        config=None,
        report=report,
        extra_env=browser,
        timeout=50 * 60,
    )
    data = load(report)
    summary = summarize(data) if data is not None else None
    return {
        "playwright_exit": rc,
        "passed": summary["totals"]["expected"] + summary["totals"]["flaky"] if summary else 0,
        "run": (summary["totals"]["expected"] + summary["totals"]["unexpected"] + summary["totals"]["flaky"])
        if summary
        else 0,
        "ui": summary,
    }


SUITE_RUNNERS: dict[str, Callable[..., dict[str, Any]]] = {
    "recall": suite_recall,
    "voice": suite_voice,
    "matrix": suite_matrix,
    "ui": suite_ui,
}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="conversation_lab", description=__doc__.split("\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="suites and per-suite budgets (JSON)")
    plan.add_argument("--suite", required=True)
    plan.add_argument("--budget-usd", required=True)
    plan.set_defaults(func=cmd_plan)
    run = sub.add_parser("run", help="run one suite against the app with the real models")
    run.add_argument("--suite", required=True)
    run.add_argument("--budget-usd", required=True)
    run.add_argument("--max-scenarios", type=int, default=14)
    run.add_argument("--recall-gap-seconds", type=int, default=None)
    run.add_argument("--out", required=True)
    run.add_argument("--api-port", type=int, default=8787)
    run.add_argument("--web-port", type=int, default=4173)
    run.add_argument(
        "--mock",
        action="store_true",
        help="dry run of the harness itself: the app on the deterministic mock model, no AWS call at all",
    )
    run.set_defaults(func=cmd_run)
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - class name only: a message could carry content
        print(f"conversation_lab: {type(exc).__name__}", file=sys.stderr)
        return 1
