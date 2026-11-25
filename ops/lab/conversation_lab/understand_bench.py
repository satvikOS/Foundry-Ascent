"""Suite ``understand``: the understand calls of a turn (docs/architecture/understand.md) on each model they may run on, before
production turns them on.

Every turn of the client and held-out scenarios with an expectation becomes a case: its message, the founder's lines before
it and the scenario's record. apps/api ``src/scripts/lab-understand.ts`` reads each with a turn's own prompt, schema, checks
and sums, on the candidates of ``ops/lab/models.json`` ``understand``; this module chooses the cases that fit the budget (the
same ones for every candidate), grades the readings against the scenarios' expectations without a judge, and keeps what is
public to numbers, candidate ids, group names and codes. The messages, the readings and each case's grades are private
(sealed or deleted, like every suite's content). A case is three calls (ROUTE, SUMS, JUDGE); it is graded with every part that
came and again with those a turn would have had at its caps.

Nothing here calls the app: what the reply makes of a reading is the client suite's to measure (``understand`` input).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
import subprocess
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from conversation_lab.client import reading
from conversation_lab.client.app import founder_intake
from conversation_lab.client.plan import in_groups
from conversation_lab.client.scenarios import GROUPS, HELD_OUT, Expect, FounderTurn, Scenario, load
from conversation_lab.client.turns import fact_named
from conversation_lab.config import REPO, LabModels, UnderstandCaps, foundation_model_id
from conversation_lab.understand_own import (
    OWN_GROUPS,
    OWN_MEASURES,
    OwnCase,
    load_own,
    own_case_json,
    own_grade,
)

SCRIPT = "src/scripts/lab-understand.ts"
#: The script's output under the folder given as ``--out`` (it writes ``<out>/private/understand-bench.json``).
REPORT_FILE = "understand-bench.json"
CASES_FILE = "understand-cases.json"
GRADES_FILE = "understand-grades.json"
#: How long the script may run (the role's session lasts an hour).
TIMEOUT_SECONDS = 40 * 60
CONCURRENCY = 3
#: Tokens a case is planned at (its three calls), in and out, and the share of the budget the plan may use (the rest is what
#: the script keeps in reserve for the calls in flight).
PLAN_TOKENS = (7_800, 400)
#: What a Nova model is billed for of those it reads: most of the prompt is a cached prefix, at a quarter of the rate.
NOVA_PLAN_TOKENS = 3_600
THINK_TOKENS = 1_500
PLAN_SHARE = 0.8
#: A code the summary may carry: an AWS error class name, the gateway's own, or a drop of the checks (``points:number``).
CODE = re.compile(r"[A-Za-z][A-Za-z0-9_.]{1,40}(?::[a-z_]{2,16})?")
#: What a case can be graded on, in the order the table prints it.
MEASURES = (
    "number",
    "number_said",
    "referral",
    "no_false_referral",
    "pick",
    "news",
    "history",
    "kind",
    "friends",
    "phrase_play",
)
#: The calls of a case, and what each is measured on.
PARTS: dict[str, tuple[str, ...]] = {
    "route": ("kind", "referral", "no_false_referral", "history", "phrase_play"),
    "sums": ("number", "number_said"),
    "judge": ("pick", "news", "friends"),
}
#: The groups that are never read unless they are named: what nobody has looked at.
UNSEEN = frozenset({"heldoutb", "heldoutc"})
#: Kinds of reading that agree with what a scenario expects of the turn.
KINDS: dict[str, frozenset[str]] = {
    "recall": frozenset({"recall"}),
    # A turn the reply only acknowledges: thanks, small talk, a promise, a grumble. None of them is an ask.
    "social": frozenset({"social", "update", "feelings", "pushback"}),
    "privacy": frozenset({"privacy"}),
    "report": frozenset({"update", "result"}),
}
#: The referrals a reply of the wrong kind would send to nobody: a case that expects none has none of these.
RULING = frozenset({"ip", "legal", "valuation", "equity", "immigration", "regulatory"})
#: Expected referrals that one reading of another name serves as well (the same person).
SERVES: dict[str, frozenset[str]] = {
    "regulatory": frozenset({"regulatory", "irb"}),
    "valuation": frozenset({"valuation", "equity"}),
    "equity": frozenset({"equity", "legal"}),
    "legal": frozenset({"legal", "equity"}),
}

Runner = Callable[..., subprocess.CompletedProcess[bytes]]


@dataclass(frozen=True)
class BenchCase:
    id: str
    scenario: Scenario
    turn: FounderTurn
    session: int
    at: int

    @property
    def expect(self) -> Expect:
        return self.turn.expect

    @property
    def held_out(self) -> bool:
        return self.scenario.group in HELD_OUT


def expects(e: Expect) -> tuple[str, ...]:
    """What a turn can be graded on (empty: nothing, so it is no case)."""
    found = []
    if e.number:
        found.append("number")
    if e.referral:
        found.append("referral")
    if e.pick:
        found.append("pick")
    if e.news:
        found.append("news")
    if e.history or e.remember:
        found.append("history")
    if e.kind in KINDS or e.other_venture:
        found.append("kind")
    if e.challenge_friends:
        found.append("friends")
    return tuple(found)


def cases_of(scenarios: Iterable[Scenario]) -> list[BenchCase]:
    out = []
    for s in scenarios:
        for n, plan in enumerate(s.sessions, start=1):
            for i, turn in enumerate(plan.turns, start=1):
                # A crisis is never read; a rehearsal is not either.
                if turn.expect.kind in ("crisis", "rehearsal") or not expects(turn.expect):
                    continue
                out.append(BenchCase(f"{s.id}:{n}.{i}", s, turn, n, i))
    return out


def chosen_cases(cases: Sequence[BenchCase], most: int) -> list[BenchCase]:
    """At most ``most`` cases, the rarest expectations first and the held-out ones before the others, in an order that is
    the same on every run (a hash of the case's id), so two runs of one budget compare the same cases."""
    if len(cases) <= most:
        return list(cases)
    counts = Counter(x for c in cases for x in expects(c.expect))

    def rank(c: BenchCase) -> tuple[int, int, str]:
        rarest = min(counts[x] for x in expects(c.expect))
        return (0 if c.held_out else 1, rarest, hashlib.sha256(c.id.encode()).hexdigest())

    by_measure: dict[str, list[BenchCase]] = defaultdict(list)
    for c in sorted(cases, key=rank):
        by_measure[min(expects(c.expect), key=lambda x: (counts[x], x))].append(c)
    queues = [by_measure[k] for k in sorted(by_measure, key=lambda k: (counts[k], k))]
    picked: list[BenchCase] = []
    while len(picked) < most and any(queues):
        for queue in queues:
            if queue and len(picked) < most:
                picked.append(queue.pop(0))
    kept = {c.id for c in picked}
    return [c for c in cases if c.id in kept]


def case_json(c: BenchCase, day: dt.date) -> dict[str, Any]:
    """The case as lab-understand.ts reads it: the scenario's record, what was told in earlier conversations (days ago) and
    the founder's lines of this one."""
    s = c.scenario
    gaps = [p.gap_days for p in s.sessions]
    said = []
    for n, plan in enumerate(s.sessions[: c.session - 1], start=1):
        days = sum(gaps[n : c.session])
        said += [{"text": t.say, "daysAgo": days} for t in plan.turns]
    plan = s.sessions[c.session - 1]
    aged = sum(gaps[1 : c.session])
    v = s.venture
    return {
        "id": c.id,
        "day": day.isoformat(),
        "channel": "voice" if plan.channel == "call" else "text",
        "venture": {k: v[k] for k in ("name", "oneLiner", "stage", "domain", "goal")},
        "founder": s.founder,
        "record": [
            {"type": r.type, "title": r.title, "content": r.content, "daysAgo": r.days_ago + aged}
            for r in s.record
        ],
        "said": said,
        "intake": founder_intake(s),
        "history": [t.say for t in plan.turns[: c.at - 1]],
        "message": c.turn.say,
    }


def arms(lab: LabModels, model: str) -> list[str]:
    """The script's arms, in its order: a model at each of its efforts, or the model alone."""
    out = []
    for name, efforts in lab.understand:
        if model and name != model:
            continue
        out += [f"{name}@{e}" for e in efforts] if efforts else [name]
    return out


def call_usd(lab: LabModels, arm: str) -> float:
    name, _, effort = arm.partition("@")
    price = lab.prices[foundation_model_id(name)]
    out = PLAN_TOKENS[1] + (THINK_TOKENS if effort == "low" else 0)
    read = NOVA_PLAN_TOKENS if "nova-2-lite" in name else PLAN_TOKENS[0]
    # A ``us.`` profile is billed 10% above the global rate.
    return (read * price.input + out * price.output) * 1.1 / 1_000_000


def affordable(lab: LabModels, names: Sequence[str], budget_usd: float) -> int:
    each = sum(call_usd(lab, n) for n in names)
    return max(1, int(budget_usd * PLAN_SHARE / each)) if each else 1


# Grading -----------------------------------------------------------------------------------------------------


def _said(u: Mapping[str, Any]) -> str:
    choice, result = u.get("choice") or {}, u.get("result") or {}
    contradicts = u.get("contradicts") or {}
    parts = [
        *(u.get("points") or []),
        *(str(s.get("said", "")) for s in u.get("sums") or []),
        choice.get("because"),
        result.get("shows"),
        result.get("doesNotShow"),
        contradicts.get("why"),
        u.get("firstAction"),
    ]
    return "\n".join(p for p in parts if isinstance(p, str))


def _records(u: Mapping[str, Any]) -> str:
    lines = [r.get("text") for r in u.get("record") or [] if isinstance(r, Mapping)]
    return "\n".join(x for x in lines if isinstance(x, str))


def _is(value: float, wanted: str) -> bool:
    return abs(value - float(wanted.replace(",", ""))) < 0.006


def _picks(pick: str, options: Sequence[str]) -> bool:
    low = reading.plain(pick).lower()
    if re.search(r"\b(?:both|neither|in this order)\b", low):
        return True
    for option in options:
        # "walk*" is any word that begins so, in an expectation as in the client graders.
        word = option.lower().strip()
        stem = re.escape(word.rstrip("*"))
        if re.search(rf"(?<!\w){stem}" + (r"\b" if len(stem) < 4 and not word.endswith("*") else ""), low):
            return True
    return False


def shown_facts(c: BenchCase) -> tuple[str, ...]:
    """The facts a turn is to name that stand in the record the calls are shown: a reading points at record lines, so what
    was only said in this conversation is the reply's to carry, not a line to name."""
    lines = [r.content for r in c.scenario.record]
    lines += [t.say for plan in c.scenario.sessions[: c.session - 1] for t in plan.turns]
    told = "\n".join(lines)
    return tuple(
        f
        for f in (c.expect.history or c.expect.remember)
        if f in c.scenario.facts and fact_named(told, c.scenario.facts[f])
    )


def grade(c: BenchCase, u: Mapping[str, Any] | None, phrase_play: str | None) -> dict[str, bool]:
    """What a reading of the case got right, by measure; a measure that does not apply is absent. No reading gets nothing
    right, and is no false referral."""
    e = c.expect
    u = u or {}
    out: dict[str, bool] = {}
    sums = [s for s in u.get("sums") or [] if isinstance(s.get("value"), int | float)]
    if e.number:
        out["number"] = any(_is(float(s["value"]), n) for s in sums for n in e.number)
        said = reading.values(_said(u))
        out["number_said"] = out["number"] or any(_is(v, n) for v in said for n in e.number)
    referral = u.get("referral")
    if e.referral:
        out["referral"] = any(referral in SERVES.get(r, frozenset({r})) for r in e.referral)
    elif "referral" not in c.turn.judge:
        # A reply the judge reads for who decides may name one: a reading that does is not false.
        out["no_false_referral"] = referral not in RULING
    if e.pick:
        choice = u.get("choice")
        out["pick"] = isinstance(choice, Mapping) and _picks(str(choice.get("pick", "")), e.pick)
    if e.news:
        result = u.get("result")
        # The verdict is said as a word of the reply ("It is weak so far").
        verdict = str(result.get("verdict") or "").replace("_", " ") if isinstance(result, Mapping) else ""
        named = f"{_said(u)}\n{_records(u)}\n{verdict}"
        out["news"] = isinstance(result, Mapping) and any(
            fact_named(named, c.scenario.facts[f]) for f in e.news
        )
    wanted = shown_facts(c)
    if wanted:
        told = f"{_records(u)}\n{_said(u)}"
        out["history"] = any(fact_named(told, c.scenario.facts[f]) for f in wanted)
    kinds = {u.get("kind"), *(u.get("also") or [])}
    if e.other_venture:
        out["kind"] = "privacy" in kinds
    elif e.kind in KINDS:
        out["kind"] = bool(KINDS[e.kind] & kinds)
    elif e.number or e.pick or e.news:
        out["kind"] = all(
            (
                not e.number or "sum" in kinds,
                not e.pick or "choice" in kinds,
                not e.news or bool({"result", "update"} & kinds),
            )
        )
    if e.challenge_friends:
        result = u.get("result")
        verdict = result.get("verdict") if isinstance(result, Mapping) else None
        out["friends"] = verdict not in ("strong", "promising") and (
            verdict is not None or u.get("contradicts") is not None or bool(u.get("points"))
        )
    # The playbook's own phrase is the surest thing known about which play a message asks for.
    if phrase_play is not None and not (e.kind in KINDS or e.other_venture):
        out["phrase_play"] = u.get("playId") == phrase_play
    return out


def _percentile(values: Sequence[float], share: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered), max(1, math.ceil(share * len(ordered) / 100))) - 1])


