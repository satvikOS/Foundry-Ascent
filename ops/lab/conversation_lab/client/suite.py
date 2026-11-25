"""The suite's entry points: ``run --suite client`` (the lab's app on its real models, the judge and simulator metered
under the run's hard cap) and ``client-local`` (the same scenarios on the deterministic mock model: no AWS, no cost, the
deterministic graders only), and ``client-pack``."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from conversation_lab.client import pack as client_pack
from conversation_lab.client.scenarios import ClientSet, Scenario, choose, load

#: The owner's cap on a paid run; the expected spend of a whole run on Luna or Nova is under USD 1.
CLIENT_HARD_CAP_USD = 2.0
#: The role session lasts an hour; the job spent part of it installing and seeding.
DEADLINE_SECONDS = 42 * 60


def read_pack(path: str | None) -> client_pack.Pack:
    return client_pack.load(Path(path) if path else None, os.environ)


def load_set(pack: client_pack.Pack, today: dt.date | None = None) -> tuple[ClientSet, dt.date]:
    day = today or dt.datetime.now(dt.UTC).date()
    return load(day, pack.wording), day


def seed(ctx: Any, env: dict[str, str], scenarios: list[Scenario]) -> dict[str, Any]:
    from conversation_lab.client.app import run_seed
    from conversation_lab.stack import PNPM

    return run_seed(env, ctx.private / "logs", scenarios, pnpm=PNPM)


def prepare(ctx: Any, env: dict[str, str], summary: dict[str, Any]) -> None:
    """Before the API starts: the scenarios chosen, their ventures seeded (``cli.cmd_run``)."""
    pack = read_pack(ctx.client_pack)
    # The client's wording is the harness's alone: no child process (the API, the scripts) gets it.
    os.environ.pop("LAB_CLIENT_PACK", None)
    env.pop("LAB_CLIENT_PACK", None)
    chosen, today = load_set(pack)
    scenarios = choose(chosen.scenarios, ctx.scenario_ids)
    seeded = seed(ctx, env, scenarios)
    ctx.client = {
        "pack": pack,
        "scenarios": scenarios,
        "wording": chosen.wording,
        "today": today,
        "seeded": seeded,
    }
    summary["client_seeded"] = f"{len(seeded)}/{len(scenarios)}"
    if len(seeded) < len(scenarios):
        # Never a run of "errors" that reads like the coach's: the plan or the database is wrong (logs are sealed).
        raise RuntimeError("the client ventures were not seeded")


def run_suite(
    ctx: Any,
    *,
    admin: Any,
    guard: Any,
    lab_client: Any,
    simulator_model: str | None,
    judge_model: str | None,
    **_: Any,
) -> dict[str, Any]:
    from conversation_lab.client.app import ClientApp
    from conversation_lab.client.judge import JUDGE_PROMPT_VERSION, ClientJudge
    from conversation_lab.client.report import aggregate, render, write_private
    from conversation_lab.client.runner import ClientRunner
    from conversation_lab.live.lab import code_sha
    from conversation_lab.simulator import LlmSimulator, TemplateSimulator
    from conversation_lab.stack import PNPM

    state = ctx.client
    live = not ctx.mock
    runner = ClientRunner(
        app=ClientApp(admin, ctx.env, ctx.private / "logs", pnpm=PNPM),
        simulator=LlmSimulator(lab_client, simulator_model)
        if live and simulator_model
        else TemplateSimulator(),
        judge=ClientJudge(lab_client, judge_model) if live and judge_model else None,
        today=state["today"],
        guard=guard,
        private_dir=ctx.private,
        concurrency=ctx.concurrency,
        deadline_seconds=DEADLINE_SECONDS,
    )
    results = runner.run(state["scenarios"], state["seeded"])
    summary = aggregate(
        results,
        {
            "suite": "client",
            "evidence": "live"
            if live
            else "local: the app on its deterministic mock model, deterministic graders, no judge",
            "wording": state["wording"],
            "code_sha": code_sha(),
            "run_id": os.environ.get("GITHUB_RUN_ID") or "local",
            "day": state["today"].isoformat(),
            "judge": judge_model if live else None,
            "judge_prompt": JUDGE_PROMPT_VERSION,
            "simulator": simulator_model if live else "template",
        },
    )
    write_private(results, ctx.private / "client", state["pack"].summaries())
    (ctx.public / "client-summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    text = render(summary)
    (ctx.public / "client-summary.md").write_text(text, encoding="utf-8")
    passed = sum(1 for r in results if r.status == "completed" and not r.failures and r.turns)
    return {
        "passed": passed,
        "run": len(results),
        "client_md": text,
        "client": {k: summary[k] for k in ("evidence", "wording", "score", "gates", "blocking_failures")},
        "stopped_by": runner.stopped,
    }


# Commands ------------------------------------------------------------------------------------------------------


def cmd_pack(args: argparse.Namespace) -> int:
    """Writes the client's pack from the client's own files: a private file, never committed."""
    out = Path(args.out).resolve()
    repo = Path(__file__).resolve().parents[4]
    if out.is_relative_to(repo):
        print("client-pack: the pack must be written outside the repository", file=sys.stderr)
        return 2
    try:
        pack = client_pack.build(Path(args.workbook), Path(args.protocol))
    except (client_pack.PackError, OSError, KeyError) as exc:
        print(f"client-pack: {type(exc).__name__}", file=sys.stderr)
        return 2
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(pack.to_json())
    print(f"client-pack: {len(pack.wording)} wordings, {len(pack.tools)} tools scored")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    """The scenario set, validated: ids, groups, sessions and turns."""
    chosen = load(dt.datetime.now(dt.UTC).date())
    for s in chosen.scenarios:
        print(f"{s.id} {s.group} {s.role} sessions={len(s.sessions) * s.repeat} turns={s.turns}")
    print(f"total scenarios={len(chosen.scenarios)} turns={chosen.turns}")
    return 0


def local_database(env: dict[str, str], log: Path) -> tuple[str, str] | None:
    """A fresh local database (``pnpm db:reset``, name from LOCAL_DB_NAME): its URL and owner code."""
    from conversation_lab.config import REPO
    from conversation_lab.stack import PNPM

    done = subprocess.run(  # noqa: S603 - fixed arguments
        [PNPM, "db:reset"], cwd=REPO, env=env, capture_output=True, timeout=600, check=False
    )
    text = done.stdout.decode("utf-8", "replace")
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_bytes(done.stderr)
    url = re.search(r"^DATABASE_URL=(\S+)", text, re.MULTILINE)
    code = re.search(r"FA-[0-9A-Z]{5}(?:-[0-9A-Z]{5}){3}", text)
    if done.returncode != 0 or url is None or code is None:
        return None
    return url.group(1), code.group(0)


def cmd_local(args: argparse.Namespace) -> int:
    """Resets a local database, then runs the suite on the mock model. ``--gate``: exit 3 when a gate that a mock run
    can measure failed."""
    from conversation_lab.cli import main

    out = Path(args.out)
    env = dict(os.environ)
    env.setdefault("LOCAL_DB_NAME", "fa_evals")
    made = local_database(env, out / "private" / "logs" / "db-reset.log")
    if made is None:
        print("client-local: pnpm db:reset failed (is the local PostgreSQL running?)", file=sys.stderr)
        return 2
    os.environ["DATABASE_URL"], os.environ["E2E_OWNER_ACCESS_CODE"] = made
    argv = [
        "run",
        "--suite",
        "client",
        "--mock",
        "--budget-usd",
        str(CLIENT_HARD_CAP_USD),
        "--out",
        str(out),
        "--api-port",
        str(args.api_port),
        "--concurrency",
        str(args.concurrency),
        "--scenarios",
        args.scenarios,
    ]
    if args.client_pack:
        argv += ["--client-pack", args.client_pack]
    code = main(argv)
    if code != 0 or not args.gate:
        return code
    from conversation_lab.client.report import gates_failed

    summary = json.loads((out / "public" / "client-summary.json").read_text(encoding="utf-8"))
    failed = gates_failed(summary)
    if failed:
        print(f"client-local: {len(failed)} gates failed: {'; '.join(failed)}", file=sys.stderr)
        return 3
    return 0


def add_commands(sub: Any) -> None:
    local = sub.add_parser("client-local", help="the client test on the mock model: no AWS, no cost")
    local.add_argument("--out", required=True)
    local.add_argument("--scenarios", default="", help="only these scenario ids, comma-separated")
    local.add_argument(
        "--client-pack", default="", help="the client's pack (client-pack), for the exact wording"
    )
    local.add_argument("--api-port", type=int, default=8893)
    local.add_argument("--concurrency", type=int, default=4)
    local.add_argument("--gate", action="store_true", help="exit 3 when a measured gate failed")
    local.set_defaults(func=cmd_local)
    pack = sub.add_parser("client-pack", help="write the client's pack from the client's own files (private)")
    pack.add_argument("--workbook", required=True, help="the client's workbook (.xlsx)")
    pack.add_argument("--protocol", required=True, help="the client's protocol, as text")
    pack.add_argument("--out", required=True, help="a file outside the repository")
    pack.set_defaults(func=cmd_pack)
    listing = sub.add_parser("client-list", help="validate and list the client scenarios")
    listing.set_defaults(func=cmd_list)
