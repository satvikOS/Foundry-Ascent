"""Live-suite commands of ``python -m conversation_lab`` (none of them calls a model):

live-check [--json]                       dataset schema, distinctness and overlap; exits 1 on any failure
live-plan --families F --sample N --repeats R --seed S --budget-usd B [--concurrency C] [--ids ...]
          [--github-output FILE]          the selection, the dry-run cost estimate and the shard split; exits 3
                                          when the estimate exceeds the budget
live-merge --out DIR SUMMARY.json...      shards' public summaries into one (numbers only)
live-calibration packet --private DIR... --out DIR [--size 60] [--seed N]
live-calibration agreement --key key.json --form form.csv
live-smoke --out DIR                      infrastructure-only run on the in-process fake app
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def cmd_check(args: argparse.Namespace) -> int:
    from conversation_lab.live.dataset import DatasetError, load, overlap, overlap_shortfalls
    from conversation_lab.live.distinct import check

    try:
        dataset = load()
    except DatasetError as exc:
        print(f"live-check: schema problems:\n{exc}", file=sys.stderr)
        return 1
    report = check(dataset.scenarios)
    groups = overlap(dataset.scenarios)
    shortfalls = overlap_shortfalls(groups)
    out = {
        "scenarios": len(dataset.scenarios),
        "dataset_sha256": dataset.sha256,
        "distinctness": report.public(),
        "overlap": groups,
        "overlap_shortfalls": shortfalls,
        "ok": report.ok and not shortfalls,
    }
    if args.json:
        print(json.dumps(out, indent=1))
    else:
        print(
            f"live-check: {out['scenarios']} scenarios; distinct={report.ok} (failures {len(report.failures)}, "
            f"shared items {len(report.shared_items)}, nearest cosine {report.nearest_across_families:.3f}); "
            f"overlap {groups['counts']}"
        )
        for f in report.failures[:20]:
            print(f"  near-duplicate: {f.public()}")
        for text, ids in report.shared_items[:20]:
            print(f"  shared item in {ids}: {text[:60]}")
        for s in shortfalls:
            print(f"  overlap shortfall: {s}")
    return 0 if out["ok"] else 1


def cmd_plan(args: argparse.Namespace) -> int:
    from conversation_lab.config import lab_models
    from conversation_lab.live.dataset import load, overlap
    from conversation_lab.live.plan import estimate, parse_families, select, shard

    try:
        dataset = load()
        families = parse_families(args.families)
        ids = [i.strip() for i in (args.ids or "").split(",") if i.strip()]
        picks = select(
            dataset.scenarios,
            families=families,
            sample=args.sample,
            repeats=args.repeats,
            seed=args.seed,
            ids=ids,
        )
        if not picks:
            raise ValueError("the selection is empty")
        lab = lab_models()
        by = dataset.by_id()
        first = estimate(
            picks,
            by,
            prices=lab.prices,
            student_model=lab.live_simulator[0],
            judge_model=lab.live_judge[0],
            concurrency=args.concurrency,
        )
        fallback = estimate(
            picks,
            by,
            prices=lab.prices,
            student_model=lab.live_simulator[-1],
            judge_model=lab.live_judge[-1],
            concurrency=args.concurrency,
        )
        shards = shard(
            picks,
            by,
            prices=lab.prices,
            student_model=lab.live_simulator[0],
            judge_model=lab.live_judge[0],
            budget_usd=args.budget_usd,
            concurrency=args.concurrency,
        )
    except ValueError as exc:
        print(f"live-plan: {exc}", file=sys.stderr)
        return 2
    total = first["usd"]["total"]
    out: dict[str, Any] = {
        "selection": {
            "families": args.families,
            "sample": args.sample,
            "repeats": args.repeats,
            "seed": args.seed,
            "ids": ids,
            "scenario_runs": len(picks),
        },
        "budget_usd": args.budget_usd,
        "estimate": first,
        "estimate_if_nova_fallbacks": fallback["usd"],
        "within_budget": total <= args.budget_usd,
        "overlap": overlap([by[p.scenario_id] for p in picks])["counts"],
        "shards": [
            {k: v for k, v in s.items() if k != "runs"} | {"scenario_runs": len(s["runs"])} for s in shards
        ],
    }
    print(json.dumps(out, indent=1))
    if args.github_output:
        matrix = [{"index": s["index"], "of": s["of"], "budget": f"{s['budget_usd']:.2f}"} for s in shards]
        with Path(args.github_output).open("a", encoding="utf-8") as fh:
            fh.write(f"shards={json.dumps(matrix, separators=(',', ':'))}\n")
            fh.write(f"estimate_usd={total:.2f}\n")
    if total > args.budget_usd:
        print(
            f"live-plan: the estimate (USD {total:.2f}) exceeds the budget (USD {args.budget_usd:.2f}); raise the "
            "budget or narrow the selection",
            file=sys.stderr,
        )
        return 3
    if fallback["usd"]["total"] > args.budget_usd:
        print(
            f"live-plan: note - if the account falls back to Nova models the estimate is USD "
            f"{fallback['usd']['total']:.2f}; the hard cap would stop the run early",
            file=sys.stderr,
        )
    return 0


def cmd_merge(args: argparse.Namespace) -> int:
    from conversation_lab.live.report import merge, render

    summaries = [json.loads(Path(p).read_text(encoding="utf-8")) for p in args.summaries]
    if not summaries:
        print("live-merge: no summaries", file=sys.stderr)
        return 2
    merged = merge(summaries)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "live-summary.json").write_text(json.dumps(merged, indent=1), encoding="utf-8")
    text = render(merged)
    (out / "live-summary.md").write_text(text, encoding="utf-8")
    print(text)
    return 0


def cmd_calibration(args: argparse.Namespace) -> int:
    from conversation_lab.live.calibration import agreement, build_packet

    if args.action == "packet":
        try:
            result = build_packet(
                [Path(p) for p in args.private], Path(args.out), size=args.size, seed=args.seed
            )
        except ValueError as exc:
            print(f"live-calibration: {exc}", file=sys.stderr)
            return 2
        print(json.dumps(result))
        return 0
    print(json.dumps(agreement(Path(args.key), Path(args.form)), indent=1))
    return 0


def cmd_smoke(args: argparse.Namespace) -> int:
    from conversation_lab.live.lab import smoke
    from conversation_lab.live.report import render

    summary = smoke(Path(args.out))
    print(render(summary))
    return 0 if summary["totals"]["executed"] == summary["totals"]["planned"] else 1


def add_commands(sub: Any) -> None:
    check = sub.add_parser("live-check", help="live dataset: schema, distinctness, overlap (fails the build)")
    check.add_argument("--json", action="store_true")
    check.set_defaults(func=cmd_check)

    plan = sub.add_parser(
        "live-plan", help="live: selection, dry-run cost estimate and shards (no model calls)"
    )
    plan.add_argument("--families", default="all")
    plan.add_argument("--sample", type=int, default=0)
    plan.add_argument("--repeats", type=int, default=1)
    plan.add_argument("--seed", type=int, default=1)
    plan.add_argument("--ids", default="")
    plan.add_argument("--budget-usd", type=float, required=True)
    plan.add_argument("--concurrency", type=int, default=4)
    plan.add_argument("--github-output", default=None)
    plan.set_defaults(func=cmd_plan)

    merge = sub.add_parser("live-merge", help="merge shard summaries (numbers only)")
    merge.add_argument("--out", required=True)
    merge.add_argument("summaries", nargs="+")
    merge.set_defaults(func=cmd_merge)

    cal = sub.add_parser("live-calibration", help="blinded human-calibration packet and agreement (private)")
    cal.add_argument("action", choices=("packet", "agreement"))
    cal.add_argument("--private", nargs="*", default=[])
    cal.add_argument("--out", default="calibration")
    cal.add_argument("--size", type=int, default=60)
    cal.add_argument("--seed", type=int, default=1)
    cal.add_argument("--key", default="calibration/key.json")
    cal.add_argument("--form", default="calibration/form.csv")
    cal.set_defaults(func=cmd_calibration)

    smoke = sub.add_parser("live-smoke", help="infrastructure-only smoke run on the in-process fake app")
    smoke.add_argument("--out", required=True)
    smoke.set_defaults(func=cmd_smoke)
