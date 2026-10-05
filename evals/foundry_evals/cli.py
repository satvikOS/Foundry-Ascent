"""Command line: ``python -m foundry_evals run|validate``.

``run`` exit codes: 0 every blocking gate passed · 1 a gate failed · 2 usage / dataset error ·
3 environment or infrastructure error (results are still written when possible).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import traceback
import uuid
from collections import Counter
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, TextIO

import httpx
from pydantic import SecretStr

from foundry_evals import __version__
from foundry_evals.client import normalize_base_url
from foundry_evals.datasets import DATASETS_DIR, DatasetError, dataset_digest, load_redteam, load_scenarios
from foundry_evals.environment import Environment, EnvironmentSetupError
from foundry_evals.graders.judge import JudgeNotAvailableError, load_judge
from foundry_evals.planning import Budget, build_cases, plan_cases
from foundry_evals.report import write_reports
from foundry_evals.results import RunResults
from foundry_evals.runner import Runner, RunnerOptions

EXIT_OK, EXIT_GATE_FAILED, EXIT_USAGE, EXIT_INFRA = 0, 1, 2, 3
ACCESS_CODE_ENV = "FA_OWNER_ACCESS_CODE"
BASE_URL_ENV = "FA_BASE_URL"


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _stamp(now: dt.datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%SZ")


def _log(message: str) -> None:
    print(message, flush=True)


def _positive_float(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return number


def _positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="foundry_evals", description="Foundry Ascent scenario benchmark and red team."
    )
    parser.add_argument("--version", action="version", version=f"foundry_evals {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run a suite against a deployed API")
    run.add_argument("--suite", choices=("scenarios", "redteam", "all"), default="all")
    run.add_argument(
        "--base-url", default=os.environ.get(BASE_URL_ENV), help=f"site URL (default: ${BASE_URL_ENV})"
    )
    run.add_argument("--out", type=Path, help="output directory (default: evals/results/<UTC timestamp>)")
    run.add_argument(
        "--max-turns", type=_positive_int, default=100, help="hard cap on model turns (default 100)"
    )
    run.add_argument(
        "--max-cost-usd",
        type=_positive_float,
        help="spend budget; caps turns at budget / --est-cost-per-turn",
    )
    run.add_argument(
        "--est-cost-per-turn", type=_positive_float, default=0.01, help="planning estimate (default $0.01)"
    )
    run.add_argument(
        "--case", action="append", default=[], metavar="ID", help="run only these case ids (repeatable)"
    )
    run.add_argument(
        "--category", action="append", default=[], metavar="NAME", help="run only these categories/groups"
    )
    run.add_argument("--skip-probes", action="store_true", help="do not run API authorization probes")
    run.add_argument(
        "--max-wait-seconds", type=_positive_float, default=900.0, help="longest rate-limit wait"
    )
    run.add_argument(
        "--turn-rate-limit", type=_positive_int, default=20, help="server turns per principal per window"
    )
    run.add_argument(
        "--actors-per-venture", type=_positive_int, default=2, help="synthetic principals per venture"
    )
    run.add_argument(
        "--include-transcripts", action="store_true", help="also write transcripts.jsonl (LOCAL USE ONLY)"
    )
    run.add_argument("--no-data-ok", action="store_true", help="do not fail blocking gates that have no data")
    run.add_argument("--judge", action="store_true", help="LLM-judge rubric (out of scope for V1)")
    run.add_argument(
        "--dry-run", action="store_true", help="plan only: validate datasets, print the plan, no network"
    )
    run.add_argument("--datasets-dir", type=Path, default=DATASETS_DIR)

    validate = sub.add_parser("validate", help="validate the datasets and print counts (offline)")
    validate.add_argument("--datasets-dir", type=Path, default=DATASETS_DIR)
    return parser


def cmd_validate(args: argparse.Namespace, out: TextIO) -> int:
    try:
        scenarios = load_scenarios(args.datasets_dir / "scenarios.yaml")
        redteam = load_redteam(args.datasets_dir / "redteam.yaml")
    except DatasetError as exc:
        print(f"dataset error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    s = scenarios.scenarios
    summary: dict[str, Any] = {
        "scenarios": len(s),
        "highRisk": sum(1 for x in s if x.risk == "high"),
        "byStage": dict(Counter(x.stage for x in s)),
        "byDomain": dict(Counter(x.domain for x in s)),
        "byMode": dict(Counter(x.mode for x in s)),
        "byRiskArea": dict(Counter(x.risk_area for x in s if x.risk_area)),
        "attacks": len(redteam.attacks),
        "byCategory": dict(Counter(a.category for a in redteam.attacks)),
        "byTechnique": dict(Counter(a.technique for a in redteam.attacks)),
        "apiProbes": len(redteam.api_probes),
        "turns": {
            "scenarios": sum(len(x.setup_turns) + 1 for x in s),
            "redteam": sum(len(a.turns) for a in redteam.attacks),
        },
    }
    out.write(json.dumps(summary, indent=2) + "\n")
    return EXIT_OK


def cmd_run(
    args: argparse.Namespace,
    *,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """``transport``, ``sleep`` and ``clock`` are test seams (an in-memory API, virtual time)."""
    if args.judge:
        try:
            load_judge()
        except JudgeNotAvailableError as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_USAGE
    try:
        scenarios = (
            load_scenarios(args.datasets_dir / "scenarios.yaml")
            if args.suite in ("scenarios", "all")
            else None
        )
        redteam = (
            load_redteam(args.datasets_dir / "redteam.yaml") if args.suite in ("redteam", "all") else None
        )
    except DatasetError as exc:
        print(f"dataset error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    budget = Budget(args.max_turns, args.max_cost_usd, args.est_cost_per_turn)
    cases = build_cases(args.suite, scenarios, redteam, ids=args.case, categories=args.category)
    if not cases:
        print("no cases match the selection", file=sys.stderr)
        return EXIT_USAGE
    plan = plan_cases(cases, budget.turn_cap)
    _log(
        f"plan: {len(plan.planned)} cases / {plan.planned_turns} turns within cap {budget.turn_cap}; "
        f"{len(plan.skipped)} skipped for budget"
    )
    if args.dry_run:
        for case in plan.planned:
            _log(f"  {case.id:<10} {case.group:<30} turns={case.turn_count}")
        return EXIT_OK

    if not args.base_url:
        print(f"--base-url or ${BASE_URL_ENV} is required", file=sys.stderr)
        return EXIT_USAGE
    try:
        base_url = normalize_base_url(args.base_url)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_USAGE
    raw_code = os.environ.get(ACCESS_CODE_ENV, "").strip()
    if not raw_code:
        print(
            f"${ACCESS_CODE_ENV} is required (the owner access code; never pass it on the command line)",
            file=sys.stderr,
        )
        return EXIT_USAGE
    owner_code = SecretStr(raw_code)
    del raw_code

    started = _utc_now()
    run_id = f"{_stamp(started)}-{uuid.uuid4().hex[:6]}"
    out_dir: Path = args.out or (Path(__file__).resolve().parent.parent / "results" / _stamp(started))
    results = RunResults(
        run_id=run_id,
        suite=args.suite,
        base_url=base_url,
        started_at=started.isoformat(timespec="seconds"),
        datasets={
            name: dataset_digest(args.datasets_dir / name)
            for name in ("scenarios.yaml", "redteam.yaml")
            if (args.datasets_dir / name).exists()
        },
        budget={
            "maxTurns": args.max_turns,
            "maxCostUsd": args.max_cost_usd,
            "estCostPerTurn": args.est_cost_per_turn,
            "turnCap": budget.turn_cap,
            "plannedCases": len(plan.planned),
            "plannedTurns": plan.planned_turns,
            "skippedForBudget": len(plan.skipped),
        },
    )
    _log(f"run {run_id}: suite={args.suite} target={base_url}")
    env = Environment(
        base_url,
        run_id,
        owner_code=owner_code,
        max_actors_per_venture=args.actors_per_venture,
        log=_log,
        transport=transport,
        sleep=sleep,
    )
    exit_code = EXIT_OK
    transcript_file: TextIO | None = None
    try:
        env.setup(wait_seconds=args.max_wait_seconds)
        results.app_version = env.app_version
        transcript_sink = None
        if args.include_transcripts:
            out_dir.mkdir(parents=True, exist_ok=True)
            transcript_file = (out_dir / "transcripts.jsonl").open("w", encoding="utf-8")
            _log(
                "WARNING: writing transcripts.jsonl with full prompts and responses (local use only; do not upload)"
            )

            def transcript_sink(entry: dict[str, Any], _f: TextIO = transcript_file) -> None:
                _f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        runner = Runner(
            env,
            RunnerOptions(
                turn_cap=budget.turn_cap,
                max_cost_usd=args.max_cost_usd,
                turn_rate_limit=args.turn_rate_limit,
                max_wait_seconds=args.max_wait_seconds,
            ),
            log=_log,
            sleep=sleep,
            clock=clock,
            transcript=transcript_sink,
        )
        if redteam is not None and not args.skip_probes and not args.case:
            results.probes = runner.run_probes(list(redteam.api_probes))
        results.cases = runner.run_cases(plan)
        results.turns_used = runner.turns_used
        results.cost_usd_reported = runner.cost_usd
        results.aborted = runner.aborted if runner.aborted != "budget" else None
        if results.aborted:
            exit_code = EXIT_INFRA
    except EnvironmentSetupError as exc:
        print(f"setup failed: {exc}", file=sys.stderr)
        results.aborted = "setup_failed"
        exit_code = EXIT_INFRA
    except Exception as exc:  # noqa: BLE001 - always tear down and write what we have
        # Location only: exception messages may quote API payloads, which must not reach public logs.
        frames = traceback.extract_tb(exc.__traceback__)
        where = " <- ".join(f"{Path(f.filename).name}:{f.lineno}:{f.name}" for f in reversed(frames[-6:]))
        print(f"internal error: {type(exc).__name__} at {where}", file=sys.stderr)
        results.aborted = "internal_error"
        exit_code = EXIT_INFRA
    finally:
        if transcript_file is not None:
            transcript_file.close()
        try:
            teardown = env.teardown()
            results.environment["teardown"] = {
                "codesIssued": teardown.codes_issued,
                "codesRevoked": teardown.codes_revoked,
                "revokeFailures": teardown.revoke_failures,
                "signOutFailures": teardown.sign_out_failures,
            }
            if teardown.revoke_failures:
                print(
                    "::warning::some evaluation access codes could not be revoked; they expire within 1 day",
                    file=sys.stderr,
                )
        except Exception as exc:  # noqa: BLE001 - teardown must never hide the run result
            print(f"teardown error: {type(exc).__name__}", file=sys.stderr)
        results.environment["ventures"] = env.summary()
        results.finished_at = _utc_now().isoformat(timespec="seconds")

    gates, passed = write_reports(results, out_dir, no_data_ok=args.no_data_ok)
    _log("")
    for gate in gates:
        flag = "" if gate.blocking else " (informational)"
        _log(f"{gate.id:<4} {gate.status.upper():<8} {gate.title}: {gate.observed} [{gate.threshold}]{flag}")
        if gate.blocking and gate.status != "pass" and os.environ.get("GITHUB_ACTIONS") == "true":
            print(
                f"::error title=Eval gate {gate.id}::{gate.title}: {gate.observed} (threshold {gate.threshold})"
            )
    _log(f"results: {out_dir / 'results.json'}")
    _log(f"report:  {out_dir / 'report.md'}")
    if exit_code != EXIT_OK:
        return exit_code
    return EXIT_OK if passed else EXIT_GATE_FAILED


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "validate":
        return cmd_validate(args, sys.stdout)
    return cmd_run(args)
