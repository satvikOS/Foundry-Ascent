"""Command-line pieces of the conversation matrix (wired into ``foundry_evals.cli``).

``run --suite matrix``   plays scenarios against a deployed API (template simulator by default; ``--simulator llm``
                         and ``--judge`` use Bedrock models named with ``--simulator-model`` / ``--judge-model``).
``matrix-plan``          prints (or writes) the plan and its coverage for a budget, offline.
``judge-calibrate``      runs a judge model over the calibration conversations and reports its agreement (paid).

Cost safety: model ids are never defaulted (a paid model is always named explicitly), every model call is charged
against ``--max-cost-usd`` with the app's own turn costs, and the plan is cut to what the estimates allow.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from foundry_evals.datasets import DatasetError
from foundry_evals.matrix.bedrock import ConverseModel, LabDependencyError
from foundry_evals.matrix.generator import BUDGETS, DEFAULT_SEED, Scenario, coverage, generate, resolve_budget
from foundry_evals.matrix.judge import LlmJudge, calibrate, load_calibration
from foundry_evals.matrix.runner import MatrixPlan, MockRecorder, PrivateSink, plan_matrix, prioritised
from foundry_evals.matrix.simulator import LlmSimulator, TemplateSimulator, UserSimulator
from foundry_evals.matrix.taxonomy import (
    MATRIX_DIR,
    TAXONOMY_PATH,
    TEMPLATES_PATH,
    Taxonomy,
    load_taxonomy,
    load_templates,
    matrix_digest,
)

SIMULATOR_MODEL_ENV = "FA_MATRIX_SIMULATOR_MODEL"
JUDGE_MODEL_ENV = "FA_MATRIX_JUDGE_MODEL"
REGION_ENV = "AWS_REGION"
CALIBRATION_PATH = MATRIX_DIR / "judge_calibration.yaml"
#: Rough sizes of one call, for the plan's spend estimate (characters in, tokens out).
SIMULATOR_CALL = (3000, 220)
JUDGE_CALL = (9000, 1400)
EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_INFRA = 0, 1, 2, 3


def _budget(value: str) -> str:
    try:
        resolve_budget(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc
    return value


def add_run_arguments(run: argparse.ArgumentParser) -> None:
    group = run.add_argument_group("conversation matrix (--suite matrix)")
    group.add_argument(
        "--matrix-budget",
        type=_budget,
        default="smoke",
        help=f"scenario budget: {', '.join(BUDGETS)} or a number (default smoke); --max-turns and --max-cost-usd "
        "still cap the run",
    )
    group.add_argument(
        "--matrix-seed", type=int, default=DEFAULT_SEED, help=f"generator seed (default {DEFAULT_SEED})"
    )
    group.add_argument(
        "--simulator",
        choices=("template", "llm"),
        default="template",
        help="founder messages: template or a Bedrock model",
    )
    group.add_argument(
        "--simulator-model",
        default=os.environ.get(SIMULATOR_MODEL_ENV) or None,
        help=f"Bedrock model id of the LLM simulator (default ${SIMULATOR_MODEL_ENV}; required with --simulator llm)",
    )
    group.add_argument(
        "--judge-model",
        default=os.environ.get(JUDGE_MODEL_ENV) or None,
        help=f"Bedrock model id of the LLM judge (default ${JUDGE_MODEL_ENV}; required with --judge)",
    )
    group.add_argument(
        "--aws-region", default=os.environ.get(REGION_ENV) or "us-east-1", help="Bedrock region"
    )
    group.add_argument(
        "--private-out",
        type=Path,
        help="directory for content that quotes the conversation (judge rationales); the lab seals it, never upload "
        "it as is",
    )
    group.add_argument(
        "--matrix-priority",
        action="store_true",
        help="plan the most important scenarios first, so a spend cap skips the least important: identity and "
        "presence, then remembered conversations, crisis and safety, emotions and topic moves, the rest",
    )
    group.add_argument(
        "--record-replies",
        type=Path,
        help="record the mock model's replies for the offline CI subset (refused when a reply comes from a real model)",
    )


@dataclass
class MatrixSetup:
    taxonomy: Taxonomy
    scenarios: list[Scenario]
    plan: MatrixPlan
    simulator: UserSimulator
    judge: LlmJudge | None
    judge_estimate_usd: float
    private: PrivateSink | None
    recorder: MockRecorder | None
    meta: dict[str, Any]


def setup_matrix(args: argparse.Namespace, *, turn_cap: int) -> MatrixSetup | int:
    """Everything offline a matrix run needs: datasets, scenarios, simulator, judge, plan. An int is an exit code."""
    try:
        taxonomy = load_taxonomy(getattr(args, "taxonomy", None) or TAXONOMY_PATH)
        templates = load_templates(getattr(args, "templates", None) or TEMPLATES_PATH)
    except DatasetError as exc:
        print(f"dataset error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    scenarios = generate(taxonomy, templates, seed=args.matrix_seed, budget=args.matrix_budget)
    template_sim = TemplateSimulator(taxonomy, templates)
    simulator: UserSimulator = template_sim
    est_sim = 0.0
    if args.simulator == "llm":
        if not args.simulator_model:
            print(f"--simulator llm needs --simulator-model or ${SIMULATOR_MODEL_ENV}", file=sys.stderr)
            return EXIT_USAGE
        sim_model = ConverseModel(args.simulator_model, region=args.aws_region)
        simulator = LlmSimulator(sim_model, template_sim)
        est_sim = sim_model.estimate(input_chars=SIMULATOR_CALL[0], max_tokens=SIMULATOR_CALL[1])
    judge = None
    est_judge = 0.0
    if args.judge:
        if not args.judge_model:
            print(f"--judge needs --judge-model or ${JUDGE_MODEL_ENV}", file=sys.stderr)
            return EXIT_USAGE
        judge_model = ConverseModel(args.judge_model, region=args.aws_region)
        judge = LlmJudge(judge_model)
        est_judge = judge_model.estimate(input_chars=JUDGE_CALL[0], max_tokens=JUDGE_CALL[1]) * 2  # one retry
    if args.record_replies is not None and (args.simulator != "template" or args.judge):
        print(
            "--record-replies records the mock model with the template simulator only (no --judge)",
            file=sys.stderr,
        )
        return EXIT_USAGE
    if (args.simulator == "llm" or args.judge) and args.max_cost_usd is None:
        # A paid model never runs uncapped: --max-turns alone does not bound the simulator's and the judge's calls.
        print("--simulator llm and --judge call paid models: set --max-cost-usd", file=sys.stderr)
        return EXIT_USAGE
    if getattr(args, "matrix_priority", False):
        scenarios = prioritised(scenarios)
    plan = plan_matrix(
        scenarios,
        turn_cap=turn_cap,
        max_cost_usd=args.max_cost_usd,
        est_turn_usd=args.est_cost_per_turn,
        est_simulator_usd=est_sim,
        est_judge_usd=est_judge,
    )
    private = PrivateSink(args.private_out) if args.private_out is not None else None
    cov = coverage(taxonomy, plan.planned, seed=args.matrix_seed)
    meta = {
        "budget": args.matrix_budget,
        "seed": args.matrix_seed,
        "simulator": args.simulator,
        "simulatorModel": args.simulator_model if args.simulator == "llm" else None,
        "judgeModel": args.judge_model if args.judge else None,
        "datasets": {"taxonomy": matrix_digest(TAXONOMY_PATH), "templates": matrix_digest(TEMPLATES_PATH)},
        "generated": len(scenarios),
        "plannedScenarios": len(plan.planned),
        "plannedTurns": plan.planned_turns,
        "estimatedUsd": round(
            plan.planned_turns * (args.est_cost_per_turn + est_sim) + len(plan.planned) * est_judge, 4
        ),
        "coverage": cov.to_dict(),
    }
    return MatrixSetup(
        taxonomy,
        scenarios,
        plan,
        simulator,
        judge,
        est_judge,
        private,
        MockRecorder() if args.record_replies is not None else None,
        meta,
    )


def print_plan(setup: MatrixSetup, log: Any) -> None:
    meta = setup.meta
    cov = meta["coverage"]
    log(
        f"matrix plan: {meta['plannedScenarios']} of {meta['generated']} scenarios ({cov['multiSession']} multi-session), "
        f"{meta['plannedTurns']} turns, pairs {cov['pairs']['covered']}/{cov['pairs']['total']}, values "
        f"{cov['values']['covered']}/{cov['values']['total']}, estimated ${meta['estimatedUsd']:.2f}"
    )


# matrix-plan -----------------------------------------------------------------------------------------------------


def add_plan_parser(sub: Any) -> None:
    plan = sub.add_parser("matrix-plan", help="print the conversation-matrix plan and its coverage (offline)")
    plan.add_argument("--budget", type=_budget, default="smoke", help=f"{', '.join(BUDGETS)} or a number")
    plan.add_argument("--seed", type=int, default=DEFAULT_SEED)
    plan.add_argument(
        "--json", type=Path, help="also write the plan (ids, values, intents, check ids) as JSON"
    )
    plan.add_argument("--list", action="store_true", help="list every scenario")


def cmd_plan(args: argparse.Namespace, out: TextIO) -> int:
    try:
        taxonomy = load_taxonomy()
        templates = load_templates()
    except DatasetError as exc:
        print(f"dataset error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    scenarios = generate(taxonomy, templates, seed=args.seed, budget=args.budget)
    cov = coverage(taxonomy, scenarios, seed=args.seed)
    summary = {"budget": args.budget, "seed": args.seed, **cov.to_dict()}
    out.write(json.dumps(summary, indent=2) + "\n")
    if args.list:
        for s in scenarios:
            v = s.values
            out.write(
                f"{s.id} turns={s.turn_count:<2} {v['question_type']:<14} {v['answer_style']:<20} {v['emotion']:<13} "
                f"{v['trajectory']:<15} {v['topic_dynamic']:<18} {v['relational_move']:<16} {v['continuity']:<19} "
                f"{v['channel']:<5} {v['register']}\n"
            )
    if args.json is not None:
        args.json.write_text(json.dumps([s.to_dict() for s in scenarios], indent=1) + "\n", encoding="utf-8")
    return EXIT_OK


# judge-calibrate -------------------------------------------------------------------------------------------------


def add_calibrate_parser(sub: Any) -> None:
    cal = sub.add_parser(
        "judge-calibrate", help="score the calibration conversations with a judge model (paid)"
    )
    cal.add_argument("--judge-model", default=os.environ.get(JUDGE_MODEL_ENV) or None)
    cal.add_argument("--aws-region", default=os.environ.get(REGION_ENV) or "us-east-1")
    cal.add_argument("--calibration", type=Path, default=CALIBRATION_PATH)
    cal.add_argument("--out", type=Path, help="write the calibration report (numbers only) as JSON")
    cal.add_argument("--min-agreement", type=float, default=0.8)
    cal.add_argument("--max-distance", type=float, default=0.5)
    cal.add_argument(
        "--min-coverage",
        type=float,
        default=0.9,
        help="share of the human-scored criteria the judge must score (default 0.9)",
    )


def cmd_calibrate(args: argparse.Namespace, out: TextIO, *, model: Any = None) -> int:
    """``model`` is a test seam (a fake text model)."""
    if model is None and not args.judge_model:
        print(f"--judge-model or ${JUDGE_MODEL_ENV} is required", file=sys.stderr)
        return EXIT_USAGE
    try:
        cases = load_calibration(args.calibration).cases
    except ValueError as exc:
        print(f"calibration error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    judge = LlmJudge(model or ConverseModel(args.judge_model, region=args.aws_region))
    try:
        report = calibrate(judge, cases)
    except LabDependencyError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_USAGE
    document = report.to_dict() | {
        "passed": report.passed(
            min_agreement=args.min_agreement, max_distance=args.max_distance, min_coverage=args.min_coverage
        ),
        "judgeModel": getattr(judge.model, "model_id", None),
    }
    out.write(json.dumps(document, indent=2) + "\n")
    if args.out is not None:
        args.out.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return EXIT_OK if document["passed"] else EXIT_FAILED
