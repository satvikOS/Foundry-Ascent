"""`python -m conversation_lab`: the conversation lab's runner (docs/runbooks/conversation-lab.md).

  plan --suite S --budget-usd B           which suites run and each one's hard cap (JSON; standard library only)
  run  --suite S --budget-usd B --out DIR  starts the app with the real models and runs one suite (safety: no app,
                                           the safety screen on the app's models over the E-crisis corpus; face:
                                           the HeyGen sandbox face, its key from LAB_HEYGEN_API_KEY to the API only;
                                           --face-mode full|lite|both picks the in-app call arm's face mode)

Everything printed is public-safe (ids, codes, counts, timings, dollars). Content (transcripts, judge rationales,
screenshots, server logs) is written under DIR/private only; the workflow seals it to the operator's key or
deletes it. Exceptions print their class name, never their message.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from conversation_lab.config import (
    EXTRA_SUITES,
    FACE_MODES,
    MAX_BUDGET_USD,
    REPO,
    SUITES,
    app_models,
    budget_parts,
    face_passes,
    lab_models,
    polly_usd_per_million_characters,
    split_budget,
    suites_for,
)

PUBLIC_REPORTER = REPO / "apps" / "web" / "e2e" / "lab" / "public-reporter.ts"
LAB_CONFIG = "e2e/lab/playwright.config.ts"
#: The face spec's tests of a LITE pass after a FULL one (apps/web/e2e/lab/face.lab.ts): the unmeasured warm-up turn
#: (the pass's API process was restarted, so it is cold again) and the LITE call arm.
FACE_LITE_CALL_GREP = "warm-up:|call LITE:"

#: The face suite's vendor key, taken out of this process's environment when the harness starts (face.take_key) and
#: handed to the local API process only. Never printed, logged or written.
_FACE_KEY = ""


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
    #: Only these scenarios (matrix), each run `repeat` times; voice runs its call `repeat` times.
    scenario_ids: tuple[str, ...] = ()
    repeat: int = 1
    #: The matrix suite's scenarios: the lab's built-in set, or evals' conversation matrix (foundry_evals.matrix).
    matrix_source: str = "builtin"
    #: Key of the synthetic venture the lab added for evals' remembered conversations (matrix_source=evals).
    memory_venture: str | None = None
    #: The agenda suite's founders by channel (chat, call), as the seed script reported them.
    agenda_founders: dict[str, str] = field(default_factory=dict)
    #: The face suite's lab-probe token (None in the dry run: no vendor) and the founder's admin grant outcome.
    face_probe_token: str | None = None
    face_admin: str = ""
    #: The face suite's in-app arm: full, lite or both (config.FACE_MODES); and whether this is the dry run.
    face_mode: str = "both"
    mock: bool = False

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
    if args.suite == "safety":
        return cmd_run_safety(args)
    import boto3
    from botocore.config import Config
    from pydantic import SecretStr

    from conversation_lab.app import AppAdmin
    from conversation_lab.bedrock import LabModelClient
    from conversation_lab.budget import BudgetExceededError, Ledger, SpendGuard
    from conversation_lab.report import purpose_delta, write
    from conversation_lab.stack import Stack, api_env, run_agenda_ventures, run_backfill, run_memory_venture

    suite = args.suite
    if suite not in (*SUITES, *EXTRA_SUITES):
        print(f"run: suite must be one of {', '.join((*SUITES, *EXTRA_SUITES))}", file=sys.stderr)
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
    if suite == "face" and not args.mock and not _FACE_KEY:
        print(
            "run: the face suite needs the HeyGen LiveAvatar key in LAB_HEYGEN_API_KEY (the repository secret "
            "HEYGEN_LIVEAVATAR_API); --mock runs it on the development stand-in face",
            file=sys.stderr,
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
        scenario_ids=tuple(i.strip() for i in (args.scenarios or "").split(",") if i.strip()),
        repeat=int(args.repeat),
        matrix_source=str(args.matrix_source),
        face_mode=str(args.face_mode),
        mock=bool(args.mock),
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
        if suite in ("matrix", "recall", "agenda") and not args.mock:
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
        speech=suite in ("recall", "voice", "face"),
        api_port=args.api_port,
        web_port=args.web_port,
        mock=args.mock,
    )
    # The local API's own environment: the face suite adds the vendor key there and nowhere else (not in ctx.env,
    # which Playwright and the scripts get).
    api_process = env
    if suite == "face":
        from conversation_lab.face import api_process_env, face_env, grant_admin, new_probe_token
        from conversation_lab.stack import PNPM

        ctx.face_probe_token = None if args.mock else new_probe_token()
        # The first pass's mode (both: FULL first; suite_face restarts the API in LITE for the second pass).
        first_mode = face_passes(ctx.face_mode)[0]
        env.update(face_env(mock=args.mock, probe_token=ctx.face_probe_token, mode=first_mode))
        ctx.face_admin = grant_admin(env, ctx.private / "logs", pnpm=PNPM)
        summary["face_admin"] = ctx.face_admin
        summary["face_mode"] = ctx.face_mode
        api_process = api_process_env(env, "" if args.mock else _FACE_KEY)
    ctx.env = env
    if suite == "matrix" and ctx.matrix_source == "evals":
        # Before the API starts, so its directory knows the venture from the first request.
        ctx.memory_venture = run_memory_venture(env, ctx.private / "logs")
        summary["memory_venture"] = ctx.memory_venture or "unavailable"
    if suite == "agenda":
        ctx.agenda_founders = run_agenda_ventures(env, ctx.private / "logs")
    if args.mock:
        summary["models"]["app"] = {"primary": "mock", "fallback": "mock", "embeddings": "mock"}
    error: str | None = None
    stack_cm = Stack(
        env=api_process,
        log_dir=ctx.private / "logs",
        web=suite not in ("matrix", "agenda"),
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
                        stack=stack,
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
    from conversation_lab.logstats import from_file

    summary["app_logs"] = from_file(ctx.private / "logs" / "api.log")
    spend = guard.snapshot()
    spend["app_by_purpose"] = summary.pop("spend_app_by_purpose", [])
    spend["lab_by_purpose"] = ledger.by_purpose()
    summary["spend"] = spend
    summary["duration_seconds"] = round(time.monotonic() - started, 1)
    summary["harness_error"] = error
    if args.baseline_run_id:
        attach_baseline(summary, suite, str(args.baseline_run_id), args.baseline_file)
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


def cmd_run_safety(args: argparse.Namespace) -> int:
    """Suite ``safety`` (conversation_lab/safety.py): apps/api lab-safety-screen.ts on the app's production models,
    with the run's budget as its hard cap. No app, browser, database or lab model: the script calls the app's model
    gateway itself. Its report and every row's verdict stay in the private folder; the summary keeps numbers only."""
    from conversation_lab.budget import Ledger, SpendGuard
    from conversation_lab.report import write
    from conversation_lab.safety import public_result, run_safety_screen, safety_env
    from conversation_lab.stack import PNPM

    budget = float(args.budget_usd)
    if not 0 < budget <= MAX_BUDGET_USD:
        print("run: budget out of range", file=sys.stderr)
        return 2
    out = Path(args.out)
    (out / "private").mkdir(parents=True, exist_ok=True)
    (out / "public").mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    app_budget, lab_budget = budget_parts("safety", budget)
    models = app_models()
    summary: dict[str, Any] = {
        "suite": "safety",
        "budget_usd": budget,
        "stopped_by": None,
        "models": {
            "app": (
                {"primary": "mock", "fallback": "mock", "embeddings": "mock"}
                if args.mock
                else {"primary": models.primary, "fallback": models.fallback, "embeddings": models.embeddings}
            )
        },
    }
    error: str | None = None
    try:
        report, code = run_safety_screen(
            out,
            env=safety_env(
                os.environ, models=models, mock=args.mock, region=os.environ.get("AWS_REGION", "us-east-1")
            ),
            budget_usd=app_budget,
            pnpm=PNPM,
        )
        summary["result"] = public_result(report, exit_code=code)
        if code != 0 or report is None:
            error = "SafetyScreenScriptFailed"
        elif summary["result"]["budget_reached"]:
            summary["stopped_by"] = "budget_app"
    except Exception as exc:  # noqa: BLE001 - reported by class name only; the job fails
        error = type(exc).__name__
    spent = (summary.get("result") or {}).get("cost_usd", {}).get("total") or 0.0
    # Every call of the suite is a screen call on the app's models, metered by the script: the app's share.
    guard = SpendGuard(app_budget=app_budget, lab_budget=lab_budget, ledger=Ledger())
    guard.attach_app(lambda: float(spent))
    spend = guard.snapshot()
    spend["app_by_purpose"] = []
    spend["lab_by_purpose"] = {}
    summary["spend"] = spend
    summary["duration_seconds"] = round(time.monotonic() - started, 1)
    summary["harness_error"] = error
    if args.baseline_run_id:
        attach_baseline(summary, "safety", str(args.baseline_run_id), args.baseline_file)
    text = write(summary, out / "public")
    print(text)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with Path(step_summary).open("a", encoding="utf-8") as fh:
            fh.write(text)
    if error:
        print(
            f"run: the safety screen evaluation failed ({error}); its output is in the sealed artifact",
            file=sys.stderr,
        )
        return 1
    return 0