def _codes(values: Iterable[Any]) -> dict[str, int]:
    counts = Counter(v if isinstance(v, str) and CODE.fullmatch(v) else "other" for v in values)
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:12])


def _contradicted(u: Any) -> str | None:
    """The key of the record line a reading says the message denies."""
    found = u.get("contradicts") if isinstance(u, Mapping) else None
    line = found.get("line") if isinstance(found, Mapping) else None
    return str(line.get("key")) if isinstance(line, Mapping) else None


def _measures(
    rows: Sequence[Mapping[str, Any]], by_id: Mapping[str, BenchCase], field: str
) -> dict[str, dict[str, int]]:
    graded: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        for name, ok in grade(by_id[r["caseId"]], r.get(field), r.get("phrasePlay")).items():
            graded[name].append(ok)
    return {m: {"n": len(graded[m]), "right": sum(graded[m])} for m in MEASURES if graded[m]}


def _mean(values: Sequence[float]) -> int | None:
    return round(sum(values) / len(values)) if values else None


def part_result(rows: Sequence[Mapping[str, Any]], part: str) -> dict[str, Any]:
    """One call's numbers over an arm's rows: how long, how often after the cap, what it read and wrote."""
    all_calls = [r["parts"][part] for r in rows if isinstance((r.get("parts") or {}).get(part), Mapping)]
    calls = [c for c in all_calls if c.get("code") != "skipped"]
    ms = [float(c["ms"]) for c in calls]
    return {
        "calls": len(calls),
        "skipped": len(all_calls) - len(calls),
        "again": sum(1 for c in calls if c.get("again")),
        "ok": sum(1 for c in calls if c.get("code") == "ok"),
        "failures": _codes(c.get("code") for c in calls if c.get("code") != "ok"),
        "ms": {"p50": _percentile(ms, 50), "p95": _percentile(ms, 95)},
        "late": sum(1 for c in calls if c.get("late") is True),
        "tokens": {
            "input": _mean([float(c["inputTokens"]) for c in calls]),
            "cached": _mean([float(c["cachedInputTokens"]) for c in calls]),
            "output": _mean([float(c["outputTokens"]) for c in calls]),
        },
        "cost_usd": round(sum(float(c["costUsd"]) for c in calls), 6),
    }


