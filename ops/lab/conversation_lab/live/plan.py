"""What a live run will do and what it will cost, before anything is called: the scenario selection (families,
stratified sample, repeats), the dry-run cost estimate, and the split into shards that each fit one GitHub job
(the conversation-lab role's one-hour session) and the per-run budget cap.

Every figure is an estimate with its assumptions printed beside it; the hard caps (the app's daily cap and the
lab's metered spend guard) are what actually bound spend.
"""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from conversation_lab.config import MAX_BUDGET_USD, Price, foundation_model_id
from conversation_lab.live.dataset import FAMILIES, Scenario
from conversation_lab.live.judge import scenario_brief, system_prompt
from conversation_lab.live.student import SYSTEM as STUDENT_SYSTEM
from conversation_lab.live.student import persona_card

#: The app's metered cost of one coach turn in the lab, distillation and embeddings included: evals' first lab
#: matrix run (39093976745) metered USD 0.388 over 66 turns. Typed-input calls synthesise no audio (Polly is called
#: only when a client fetches /speech), so a call turn costs the same.
COACH_USD_PER_TURN = 0.006
#: Distillation and digest at the end of each standard session, on top of the per-turn figure (conservative).
COACH_USD_PER_SESSION = 0.003
#: Token sizes (characters / 3.6, rounded up; real English is nearer 4 characters a token).
STUDENT_MSG_TOKENS = 45
COACH_CHAT_TOKENS = 190
COACH_CALL_TOKENS = 90
OPENER_TOKENS = 50
MEMORY_TOKENS = 260
STUDENT_OUT_TOKENS = 95
JUDGE_OUT_TOKENS = 700
HISTORY_WINDOW = 12
#: Simulator retries after a contract break (observed rate unknown before the pilot: assume 8 percent).
STUDENT_RETRY_FACTOR = 1.08
#: Seconds, for the wall-time estimate only.
COACH_SECONDS_CHAT = 5.5
COACH_SECONDS_CALL = 4.5
STUDENT_SECONDS = 2.0
SESSION_OVERHEAD_SECONDS = 4.0
DISTILL_WAIT_SECONDS = 45.0
SETUP_SECONDS = 12.0
JUDGE_SECONDS = 14.0
#: A shard's target wall time (the role session is one hour; the job also installs, builds and seeds first).
SHARD_TARGET_MINUTES = 38.0
DEFAULT_CONCURRENCY = 4
MAX_SHARDS = 40


def _tok(text: str) -> int:
    return math.ceil(len(text) / 3.6)


@dataclass(frozen=True)
class Pick:
    scenario_id: str
    repeat: int

    @property
    def run_id(self) -> str:
        return self.scenario_id if self.repeat == 1 else f"{self.scenario_id}#{self.repeat}"


def parse_families(spec: str) -> list[int]:
    """'all', or a comma list of numbers and ranges: '1,5,9-12'."""
    text = spec.strip().lower()
    if text in ("", "all"):
        return sorted(FAMILIES)
    out: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        if "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
            if a > b:
                raise ValueError(f"bad family range {part}")
            out.update(range(a, b + 1))
        elif part:
            out.add(int(part))
    bad = sorted(n for n in out if n not in FAMILIES)
    if bad or not out:
        raise ValueError(f"families must be 1-30 (got {bad or 'none'})")
    return sorted(out)


def select(
    scenarios: Sequence[Scenario],
    *,
    families: Sequence[int],
    sample: int = 0,
    repeats: int = 1,
    seed: int = 1,
    ids: Sequence[str] = (),
) -> list[Pick]:
    """The scenario runs: explicit ``ids``, or every scenario of ``families``, or a stratified ``sample`` of them
    (equal share per family, the remainder to the first families in seeded order); each ``repeats`` times. The same
    inputs always give the same selection."""
    if not 1 <= repeats <= 5:
        raise ValueError("repeats must be 1 to 5")
    by_id = {s.id: s for s in scenarios}
    if ids:
        missing = sorted(set(ids) - set(by_id))
        if missing:
            raise ValueError(f"unknown scenario ids: {', '.join(missing)}")
        chosen = [by_id[i] for i in ids]
    else:
        pool = {f: sorted((s for s in scenarios if s.family == f), key=lambda s: s.id) for f in families}
        if sample <= 0 or sample >= sum(len(v) for v in pool.values()):
            chosen = [s for f in families for s in pool[f]]
        else:
            rng = random.Random(seed)  # noqa: S311 - reproducible sampling, not security
            order = list(families)
            rng.shuffle(order)
            base, extra = divmod(sample, len(order))
            chosen = []
            for i, f in enumerate(order):
                want = min(len(pool[f]), base + (1 if i < extra else 0))
                members = list(pool[f])
                rng.shuffle(members)
                chosen += members[:want]
            chosen.sort(key=lambda s: s.id)
    return [Pick(s.id, r) for r in range(1, repeats + 1) for s in chosen]


@dataclass
class ScenarioEstimate:
    coach_usd: float
    student_usd: float
    judge_usd: float
    seconds: float
    student_turns: int

    @property
    def usd(self) -> float:
        return self.coach_usd + self.student_usd + self.judge_usd


def _price(prices: Mapping[str, Price], model: str) -> Price:
    return prices[foundation_model_id(model)]