def attach_baseline(summary: dict[str, Any], suite: str, run_id: str, downloaded: Path | None) -> None:
    """Adds the before/after comparison with `run_id` (or says why there is none) to the summary."""
    from conversation_lab.compare import baseline_path, compare, load_baseline

    if not run_id.isdigit():
        summary["baseline"] = {"run_id": None, "error": "bad_run_id"}
        return
    path = baseline_path(suite, run_id, downloaded)
    if path is None:
        summary["baseline"] = {"run_id": run_id, "error": "not_found"}
        return
    try:
        summary["baseline"] = {"run_id": run_id, "comparison": compare(summary, load_baseline(path))}
    except (ValueError, KeyError, TypeError) as exc:
        summary["baseline"] = {"run_id": run_id, "error": type(exc).__name__}


# ---- suites --------------------------------------------------------------------------------------------------


def suite_recall(
    ctx: Context, *, browser: dict[str, str], lab_client: Any, judge_model: str | None, **_: Any
) -> dict[str, Any]:
    from conversation_lab.budget import BudgetExceededError
    from conversation_lab.recall import (
        GREETING_ID,
        captured_scenarios,
        grade_scenario,
        greeting_result,
        load_recall,
        opener_flags,
    )

    extra = dict(browser)
    if ctx.recall_gap_seconds is not None:
        extra["LAB_RECALL_GAP_SECONDS"] = str(ctx.recall_gap_seconds)
    scenarios = load_recall()["scenarios"][: ctx.max_scenarios]
    # RG-01: a line typed while the greeting plays (how soon the first turn goes out).
    grep = "|".join([*(s["id"] for s in scenarios), GREETING_ID])
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
        "greeting": greeting_result(captured.get(GREETING_ID)),
        "openers": opener_flags(captured),
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
            "LAB_VOICE_REPEAT": str(ctx.repeat),
        },
        timeout=(10 + 8 * ctx.repeat) * 60,
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
    if ctx.matrix_source == "evals":
        return suite_matrix_evals(
            ctx, admin=admin, guard=guard, simulator_model=simulator_model, judge_model=judge_model
        )
    from conversation_lab.app import FOUNDER_NAME
    from conversation_lab.judge import Judge
    from conversation_lab.simulator import LlmSimulator, TemplateSimulator
    from conversation_lab.smoke import SmokeRunner, grading_context, load_smoke, select_scenarios

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
        chosen = select_scenarios(smoke["scenarios"], ctx.scenario_ids, ctx.repeat)
        results, stopped = runner.run(chosen, max(ctx.max_scenarios, len(ctx.scenario_ids) * ctx.repeat))
    finally:
        founder.close()
    return matrix_result(
        results,
        stopped,
        founder_name=str(smoke["founder"]["name"]),
        llm_simulator=simulator_model is not None,
    )


