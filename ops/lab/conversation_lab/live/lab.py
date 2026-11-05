"""The live suite inside the conversation lab: seeding one synthetic venture per scenario run, the app port the
runner uses (founder sign-in, ageing between sessions), the suite entry point for ``run --suite live``, and the
infrastructure-only smoke run (``live-smoke``) on the in-process fake app."""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from conversation_lab.config import REPO, model_family
from conversation_lab.live.dataset import SCHEMA_VERSION, Dataset, Scenario, load, overlap
from conversation_lab.live.judge import JUDGE_PROMPT_VERSION
from conversation_lab.live.plan import Pick, parse_families, select
from conversation_lab.live.runner import LiveRunner, Seeded
from conversation_lab.live.student import STUDENT_PROMPT_VERSION

SEED_SCRIPT = "src/scripts/lab-live-ventures.ts"
AGE_SCRIPT = "src/scripts/lab-age-conversation.ts"


def venture_key(run_id: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", run_id.lower()).strip("-")


def venture_goal(raw: Mapping[str, Any]) -> str:
    """The venture's goal as the app shows it to the coach: an authored ``venture.goal`` when the scenario has one, else
    a neutral line from the one-liner. Never the student's private ``objective`` (live pilot 42099643194: seeded as the
    venture's current goal, it handed the coach the student's hidden intent and, in all three isolation runs, the other
    venture or deal, which the coach then named first and the judge scored as disclosure)."""
    v = raw["venture"]
    authored = v.get("goal")
    if isinstance(authored, str) and authored.strip():
        return authored.strip()
    return f"Build {v['name']}: {v['oneLiner']}"


def seed_plan(picks: Sequence[Pick], scenarios: Mapping[str, Scenario]) -> list[dict[str, Any]]:
    """One venture and founder per scenario run, plus the neighbour venture of isolation scenarios (owned by the
    same founder when the scenario says so: separate ventures of one student)."""
    entries = []
    for p in picks:
        raw = scenarios[p.scenario_id].raw
        key = venture_key(p.run_id)
        v = raw["venture"]
        entries.append(
            {
                "key": key,
                "name": v["name"],
                "oneLiner": v["oneLiner"],
                "stage": v["stage"],
                "domain": v["domain"],
                "goal": venture_goal(raw),
                "founderKey": key,
                "founderName": raw["student"]["name"],
            }
        )
        n = raw.get("neighbour")
        if n:
            same = n["founder"] == raw["student"]["name"]
            entries.append(
                {
                    "key": f"{key}-nb",
                    "name": n["venture"],
                    "oneLiner": f"A separate venture of the same cohort ({n['venture']})",
                    "stage": "validation",
                    "domain": "general",
                    "goal": "Separate venture used to test isolation",
                    "founderKey": key if same else f"{key}-nb",
                    "founderName": n["founder"],
                }
            )
    return entries


_SEED_LINE = re.compile(
    r"^lab-live-ventures: key=([a-z0-9-]+) venture=([0-9a-f-]{36}) founder=([0-9a-f-]{36})$"
)


def parse_seed_output(text: str) -> dict[str, tuple[str, str]]:
    out = {}
    for line in text.splitlines():
        m = _SEED_LINE.match(line.strip())
        if m:
            out[m.group(1)] = (m.group(2), m.group(3))
    return out


def seeded_map(
    picks: Sequence[Pick], scenarios: Mapping[str, Scenario], ids: Mapping[str, tuple[str, str]]
) -> dict[str, Seeded]:
    out = {}
    for p in picks:
        key = venture_key(p.run_id)
        if key not in ids:
            continue
        venture, founder = ids[key]
        nb = ids.get(f"{key}-nb")
        out[p.run_id] = Seeded(
            venture_id=venture,
            founder_id=founder,
            neighbour_venture_id=nb[0] if nb else None,
            neighbour_founder_id=nb[1] if nb else None,
        )
    return out


def run_seed(
    env: Mapping[str, str], log_dir: Path, plan: Sequence[Mapping[str, Any]], *, pnpm: str
) -> dict[str, tuple[str, str]]:
    """apps/api lab-live-ventures.ts on the lab's local database (it refuses any other). Ids and counts only."""
    log_dir.mkdir(parents=True, exist_ok=True)
    plan_file = log_dir / "live-seed-plan.json"
    plan_file.write_text(json.dumps(list(plan)), encoding="utf-8")
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [pnpm, "--filter", "@foundry/api", "exec", "tsx", SEED_SCRIPT, "--plan", str(plan_file)],
        cwd=REPO,
        env=dict(env),
        capture_output=True,
        timeout=600,
        check=False,
    )
    (log_dir / "live-seed.log").write_bytes(done.stdout + done.stderr)
    return parse_seed_output(done.stdout.decode("utf-8", "replace"))