def arm_result(rows: Sequence[Mapping[str, Any]], by_id: Mapping[str, BenchCase]) -> dict[str, Any]:
    """One candidate's numbers over its rows: every case counts, a failed call as one that got nothing right."""
    ok = [r for r in rows if r.get("code") == "ok"]
    reports = [r["report"] for r in rows if isinstance(r.get("report"), Mapping)]
    inputs = [r["inputs"] for r in reports if isinstance(r.get("inputs"), Mapping)]
    named = sum(int(i.get("named", 0)) for i in inputs)
    calls = [r for r in rows if r.get("code") != "budget"]
    ms = [float(r["ms"]) for r in calls]
    return {
        "cases": len(rows),
        "ok": len(ok),
        "failures": _codes(r.get("code") for r in rows if r.get("code") != "ok"),
        "measures": _measures(rows, by_id, "understanding"),
        # The same with the parts a turn would have had at its caps, and how many turns had any.
        "in_time": {
            "read": sum(1 for r in rows if r.get("inTime") is not None),
            "measures": _measures(rows, by_id, "inTime"),
        },
        "parts": {part: part_result(rows, part) for part in PARTS},
        "inputs": {
            "named": named,
            "found": sum(int(i.get("found", 0)) for i in inputs),
            "anywhere": sum(int(i.get("anywhere", 0)) for i in inputs),
        },
        "sum_drops": _codes(d for r in reports for d in r.get("sumDrops") or []),
        "text_drops": _codes(d for r in reports for d in r.get("textDrops") or []),
        "sure": sum(1 for r in ok if (r.get("understanding") or {}).get("sure") is True),
        "play": sum(1 for r in ok if (r.get("understanding") or {}).get("playId")),
        "contradicts": sum(1 for r in ok if (r.get("understanding") or {}).get("contradicts")),
        "ms": {"p50": _percentile(ms, 50), "p95": _percentile(ms, 95)},
        "late": sum(1 for r in calls if r.get("late") is True),
        "tokens": {
            "input": round(sum(r["inputTokens"] for r in calls) / len(calls)) if calls else None,
            "cached": round(sum(r["cachedInputTokens"] for r in calls) / len(calls)) if calls else None,
            "output": round(sum(r["outputTokens"] for r in calls) / len(calls)) if calls else None,
        },
        "cost_usd": round(sum(r["costUsd"] for r in rows), 6),
        "usd_per_1000": round(1_000 * sum(r["costUsd"] for r in calls) / len(calls), 4) if calls else None,
    }