#: evals' planning estimate per matrix turn, from the lab's first evals run (39093976745: the app metered USD 0.388
#: over 66 turns, retries included). evals' default (USD 0.01) cut a 40-scenario plan to 12; the real spend is
#: still capped by --max-cost-usd, which evals charges with the app's own turn costs.
EVALS_EST_TURN_USD = 0.006
#: evals' own per-person turn budget (10 minutes), set to the app's typed limit in the lab (CORE_TURN_RATE_LIMIT).
#: evals gives each scenario the venture's least-used member; the app's voice-turn limit (40 per person per 10
#: minutes, not configurable) answers 429, which evals waits out. A budget of 40 here would instead make every
#: scenario longer than that wait for a member with no recent turns at all (seen in the mock dry run).
EVALS_TURN_RATE_LIMIT = 1000
#: Members evals signs in per venture: the lab's memory venture has three, so its remembered scenarios rotate.
EVALS_ACTORS_PER_VENTURE = 3


def evals_matrix_command(
    *,
    base_url: str,
    scenarios: int,
    max_cost_usd: float,
    simulator_model: str | None,
    judge_model: str | None,
    private: Path,
    memory_venture: str | None = None,
    case_ids: Sequence[str] = (),
) -> list[str]:
    """`python -m foundry_evals run --suite matrix` against the lab's app: Bedrock simulator and judge when the
    probes found them, transcripts and judge rationales to the private folder, reports (ids, codes, numbers) beside
    them."""
    cmd = [
        sys.executable,
        "-m",
        "foundry_evals",
        "run",
        "--suite",
        "matrix",
        "--base-url",
        base_url,
        "--matrix-budget",
        str(scenarios),
        "--max-cost-usd",
        f"{max_cost_usd:.2f}",
        "--max-turns",
        "600",
        "--est-cost-per-turn",
        f"{EVALS_EST_TURN_USD}",
        "--turn-rate-limit",
        str(EVALS_TURN_RATE_LIMIT),
        "--actors-per-venture",
        str(EVALS_ACTORS_PER_VENTURE),
        "--out",
        str(private / "evals-matrix" / "out"),
        "--private-out",
        str(private / "evals-matrix" / "private"),
        "--include-transcripts",
        # Under the spend cap the least important scenarios are the ones skipped (identity and presence first).
        "--matrix-priority",
    ]
    for case in case_ids:
        cmd += ["--case", case]
    if simulator_model:
        cmd += ["--simulator", "llm", "--simulator-model", simulator_model]
    if judge_model:
        cmd += ["--judge", "--judge-model", judge_model]
    if memory_venture:
        from conversation_lab.stack import PNPM

        # Days and weeks later are real: after each such session the lab ages it in its own database.
        cmd += [
            "--memory-venture",
            memory_venture,
            "--between-sessions-cmd",
            f"{shlex.quote(PNPM)} --filter @foundry/api exec tsx src/scripts/lab-age-conversation.ts",
        ]
    return cmd