class LabApp:
    """The runner's view of the lab's app: founder clients signed in with one-day codes the owner issues, and the
    lab's ageing script between sessions."""

    def __init__(self, admin: Any, env: Mapping[str, str], log_dir: Path, *, pnpm: str) -> None:
        self.admin = admin
        self.env = dict(env)
        self.log_dir = log_dir
        self.pnpm = pnpm
        self._lock = threading.Lock()
        #: Serialises every use of the owner's client (code issuing here, usage reads in the runner's guard).
        self.lock = threading.Lock()

    def founder_client(self, principal_id: str) -> Any:
        from foundry_evals.client import FoundryClient

        with self.lock:
            issued = self.admin.client.issue_access_code(
                principal_id, label="live evaluation", expires_in_days=1
            )
        client = FoundryClient(self.admin.base_url, request_id_prefix="live")
        client.sign_in(issued.access_code)
        return client

    def _age(self, session_id: str, days: int, wait: int) -> str | None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        try:
            done = subprocess.run(  # noqa: S603 - fixed argument list
                [
                    self.pnpm,
                    "--filter",
                    "@foundry/api",
                    "exec",
                    "tsx",
                    AGE_SCRIPT,
                    "--session-id",
                    session_id,
                    "--gap-days",
                    str(days),
                    "--wait-seconds",
                    str(wait),
                ],
                cwd=REPO,
                env=self.env,
                capture_output=True,
                timeout=wait + 120,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "timeout"
        with self._lock, (self.log_dir / "live-aging.log").open("ab") as fh:
            fh.write(done.stdout + done.stderr)
        return None if done.returncode == 0 else f"exit_{done.returncode}"

    def between_sessions(self, session_id: str, gap_days: int) -> str | None:
        return self._age(session_id, max(1, gap_days), 120)

    def wait_distilled(self, session_id: str) -> str | None:
        # Ageing by one day after the last session changes nothing the judge sees; the script's wait is the point.
        return self._age(session_id, 1, 90)


def code_sha() -> str:
    sha = os.environ.get("GITHUB_SHA", "").strip()
    if sha:
        return sha
    try:
        done = subprocess.run(
            ["git", "rev-parse", "HEAD"],  # noqa: S607 - git from PATH, read-only
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return done.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"


def meta(
    dataset: Dataset,
    picks: Sequence[Pick],
    *,
    evidence: str,
    coach: str,
    student: str,
    judge: str,
    selection: Mapping[str, Any],
    started_at: str,
) -> dict[str, Any]:
    families = {model_family(coach), model_family(student), model_family(judge)}
    return {
        "suite": "live",
        "evidence": evidence,
        "run_id": os.environ.get("GITHUB_RUN_ID") or datetime.now(UTC).strftime("local-%Y%m%dT%H%M%SZ"),
        "started_at": started_at,
        "finished_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "dataset_sha256": dataset.sha256,
        "code_sha": code_sha(),
        "versions": {
            "schema": SCHEMA_VERSION,
            "student_prompt": STUDENT_PROMPT_VERSION,
            "judge_prompt": JUDGE_PROMPT_VERSION,
            "scenario_versions": sorted({int(dataset.by_id()[p.scenario_id].raw["version"]) for p in picks}),
        },
        "models": {
            "coach": coach,
            "student": student,
            "judge": judge,
            "families": sorted(families),
            "judge_independent": model_family(judge) != model_family(coach),
            "student_independent": model_family(student) != model_family(coach),
        },
        "selection": dict(selection),
        "overlap": overlap([dataset.by_id()[p.scenario_id] for p in picks]),
    }


def selection_from(ctx: Any, dataset: Dataset) -> tuple[list[Pick], dict[str, Any]]:
    families = parse_families(ctx.live_families)
    picks = select(
        dataset.scenarios,
        families=families,
        sample=ctx.live_sample,
        repeats=ctx.repeat,
        seed=ctx.live_seed,
        ids=ctx.scenario_ids,
    )
    shard, of = ctx.live_shard
    from conversation_lab.config import lab_models
    from conversation_lab.live.plan import shard as split

    lab = lab_models()
    if of > 1:
        shards = split(
            picks,
            dataset.by_id(),
            prices=lab.prices,
            student_model=lab.live_simulator[0],
            judge_model=lab.live_judge[0],
            budget_usd=ctx.live_total_budget or ctx.budget_usd,
            concurrency=ctx.concurrency,
        )
        if len(shards) != of:
            raise ValueError(f"the selection splits into {len(shards)} shards, not {of}")
        wanted = set(shards[shard - 1]["runs"])
        picks = [p for p in picks if p.run_id in wanted]
    return picks, {
        "families": ctx.live_families,
        "sample": ctx.live_sample,
        "seed": ctx.live_seed,
        "repeats": ctx.repeat,
        "shard": f"{shard}/{of}",
        "ids": list(ctx.scenario_ids),
        "memory_review": "approve_all" if getattr(ctx, "live_approve_memory", False) else "product_default",
    }


def smoke(out: Path, *, count: int = 6) -> dict[str, Any]:
    """Infrastructure-only: a handful of scenarios (single- and multi-session, chat and call, an isolation one)
    through the real runner, checks, judge parsing and report on the fake app, mock student and mock judge."""
    from conversation_lab.live.fake import FakeApp
    from conversation_lab.live.judge import MockJudge
    from conversation_lab.live.report import aggregate, render
    from conversation_lab.live.student import MockStudent

    dataset = load()
    by = dataset.by_id()
    wanted = ["LV-01-01", "LV-16-01", "LV-26-01", "LV-29-01", "LV-17-01", "LV-30-01"][:count]
    picks = [Pick(i, 1) for i in wanted]
    app = FakeApp()
    seeded = {
        p.run_id: Seeded(f"v-{p.run_id}", f"f-{p.run_id}", f"v-{p.run_id}-nb", f"f-{p.run_id}-nb")
        for p in picks
    }
    started = datetime.now(UTC).isoformat(timespec="seconds")
    runner = LiveRunner(
        app=app, student=MockStudent(), judge=MockJudge(), private_dir=out / "private", log=lambda _m: None
    )
    results = runner.run(picks, by, seeded)
    summary = aggregate(
        [r.public() for r in results],
        meta(
            dataset,
            picks,
            evidence="infrastructure-only (fake app, mock student, mock judge; not behavioural evidence)",
            coach="mock",
            student="mock",
            judge="mock",
            selection={"ids": wanted},
            started_at=started,
        ),
    )
    summary["spend"] = {"total_usd": 0.0}
    (out / "public").mkdir(parents=True, exist_ok=True)
    (out / "public" / "live-summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    (out / "public" / "live-summary.md").write_text(render(summary), encoding="utf-8")
    return summary