def _caps(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, Mapping):
        return None
    found = {k: raw.get(k) for k in ("text", "voice")}
    return {k: int(v) for k, v in found.items() if isinstance(v, int | float) and not isinstance(v, bool)}


def public_result(
    report: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    cases: Sequence[BenchCase],
    *,
    exit_code: int,
    available: int,
    known: Sequence[str],
) -> dict[str, Any]:
    by_id = {c.id: c for c in cases}
    kept = [r for r in rows if r.get("caseId") in by_id and r.get("arm") in known]
    read = {r["caseId"] for r in kept}
    sets = {
        "all": [c for c in cases if c.id in read],
        "client": [c for c in cases if c.id in read and not c.held_out],
        "heldout": [c for c in cases if c.id in read and c.held_out],
    }
    out: dict[str, Any] = {
        "script_exit": exit_code,
        "report": True,
        "budget_reached": report.get("budgetReached") is True,
        "caps": _caps(report.get("caps")),
        "cases_available": available,
        "cases_planned": len(cases),
        "cases_read": len(read),
        "expectations": dict(Counter(x for c in sets["all"] for x in expects(c.expect))),
        "groups": {g: n for g in GROUPS if (n := sum(1 for c in sets["all"] if c.scenario.group == g))},
        "arms": [],
        "cost_usd": {"total": round(sum(r["costUsd"] for r in kept), 6)},
    }
    for arm in known:
        mine = [r for r in kept if r["arm"] == arm]
        if not mine:
            continue
        ids = {name: {c.id for c in found} for name, found in sets.items()}
        out["arms"].append(
            {
                "arm": arm,
                **{
                    name: arm_result([r for r in mine if r["caseId"] in wanted], by_id)
                    for name, wanted in ids.items()
                    if wanted
                },
            }
        )
    return out