def record_evals_model_costs(
    guard: Any, matrix: Mapping[str, Any], simulator_model: str | None, judge_model: str | None
) -> None:
    """evals' simulator and judge calls run under the lab's role: their metered cost joins the lab's ledger."""
    from conversation_lab.budget import Charge, micro_ceil

    for purpose, key, model in (
        ("simulator", "simulatorCostUsd", simulator_model),
        ("judge", "judgeCostUsd", judge_model),
    ):
        usd = matrix.get(key)
        if isinstance(usd, int | float) and not isinstance(usd, bool) and usd > 0:
            guard.ledger.add(Charge("bedrock", purpose, model or "unknown", 0, 0, micro_ceil(float(usd))))


def suite_matrix_evals(
    ctx: Context, *, admin: Any, guard: Any, simulator_model: str | None, judge_model: str | None
) -> dict[str, Any]:
    """The conversation matrix of evals/ (w6-matrix) run against the lab's app. Its report holds ids, codes and
    numbers only (evals' reporting contract) and is printed as it is; its log and transcripts stay private."""
    remaining = max(0.0, guard.app_budget + guard.lab_budget - guard.snapshot()["total_usd"])
    cmd = evals_matrix_command(
        base_url=admin.base_url,
        scenarios=ctx.max_scenarios,
        max_cost_usd=remaining,
        simulator_model=simulator_model,
        judge_model=judge_model,
        private=ctx.private,
        memory_venture=ctx.memory_venture,
        case_ids=ctx.scenario_ids,
    )
    log_dir = ctx.private / "evals-matrix"
    log_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **ctx.env,
        "FA_OWNER_ACCESS_CODE": ctx.env.get("E2E_OWNER_ACCESS_CODE", ""),
        "LAB_AGE_LOG": str(log_dir / "aging.log"),
    }
    with (log_dir / "evals.log").open("wb") as log:
        try:
            done = subprocess.run(  # noqa: S603 - fixed arguments
                cmd,
                cwd=REPO / "evals",
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=50 * 60,
                check=False,
            )
            code = done.returncode
        except subprocess.TimeoutExpired:
            code = 124
    out = ctx.private / "evals-matrix" / "out"
    report = (out / "report.md").read_text(encoding="utf-8") if (out / "report.md").is_file() else None
    results = out / "results.json"
    document = json.loads(results.read_text(encoding="utf-8")) if results.is_file() else {}
    cases = [c for c in document.get("cases", []) if isinstance(c, dict)]
    record_evals_model_costs(guard, document.get("matrix") or {}, simulator_model, judge_model)
    return {
        "source": "evals conversation matrix",
        "evals_exit": code,
        "passed": sum(1 for c in cases if c.get("status") == "passed"),
        "run": sum(1 for c in cases if c.get("status") in ("passed", "failed", "error")),
        "evals_report_md": report,
        "aged_gaps": aged_gaps(log_dir / "aging.log"),
        "skipped": [
            {"id": str(c.get("id")), "reason": str(c.get("reason"))}
            for c in cases
            if c.get("status") == "skipped"
        ],
        "stopped_by": None,
    }


