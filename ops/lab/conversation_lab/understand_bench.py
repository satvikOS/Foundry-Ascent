"""Suite ``understand``: the understand call of a turn (docs/architecture/understand.md) on each model it may run on, before
production turns it on.

Every turn of the client and held-out scenarios with an expectation becomes a case: its message, the founder's lines before
it and the scenario's record. apps/api ``src/scripts/lab-understand.ts`` reads each with a turn's own prompt, schema, checks
and sums, on the candidates of ``ops/lab/models.json`` ``understand``; this module chooses the cases that fit the budget (the
same ones for every candidate), grades the readings against the scenarios' expectations without a judge, and keeps what is
public to numbers, candidate ids, group names and codes. The messages, the readings and each case's grades are private
(sealed or deleted, like every suite's content).

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
from conversation_lab.config import REPO, LabModels, foundation_model_id

SCRIPT = "src/scripts/lab-understand.ts"
#: The script's output under the folder given as ``--out`` (it writes ``<out>/private/understand-bench.json``).
REPORT_FILE = "understand-bench.json"
CASES_FILE = "understand-cases.json"
GRADES_FILE = "understand-grades.json"
#: How long the script may run (the role's session lasts an hour).
TIMEOUT_SECONDS = 40 * 60
CONCURRENCY = 3
#: Tokens a call is planned at, in and out, and the share of the budget the plan may use (the rest is what the script keeps
#: in reserve for the calls in flight).
PLAN_TOKENS = (7_600, 420)
#: What a Nova model is billed for of those it reads: most of the prompt is a cached prefix, at a quarter of the rate.
NOVA_PLAN_TOKENS = 3_600
THINK_TOKENS = 700
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
#: Kinds of reading that agree with what a scenario expects of the turn.
KINDS: dict[str, frozenset[str]] = {
    "recall": frozenset({"recall"}),
    "social": frozenset({"social"}),
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
    words = [re.escape(o.lower().strip()) for o in options]
    return any(re.search(rf"\b{w}" + (r"\b" if len(w) < 4 else ""), low) for w in words)


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
    else:
        out["no_false_referral"] = referral not in RULING
    if e.pick:
        choice = u.get("choice")
        out["pick"] = isinstance(choice, Mapping) and _picks(str(choice.get("pick", "")), e.pick)
    if e.news:
        result = u.get("result")
        named = f"{_said(u)}\n{_records(u)}"
        out["news"] = isinstance(result, Mapping) and any(
            fact_named(named, c.scenario.facts[f]) for f in e.news
        )
    wanted = e.history or e.remember
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


def arm_result(rows: Sequence[Mapping[str, Any]], by_id: Mapping[str, BenchCase]) -> dict[str, Any]:
    """One candidate's numbers over its rows: every case counts, a failed call as one that got nothing right."""
    graded: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        case = by_id[r["caseId"]]
        for name, ok in grade(case, r.get("understanding"), r.get("phrasePlay")).items():
            graded[name].append(ok)
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
        "measures": {m: {"n": len(graded[m]), "right": sum(graded[m])} for m in MEASURES if graded[m]},
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


def number_anywhere(rows: Sequence[Mapping[str, Any]], by_id: Mapping[str, BenchCase]) -> dict[str, int]:
    """The sums right when an input may come from anywhere the founder gave it: what holding it to the place it names costs."""
    found = [
        grade(by_id[r["caseId"]], r.get("anywhere"), None)["number"]
        for r in rows
        if by_id[r["caseId"]].expect.number
    ]
    return {"n": len(found), "right": sum(found)}


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
                "number_anywhere": number_anywhere(mine, by_id),
            }
        )
    return out


# Running -----------------------------------------------------------------------------------------------------


def understand_command(*, pnpm: str, budget_usd: float, cases: Path, out: Path, model: str) -> list[str]:
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
    today: dt.date | None = None,
    runner: Runner = subprocess.run,
) -> tuple[dict[str, Any], int]:
    """Chooses the cases, runs the script and grades what it read: the public result and the script's exit code."""
    day = today or dt.datetime.now(dt.UTC).date()
    every = load(day).scenarios
    # Every client group and the held-out one: nothing here is played, so nothing is tuned by looking.
    scenarios = [s for s in every if not scenario_ids or s.id in set(scenario_ids)]
    scenarios = in_groups(scenarios, groups, named=True)
    available = cases_of(scenarios)
    names = arms(lab, model)
    cases = chosen_cases(available, affordable(lab, names, budget_usd))
    private = out / "private"
    logs = private / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    path = private / CASES_FILE
    path.write_text(json.dumps({"version": 1, "cases": [case_json(c, day) for c in cases]}), encoding="utf-8")
    if not cases:
        return {"script_exit": 0, "report": False, "cases_available": 0}, 2
    cmd = understand_command(pnpm=pnpm, budget_usd=budget_usd, cases=path, out=out, model=model)
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
    (private / GRADES_FILE).write_text(
        json.dumps(
            [
                {
                    "arm": r.get("arm"),
                    "case": r["caseId"],
                    "code": r.get("code"),
                    "grades": grade(by_id[r["caseId"]], r.get("understanding"), r.get("phrasePlay")),
                }
                for r in rows
                if r.get("caseId") in by_id
            ],
            indent=1,
        ),
        encoding="utf-8",
    )
    return (
        public_result(
            doc.get("report") or {}, rows, cases, exit_code=code, available=len(available), known=names
        ),
        code,
    )


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
    out += [
        "| Candidate | sums right if an input may be anywhere | sure | play named | contradictions | sums left out | "
        "texts left out | failed calls | tokens in (cached) / out |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a in result["arms"]:
        r = a["all"]
        t = r["tokens"]

        def said(codes: Mapping[str, int]) -> str:
            return ", ".join(f"{k} {n}" for k, n in codes.items()) or "-"

        out.append(
            f"| {a['arm']} | {_rate(a['number_anywhere'])} | {r['sure']} | {r['play']} | {r['contradicts']} | "
            f"{said(r['sum_drops'])} | {said(r['text_drops'])} | {said(r['failures'])} | "
            f"{t['input']} ({t['cached']}) / {t['output']} |"
        )
    out.append("")
    return out