# Running -----------------------------------------------------------------------------------------------------


def own_result(rows: Sequence[Mapping[str, Any]], own: Mapping[str, OwnCase]) -> dict[str, Any]:
    """One candidate's numbers over the suite's own cases, all of them and by shape of sum."""

    def counted(field: str) -> dict[str, dict[str, int]]:
        graded: dict[str, list[bool]] = defaultdict(list)
        for r in rows:
            for name, ok in own_grade(own[r["caseId"]], r.get(field)).items():
                graded[name].append(ok)
        return {m: {"n": len(graded[m]), "right": sum(graded[m])} for m in OWN_MEASURES if graded[m]}

    tags: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        case = own[r["caseId"]]
        tags[case.tag].append(all(own_grade(case, r.get("understanding")).values()))
    return {
        "cases": len(rows),
        "measures": counted("understanding"),
        "in_time": counted("inTime"),
        "tags": {t: {"n": len(v), "right": sum(v)} for t, v in sorted(tags.items())},
    }


def understand_command(
    *, pnpm: str, budget_usd: float, cases: Path, out: Path, model: str, caps: UnderstandCaps | None = None
) -> list[str]:
    return [
        pnpm,
        "--filter",
        "@foundry/api",
        "exec",
        "tsx",
        SCRIPT,
        # pnpm runs the script in apps/api: the paths must be absolute.
        "--cases",
        str(cases.resolve()),
        "--out",
        str(out.resolve()),
        "--budget-usd",
        f"{budget_usd:.2f}",
        "--concurrency",
        str(CONCURRENCY),
        *(["--typed-ms", str(caps.typed_ms), "--voice-ms", str(caps.voice_ms)] if caps else []),
        *(["--candidates", model] if model else []),
    ]