def estimate_scenario(s: Scenario, *, student_price: Price, judge_price: Price) -> ScenarioEstimate:
    sys_tokens = _tok(STUDENT_SYSTEM) + _tok(persona_card(s)) + 120
    history: list[int] = []
    student_in = 0
    coach_seconds = 0.0
    transcript = 0
    for sess in s.sessions:
        coach_tokens = COACH_CALL_TOKENS if sess.channel == "call" else COACH_CHAT_TOKENS
        history.append(OPENER_TOKENS)
        transcript += OPENER_TOKENS
        for _ in range(sess.turns):
            window = sum(history[-HISTORY_WINDOW:])
            student_in += sys_tokens + window + coach_tokens
            history.append(STUDENT_MSG_TOKENS + coach_tokens)
            transcript += STUDENT_MSG_TOKENS + coach_tokens
            coach_seconds += (
                COACH_SECONDS_CALL if sess.channel == "call" else COACH_SECONDS_CHAT
            ) + STUDENT_SECONDS
    turns = s.student_turns
    student_usd = (
        (student_in * student_price.input + turns * STUDENT_OUT_TOKENS * student_price.output)
        / 1_000_000
        * STUDENT_RETRY_FACTOR
    )
    judge_in = _tok(system_prompt()) + _tok(scenario_brief(s)) + transcript + MEMORY_TOKENS
    judge_usd = (judge_in * judge_price.input + JUDGE_OUT_TOKENS * judge_price.output) / 1_000_000
    coach_usd = turns * COACH_USD_PER_TURN + len(s.sessions) * COACH_USD_PER_SESSION
    seconds = (
        SETUP_SECONDS
        + coach_seconds
        + len(s.sessions) * (SESSION_OVERHEAD_SECONDS + DISTILL_WAIT_SECONDS)
        + JUDGE_SECONDS
    )
    return ScenarioEstimate(coach_usd, student_usd, judge_usd, seconds, turns)


def estimate(
    picks: Sequence[Pick],
    scenarios: Mapping[str, Scenario],
    *,
    prices: Mapping[str, Price],
    student_model: str,
    judge_model: str,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict[str, Any]:
    sp, jp = _price(prices, student_model), _price(prices, judge_model)
    rows = [estimate_scenario(scenarios[p.scenario_id], student_price=sp, judge_price=jp) for p in picks]
    coach = sum(r.coach_usd for r in rows)
    student = sum(r.student_usd for r in rows)
    judge = sum(r.judge_usd for r in rows)
    seconds = sum(r.seconds for r in rows)
    return {
        "scenario_runs": len(picks),
        "student_turns": sum(r.student_turns for r in rows),
        "usd": {
            "coach_app": round(coach, 2),
            "student_simulator": round(student, 2),
            "judge": round(judge, 2),
            "total": round(coach + student + judge, 2),
        },
        "models": {"student": student_model, "judge": judge_model},
        "serial_hours": round(seconds / 3600, 2),
        "assumptions": {
            "coach_usd_per_turn": COACH_USD_PER_TURN,
            "coach_usd_per_session": COACH_USD_PER_SESSION,
            "student_tokens_out_per_turn": STUDENT_OUT_TOKENS,
            "student_retry_factor": STUDENT_RETRY_FACTOR,
            "judge_tokens_out": JUDGE_OUT_TOKENS,
            "coach_reply_tokens_chat_call": [COACH_CHAT_TOKENS, COACH_CALL_TOKENS],
            "concurrency": concurrency,
        },
    }


def shard(
    picks: Sequence[Pick],
    scenarios: Mapping[str, Scenario],
    *,
    prices: Mapping[str, Price],
    student_model: str,
    judge_model: str,
    budget_usd: float,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> list[dict[str, Any]]:
    """Greedy split in selection order: a shard closes when adding the next run would pass the target wall time at
    ``concurrency`` or the per-run budget cap. Each shard's budget is its share of ``budget_usd`` by estimated cost
    (rounded down to the cent, never above MAX_BUDGET_USD)."""
    sp, jp = _price(prices, student_model), _price(prices, judge_model)
    target = SHARD_TARGET_MINUTES * 60 * concurrency
    est = [estimate_scenario(scenarios[p.scenario_id], student_price=sp, judge_price=jp) for p in picks]
    total_usd = sum(e.usd for e in est) or 1.0
    shards: list[dict[str, Any]] = []
    current: list[int] = []
    seconds = usd = 0.0
    for i, e in enumerate(est):
        share = budget_usd * e.usd / total_usd
        if current and (seconds + e.seconds > target or usd + share > MAX_BUDGET_USD):
            shards.append({"runs": current, "seconds": seconds, "budget": usd})
            current, seconds, usd = [], 0.0, 0.0
        current.append(i)
        seconds += e.seconds
        usd += share
    if current:
        shards.append({"runs": current, "seconds": seconds, "budget": usd})
    if len(shards) > MAX_SHARDS:
        raise ValueError(f"the selection needs {len(shards)} shards (most {MAX_SHARDS}); narrow it")
    out = []
    for n, sh in enumerate(shards, start=1):
        out.append(
            {
                "index": n,
                "of": len(shards),
                "runs": [picks[i].run_id for i in sh["runs"]],
                "budget_usd": max(0.01, math.floor(min(sh["budget"], MAX_BUDGET_USD) * 100) / 100),
                "est_minutes": round(sh["seconds"] / concurrency / 60, 1),
                "est_usd": round(sum(est[i].usd for i in sh["runs"]), 2),
            }
        )
    return out


def parse_run_id(run_id: str) -> Pick:
    sid, _, rep = run_id.partition("#")
    return Pick(sid, int(rep) if rep else 1)