def aged_gaps(log: Path) -> dict[str, int] | None:
    """How many remembered conversations the lab aged between sessions, and how many after their distillation
    (counts from apps/api lab-age-conversation.ts's own lines)."""
    if not log.is_file():
        return None
    lines = [line for line in log.read_text(encoding="utf-8").splitlines() if line.startswith("lab-age: ")]
    return {
        "aged": len(lines),
        "after_distillation": sum(1 for line in lines if line.endswith("distilled=yes")),
    }


def matrix_result(
    results: Sequence[Any], stopped: str | None, *, founder_name: str, llm_simulator: bool
) -> dict[str, Any]:
    """The matrix suite's public result: pass rates, dimensions, judge humanness and the phrase census."""
    from collections import Counter

    from conversation_lab.census import census
    from conversation_lab.logstats import SAFE_CODE
    from conversation_lab.smoke import dimension_rates, humanness

    seconds = [t.seconds for r in results for t in r.turns if t.kind != "error"]
    heard = [t.heard for r in results for t in r.turns if t.heard]
    notes: Counter[str] = Counter()
    for r in results:
        for t in r.turns:
            validator = t.detail.get("validator") if isinstance(t.detail, dict) else None
            for note in (validator or {}).get("notes", []) if isinstance(validator, dict) else []:
                if isinstance(note, str) and SAFE_CODE.match(note):
                    notes[note] += 1
    findings: Counter[str] = Counter(code for r in results for code in [*r.high, *r.presence, *r.craft])
    return {
        "validator_notes": dict(sorted(notes.items())),
        "findings": dict(sorted(findings.items())),
        "voice_turns": sum(1 for r in results if r.channel == "call" for t in r.turns if t.kind != "error"),
        "source": "built-in smoke set",
        "census": census(heard, founder_names=(founder_name,)),
        "simulator": "llm" if llm_simulator else "template",
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


def suite_agenda(
    ctx: Context, *, admin: Any, guard: Any, lab_client: Any, judge_model: str | None, **_: Any
) -> dict[str, Any]:
    """The agenda regression (conversation_lab/agenda.py): three remembered conversations on chat and on a call,
    each in its own synthetic venture whose notebook holds one open, past-dated commitment."""
    from conversation_lab.agenda import load, run_channel, summarize
    from conversation_lab.judge import Judge
    from conversation_lab.smoke import TURN_RESERVE_USD, heard_text

    suite = load()
    judge = Judge(lab_client, judge_model) if judge_model else None
    results = []
    folder = ctx.private / "agenda"
    folder.mkdir(parents=True, exist_ok=True)
    for channel in ("chat", "call"):
        name = ctx.agenda_founders.get(channel)
        if name is None:
            return {"passed": 0, "run": 0, "error": f"agenda_venture_missing:{channel}"}
        founder = admin.founder(name)
        try:
            venture = next(v for v in founder.list_ventures() if v.my_role == "founder")
            results += run_channel(
                client=founder,
                venture_id=venture.id,
                channel=channel,
                conversations=suite["conversations"],
                heard=heard_text,
                judge=judge,
                founder_context=f"{name}, founder of {venture.name} (a compression-sleeve medtech venture)",
                reserve=lambda turns: guard.check_app(reserve=TURN_RESERVE_USD * turns),
            )
        finally:
            founder.close()
    for r in results:
        (folder / f"{r.id}.json").write_text(json.dumps(r.private(), indent=1), encoding="utf-8")
    return {
        "passed": sum(1 for r in results if r.passed),
        "run": len(results),
        "agenda": summarize(results),
        "conversations": [r.public() for r in results],
    }


def suite_face(ctx: Context, *, browser: dict[str, str], stack: Any = None, **_: Any) -> dict[str, Any]:
    """The HeyGen LiveAvatar face against the vendor's sandbox (conversation_lab/face.py): the vendor's credits before
    and after and the codes it answered (through the dev server's lab probe), and the browser spec's measurements
    (apps/web/e2e/lab/face.lab.ts), as public numbers. One pass per face mode (``ctx.face_mode``; both: FULL with
    every check, then the API restarted in LITE for the call arm alone, with the same turns and meters)."""
    from conversation_lab.face import (
        PROBE_TOKEN_ENV,
        Probe,
        api_process_env,
        injection_audits,
        public_result,
        read_audit_ids,
        seed_twin,
        server_turns,
        with_face_mode,
    )
    from conversation_lab.stack import PNPM

    token = ctx.face_probe_token
    probe = Probe(browser["E2E_API_URL"], token) if token else None
    before = probe.credits() if probe else None
    extra = {**browser, "LAB_FACE_VENDOR": "heygen" if probe else "stand-in"}
    if token:
        extra[PROBE_TOKEN_ENV] = token
    passes = face_passes(ctx.face_mode)
    # Each pass's own credits and vendor calls, read at its end: the probe remembers the calls of its own API
    # process, and E1 and E2 grade the first pass alone (a later LITE pass is reported beside it, never graded).
    credits_after: dict[str, dict[str, Any] | None] = {}
    calls: dict[str, list[dict[str, Any]]] = {}
    exits: dict[str, int] = {}
    twin = "not_run"
    for index, mode in enumerate(passes):
        if index > 0:
            if stack is None:
                raise RuntimeError("the face suite needs the stack to change the face's mode")
            ctx.env = with_face_mode(ctx.env, mock=ctx.mock, probe_token=token, mode=mode)
            # The vendor key goes to the new API process only, as at the start (face.api_process_env).
            stack.restart_api(api_process_env(ctx.env, "" if ctx.mock else _FACE_KEY))
        if mode == "lite":
            twin = seed_twin(ctx.env, ctx.private / "logs", pnpm=PNPM)
        exits[mode] = run_playwright(
            ctx,
            specs=["--project=face"] if index == 0 else ["--project=face", "--grep", FACE_LITE_CALL_GREP],
            config=LAB_CONFIG,
            report=ctx.private / "face" / ("playwright.json" if index == 0 else f"playwright-{mode}.json"),
            extra_env={**extra, "LAB_FACE_APP_MODE": mode},
            timeout=30 * 60,
        )
        credits_after[mode] = probe.credits() if probe else None
        calls[mode] = probe.vendor_calls() if probe else []
    first, later = passes[0], passes[1:]
    rc = next((code for code in exits.values() if code != 0), 0)
    # Heartbeat or end-of-face: the audits' metadata, read from the lab's own database (the admin API omits it).
    audits = injection_audits(ctx.env, ctx.private / "logs", read_audit_ids(ctx.private), pnpm=PNPM)
    # Each arm's server side (model start, first spoken unit), joined by request id from the API's own log.
    server = server_turns(ctx.private, ctx.private / "logs" / "api.log")
    result = public_result(
        ctx.private,
        playwright_exit=rc,
        credits_before=before,
        credits_after=credits_after[first],
        vendor_calls=calls[first],
        vendor="heygen-sandbox" if probe else "stand-in",
        admin_grant=ctx.face_admin,
        injection_audits=audits,
        face_mode=ctx.face_mode,
        twin=twin,
        lite_vendor_calls=calls["lite"] if "lite" in later else None,
        lite_credits_after=credits_after["lite"] if "lite" in later else None,
        server=server,
    )
    result["playwright_exits"] = exits
    return {"face": result, "passed": result["passed"], "run": result["run"], "playwright_exit": rc}


SUITE_RUNNERS: dict[str, Callable[..., dict[str, Any]]] = {
    "agenda": suite_agenda,
    "face": suite_face,
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
    run.add_argument("--scenarios", default="", help="matrix: only these scenario ids, comma-separated")
    run.add_argument(
        "--repeat", type=int, default=1, help="matrix: run each scenario this many times; voice: calls"
    )
    run.add_argument(
        "--matrix-source",
        choices=("builtin", "evals"),
        default="builtin",
        help="matrix: the lab's 40 scenarios, or evals' conversation matrix (run --suite matrix)",
    )
    run.add_argument(
        "--face-mode",
        choices=FACE_MODES,
        default="both",
        help="face: the in-app call arm's face mode (full, lite, or both side by side)",
    )
    run.add_argument("--out", required=True)
    run.add_argument("--api-port", type=int, default=8787)
    run.add_argument("--web-port", type=int, default=4173)
    run.add_argument(
        "--baseline-run-id",
        default=None,
        help="compare with this earlier run of the same suite (ops/lab/baselines/<suite>-<id>.json, else --baseline-file)",
    )
    run.add_argument("--baseline-file", type=Path, default=None, help="that run's downloaded summary.json")
    run.add_argument(
        "--mock",
        action="store_true",
        help="dry run of the harness itself: the app on the deterministic mock model, no AWS call at all",
    )
    run.set_defaults(func=cmd_run)
    args = parser.parse_args(argv)
    # Out of the environment before anything runs, so no child process inherits it (face.take_key).
    global _FACE_KEY
    from conversation_lab.face import take_key

    _FACE_KEY = take_key(os.environ)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - class name only: a message could carry content
        print(f"conversation_lab: {type(exc).__name__}", file=sys.stderr)
        return 1