def run_understand(
    out: Path,
    *,
    env: Mapping[str, str],
    budget_usd: float,
    pnpm: str,
    lab: LabModels,
    groups: Sequence[str] = (),
    model: str = "",
    scenario_ids: Sequence[str] = (),
    caps: UnderstandCaps | None = None,
    today: dt.date | None = None,
    runner: Runner = subprocess.run,
) -> tuple[dict[str, Any], int]:
    """Chooses the cases, runs the script and grades what it read: the public result and the script's exit code."""
    day = today or dt.datetime.now(dt.UTC).date()
    every = load(day).scenarios
    # Every client group and the held-out one; the unseen ones only where they are named, by group or by scenario.
    scenarios = [s for s in every if (s.id in set(scenario_ids) if scenario_ids else True)]
    client = tuple(g for g in groups if g not in OWN_GROUPS)
    scenarios = [] if groups and not client else in_groups(scenarios, client, named=True)
    if not groups and not scenario_ids:
        scenarios = [s for s in scenarios if s.group not in UNSEEN]
    available = cases_of(scenarios)
    names = arms(lab, model)
    own = own_cases(groups, scenario_ids)
    cases = chosen_cases(available, max(0, affordable(lab, names, budget_usd) - len(own)))
    private = out / "private"
    logs = private / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    path = private / CASES_FILE
    told = [*(own_case_json(c, day) for c in own), *(case_json(c, day) for c in cases)]
    path.write_text(json.dumps({"version": 1, "cases": told}), encoding="utf-8")
    if not told:
        return {"script_exit": 0, "report": False, "cases_available": 0}, 2
    cmd = understand_command(pnpm=pnpm, budget_usd=budget_usd, cases=path, out=out, model=model, caps=caps)
    try:
        done = runner(cmd, cwd=REPO, env=dict(env), capture_output=True, timeout=TIMEOUT_SECONDS, check=False)
        (logs / "understand-bench.log").write_bytes((done.stdout or b"") + (done.stderr or b""))
        code = done.returncode
    except subprocess.TimeoutExpired:
        code = 124
    raw = private / REPORT_FILE
    if not raw.is_file():
        return {"script_exit": code, "report": False, "cases_available": len(available)}, code
    doc = json.loads(raw.read_text(encoding="utf-8"))
    rows = [r for r in doc.get("rows") or [] if isinstance(r, dict)]
    by_id = {c.id: c for c in cases}
    # The held-back half is counted and kept nowhere.
    held = {c.case_id for c in own if c.held}
    path.write_text(
        json.dumps({"version": 1, "cases": [c for c in told if c["id"] not in held]}), encoding="utf-8"
    )
    raw.write_text(
        json.dumps({**doc, "rows": [r for r in rows if r.get("caseId") not in held]}), encoding="utf-8"
    )
    open_own = {c.case_id: c for c in own if not c.held}
    (private / GRADES_FILE).write_text(
        json.dumps(
            [
                {
                    "arm": r.get("arm"),
                    "case": r["caseId"],
                    "code": r.get("code"),
                    "grades": grade(by_id[r["caseId"]], r.get("understanding"), r.get("phrasePlay")),
                    # Read by eye: each is to be true, and few are.
                    "contradicts": _contradicted(r.get("understanding")),
                }
                for r in rows
                if r.get("caseId") in by_id
            ]
            + [
                {
                    "arm": r.get("arm"),
                    "case": r["caseId"],
                    "code": r.get("code"),
                    "grades": own_grade(open_own[r["caseId"]], r.get("understanding")),
                }
                for r in rows
                if r.get("caseId") in open_own
            ],
            indent=1,
        ),
        encoding="utf-8",
    )
    result = public_result(
        doc.get("report") or {}, rows, cases, exit_code=code, available=len(available), known=names
    )
    result["own"] = own_arms(rows, own, names)
    return result, code


def own_cases(groups: Sequence[str], scenario_ids: Sequence[str]) -> list[OwnCase]:
    """The suite's own cases a run reads: both halves, or those that are named by group or id."""
    every = load_own()
    if scenario_ids:
        return [c for c in every if c.id in set(scenario_ids)]
    return [c for c in every if not groups or c.group in groups]


def own_arms(
    rows: Sequence[Mapping[str, Any]], own: Sequence[OwnCase], names: Sequence[str]
) -> list[dict[str, Any]]:
    by_id = {c.case_id: c for c in own}
    out = []
    for arm in names:
        mine = [r for r in rows if r.get("arm") == arm and r.get("caseId") in by_id]
        halves = {
            "open": [r for r in mine if not by_id[r["caseId"]].held],
            "held": [r for r in mine if by_id[r["caseId"]].held],
        }
        if mine:
            out.append({"arm": arm, **{k: own_result(found, by_id) for k, found in halves.items() if found}})
    return out


# Report ------------------------------------------------------------------------------------------------------


def _rate(cell: Mapping[str, Any] | None) -> str:
    return "-" if not cell else f"{cell['right']}/{cell['n']}"


def tables(result: Mapping[str, Any]) -> list[str]:
    """The public tables: numbers, candidate ids and codes."""
    if not result.get("report"):
        return [f"The script wrote no report (exit {result.get('script_exit')}).", ""]
    out = [
        f"Cases: {result['cases_read']} read of {result['cases_planned']} planned and {result['cases_available']} there "
        f"are (each on every candidate; groups {', '.join(f'{g} {n}' for g, n in result['groups'].items())}; "
        f"expectations {', '.join(f'{k} {n}' for k, n in result['expectations'].items())}).",
        "",
    ]
    for name, title in (("all", "All cases"), ("heldout", "Held-out cases"), ("client", "Client cases")):
        found = [a for a in result["arms"] if name in a]
        if not found:
            continue
        out += [
            f"**{title}**",
            "",
            "| Candidate | read | number | said | referral | no false referral | pick | news | history | kind | "
            "friends | play by phrase | inputs found (anywhere) | p50 / p95 ms | late | USD per 1,000 |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for a in found:
            r = a[name]
            m = r["measures"]
            i = r["inputs"]
            cells = [_rate(m.get(k)) for k in MEASURES]
            out.append(
                f"| {a['arm']} | {r['ok']}/{r['cases']} | {' | '.join(cells)} | "
                f"{i['found']}/{i['named']} ({i['anywhere']}) | {r['ms']['p50']} / {r['ms']['p95']} | "
                f"{r['late']} | {r['usd_per_1000']} |"
            )
        out.append("")
    caps = result.get("caps") or {}
    if caps:
        out += [
            f"At the caps ({caps.get('text')} ms typed, {caps.get('voice')} ms on a call): what a turn would have had in time.",
            "",
        ]
    out += [
        "| Candidate | turns with a reading | number | referral | no false referral | pick | news | history | kind | "
        "friends |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a in result["arms"]:
        r = a["all"]
        m = r["in_time"]["measures"]
        cells = [_rate(m.get(k)) for k in MEASURES if k not in ("number_said", "phrase_play")]
        out.append(f"| {a['arm']} | {r['in_time']['read']}/{r['cases']} | {' | '.join(cells)} |")
    out += [
        "",
        "| Candidate | part | calls (skipped, asked again) | p50 / p95 ms | after the cap | tokens in (cached) / out | accuracy | "
        "failed calls | USD |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a in result["arms"]:
        r = a["all"]
        for part, mine in PARTS.items():
            p = r["parts"][part]
            t = p["tokens"]
            right = ", ".join(
                f"{k} {_rate(r['measures'].get(k))}" for k in mine if r["measures"].get(k) is not None
            )
            out.append(
                f"| {a['arm']} | {part} | {p['calls']} ({p['skipped']}, {p['again']}) | {p['ms']['p50']} / {p['ms']['p95']} | "
                f"{p['late']} | {t['input']} ({t['cached']}) / {t['output']} | {right or '-'} | "
                f"{_said_codes(p['failures'])} | {p['cost_usd']} |"
            )
    out += [
        "",
        "| Candidate | sure | play named | contradictions | sums left out | texts left out | failed readings | "
        "tokens in (cached) / out |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a in result["arms"]:
        r = a["all"]
        t = r["tokens"]
        out.append(
            f"| {a['arm']} | {r['sure']} | {r['play']} | {r['contradicts']} | "
            f"{_said_codes(r['sum_drops'])} | {_said_codes(r['text_drops'])} | {_said_codes(r['failures'])} | "
            f"{t['input']} ({t['cached']}) / {t['output']} |"
        )
    out.append("")
    out += own_tables(result.get("own") or [])
    return out


def own_tables(own: Sequence[Mapping[str, Any]]) -> list[str]:
    """The suite's own cases, each half by measure and by shape."""
    out: list[str] = []
    for half, title in (("open", "Own cases, the open half"), ("held", "Own cases, the held-back half")):
        found = [a for a in own if half in a]
        if not found:
            continue
        out += [
            f"**{title}** ({found[0][half]['cases']} cases; in time at the caps after the slash)",
            "",
            "| Candidate | " + " | ".join(OWN_MEASURES) + " |",
            "| --- |" + " --- |" * len(OWN_MEASURES),
        ]
        for a in found:
            r = a[half]
            cells = [
                f"{_rate(r['measures'].get(m))}{' / ' + _rate(r['in_time'].get(m)) if r['measures'].get(m) else ''}"
                for m in OWN_MEASURES
            ]
            out.append(f"| {a['arm']} | {' | '.join(cells)} |")
        out += [
            "",
            *(
                f"{a['arm']}: " + ", ".join(f"{t} {_rate(n)}" for t, n in a[half]["tags"].items())
                for a in found
            ),
            "",
        ]
    return out


def _said_codes(codes: Mapping[str, int]) -> str:
    return ", ".join(f"{k} {n}" for k, n in codes.items()) or "-"
