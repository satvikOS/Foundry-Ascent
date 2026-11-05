"""The live suite's public summary: numbers, ids, codes and fixed labels only (the repository and its Actions logs are
public). Built from the runs' ``public()`` rows, so shards merge by concatenating rows and recomputing.

Reported separately, as the brief asks: the evidence label (live models, or infrastructure-only), per-family
results, severe outliers (never hidden by an average), p50/p95 coach-turn latency, the deterministic findings, the
judge's twelve dimensions and the naturalness/usefulness composites, the acceptance gates of section 19, and, when
a scenario ran more than once, run-to-run stability.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from typing import Any

from conversation_lab.live.dataset import DIMENSIONS, FAMILIES

GATE_NATURALNESS = 4.5
GATE_USEFULNESS = 4.5
GATE_BEHAVIOUR = 0.95


def percentile(values: Sequence[float], q: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, min(len(ordered), round(q * len(ordered) + 0.5)))
    return round(ordered[rank - 1], 2)


def _mean(values: Sequence[float]) -> float | None:
    vals = [v for v in values if isinstance(v, int | float)]
    return round(sum(vals) / len(vals), 3) if vals else None


def _is_outlier(row: Mapping[str, Any]) -> list[str]:
    codes: list[str] = []
    checks = row.get("checks") or {}
    codes += [f["code"] for f in checks.get("findings", []) if f.get("severity") in ("critical", "high")]
    judge = row.get("judge") or {}
    if judge.get("error"):
        codes.append("judge_error")
    if judge.get("presence_violation"):
        codes.append("presence_violation")
    if judge.get("fabrication"):
        codes.append("fabrication")
    codes += [f"severe:{c}" for c in judge.get("severe") or []]
    scores = judge.get("scores") or {}
    low = [k for k, v in scores.items() if isinstance(v, int) and v <= 2]
    codes += [f"low:{k}" for k in low]
    if row.get("status") in ("failed", "timeout", "error"):
        codes.append(f"status:{row['status']}")
    return sorted(set(codes))


def stability(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Run-to-run stability over scenarios judged more than once: pass agreement, and the spread of the
    naturalness and usefulness composites."""
    by: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for r in rows:
        if r.get("judge") and not (r["judge"] or {}).get("error"):
            by[r["scenario"]].append(r)
    repeated = {k: v for k, v in by.items() if len(v) >= 2}
    if not repeated:
        return None
    agree = sum(1 for v in repeated.values() if len({bool(r.get("passed")) for r in v}) == 1)
    spreads: dict[str, list[float]] = {"naturalness": [], "usefulness": [], "mean": []}
    for v in repeated.values():
        for key in spreads:
            vals = [r["judge"][key] for r in v if isinstance(r["judge"].get(key), int | float)]
            if len(vals) >= 2:
                spreads[key].append(max(vals) - min(vals))
    return {
        "scenarios_repeated": len(repeated),
        "pass_agreement": round(agree / len(repeated), 3),
        "max_spread": {k: (round(max(v), 3) if v else None) for k, v in spreads.items()},
        "mean_spread": {k: _mean(v) for k, v in spreads.items()},
    }


def aggregate(rows: Sequence[Mapping[str, Any]], meta: Mapping[str, Any]) -> dict[str, Any]:
    executed = [r for r in rows if r.get("status") in ("completed", "failed", "timeout", "error")]
    judged = [r for r in executed if r.get("judge") and not r["judge"].get("error")]
    passed = [r for r in executed if r.get("passed")]
    seconds = [s for r in executed for s in r.get("turn_seconds", [])]
    by_channel: dict[str, list[float]] = defaultdict(list)
    for r in executed:
        for s, ch in zip(r.get("turn_seconds", []), r.get("turn_channels", []), strict=False):
            by_channel[ch].append(s)
    findings: Counter[str] = Counter()
    for r in executed:
        for f in (r.get("checks") or {}).get("findings", []):
            findings[f["code"]] += 1
    replies = sum((r.get("checks") or {}).get("replies", 0) for r in executed)
    stacked = sum((r.get("checks") or {}).get("stacked_replies", 0) for r in executed)
    dims = {d: _mean([r["judge"]["scores"].get(d) for r in judged]) for d in DIMENSIONS}
    nat = _mean([r["judge"].get("naturalness") for r in judged])
    use = _mean([r["judge"].get("usefulness") for r in judged])
    families: dict[str, Any] = {}
    for f in sorted({r["family"] for r in rows}):
        fr = [r for r in rows if r["family"] == f]
        fe = [r for r in fr if r in executed]
        fj = [r for r in fe if r in judged]
        worst = min(fj, key=lambda r: r["judge"].get("mean") or 5, default=None)
        families[str(f)] = {
            "name": FAMILIES[f][1],
            "planned": len(fr),
            "executed": len(fe),
            "passed": sum(1 for r in fe if r.get("passed")),
            "pass_rate": round(sum(1 for r in fe if r.get("passed")) / len(fe), 3) if fe else None,
            "naturalness": _mean([r["judge"].get("naturalness") for r in fj]),
            "usefulness": _mean([r["judge"].get("usefulness") for r in fj]),
            "mean": _mean([r["judge"].get("mean") for r in fj]),
            "worst": None if worst is None else {"run": worst["run_id"], "mean": worst["judge"].get("mean")},
            "failures": dict(Counter(code for r in fe for code in r.get("failures", [])).most_common(5)),
        }
    outliers = [{"run": r["run_id"], "codes": c} for r in executed if (c := _is_outlier(r))]
    critical = sum(
        1
        for r in executed
        for f in (r.get("checks") or {}).get("findings", [])
        if f["severity"] == "critical"
    )
    fabrication = sum(1 for r in judged if r["judge"].get("fabrication"))
    behaviour = round(len(passed) / len(executed), 3) if executed else None
    groups: dict[str, dict[str, int]] = {}
    for g in ("multi_session", "long_running", "correction", "interruption", "voice"):
        gr = [r for r in executed if (r.get("groups") or {}).get(g)]
        groups[g] = {"executed": len(gr), "passed": sum(1 for r in gr if r.get("passed"))}
    return {
        **meta,
        "totals": {
            "planned": len(rows),
            "executed": len(executed),
            "completed": sum(1 for r in rows if r.get("status") == "completed"),
            "failed": sum(1 for r in rows if r.get("status") == "failed"),
            "timeouts": sum(1 for r in rows if r.get("status") == "timeout"),
            "errors": sum(1 for r in rows if r.get("status") == "error"),
            "skipped": dict(
                Counter(r.get("reason") for r in rows if r.get("status") in ("skipped", "not_run"))
            ),
            "judged": len(judged),
            "passed": len(passed),
            "pass_rate_executed": behaviour,
            "pass_rate_planned": round(len(passed) / len(rows), 3) if rows else None,
            "student_turns": sum(r.get("turns", 0) for r in executed),
            "turn_timeouts": sum(r.get("timeouts", 0) for r in executed),
            "student_fallbacks": sum(r.get("student_fallbacks", 0) for r in executed),
            "speech_units": sum(r.get("speech_units", 0) for r in executed),
        },
        "latency_seconds": {
            "all": {"p50": percentile(seconds, 0.5), "p95": percentile(seconds, 0.95), "n": len(seconds)},
            **{
                ch: {"p50": percentile(v, 0.5), "p95": percentile(v, 0.95), "n": len(v)}
                for ch, v in sorted(by_channel.items())
            },
        },
        "scores": {"dimensions": dims, "naturalness": nat, "usefulness": use},
        "checks": {
            "findings": dict(sorted(findings.items())),
            "stacked_reply_rate": round(stacked / replies, 3) if replies else None,
            "replies": replies,
        },
        "groups": groups,
        "families": families,
        "severe_outliers": outliers,
        "gates": {
            "naturalness_ge_4_5": {"value": nat, "met": nat is not None and nat >= GATE_NATURALNESS},
            "usefulness_ge_4_5": {"value": use, "met": use is not None and use >= GATE_USEFULNESS},
            "behaviour_ge_95pct": {
                "value": behaviour,
                "met": behaviour is not None and behaviour >= GATE_BEHAVIOUR,
            },
            "no_critical_isolation": {"value": critical, "met": critical == 0},
            "no_fabrication": {"value": fabrication, "met": fabrication == 0},
        },
        "stability": stability(rows),
        "runs": list(rows),
    }


def _fmt(v: Any, pct: bool = False) -> str:
    if v is None:
        return "-"
    if pct:
        return f"{v:.0%}"
    return f"{v:.2f}" if isinstance(v, float) else str(v)


def render(summary: Mapping[str, Any]) -> str:
    t = summary["totals"]
    lat = summary["latency_seconds"]["all"]
    out = [
        f"## Live conversation evaluation ({summary.get('evidence', 'live')})",
        "",
        f"Run `{summary.get('run_id')}` {summary.get('started_at')} - {summary.get('finished_at')}; dataset "
        f"`{str(summary.get('dataset_sha256', ''))[:12]}`; code `{str(summary.get('code_sha', ''))[:12]}`.",
        f"Coach: {summary.get('models', {}).get('coach')}; student: {summary.get('models', {}).get('student')}; "
        f"judge: {summary.get('models', {}).get('judge')} (independent of the coach's family: "
        f"{summary.get('models', {}).get('judge_independent')}).",
        "",
        "| | |",
        "| --- | --- |",
        f"| Planned / executed / passed | {t['planned']} / {t['executed']} / {t['passed']} |",
        f"| Behavioural pass rate (executed; failures and timeouts included) | {_fmt(t['pass_rate_executed'], True)} |",
        f"| Pass rate over planned | {_fmt(t['pass_rate_planned'], True)} |",
        f"| Failed / timeouts / errors / skipped | {t['failed']} / {t['timeouts']} / {t['errors']} / {sum(t['skipped'].values())} |",
        f"| Naturalness / usefulness (1-5) | {_fmt(summary['scores']['naturalness'])} / {_fmt(summary['scores']['usefulness'])} |",
        f"| Coach turn latency | p50 {_fmt(lat['p50'])} s, p95 {_fmt(lat['p95'])} s (n={lat['n']}) |",
        f"| Stacked-question reply rate | {_fmt(summary['checks']['stacked_reply_rate'], True)} |",
        f"| Spend | USD {summary.get('spend', {}).get('total_usd', 0):.2f} |",
        "",
        "Gates (brief section 19): "
        + "; ".join(
            f"{k} {'met' if g['met'] else 'NOT met'} ({_fmt(g['value'])})"
            for k, g in summary["gates"].items()
        ),
        "",
        "| # | Family | Executed | Passed | Naturalness | Usefulness | Worst run |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for f, row in summary["families"].items():
        worst = row["worst"]
        out.append(
            f"| {f} | {row['name']} | {row['executed']}/{row['planned']} | {row['passed']} | {_fmt(row['naturalness'])} "
            f"| {_fmt(row['usefulness'])} | {worst['run'] + ' (' + _fmt(worst['mean']) + ')' if worst else '-'} |"
        )
    out += ["", f"Severe outliers ({len(summary['severe_outliers'])}):"]
    out += [f"- {o['run']}: {', '.join(o['codes'])}" for o in summary["severe_outliers"][:60]]
    out += [
        "",
        "Deterministic findings: "
        + (", ".join(f"{k} {v}" for k, v in summary["checks"]["findings"].items()) or "none"),
    ]
    if summary.get("stability"):
        st = summary["stability"]
        out.append(
            f"Stability over {st['scenarios_repeated']} repeated scenarios: pass agreement {_fmt(st['pass_agreement'], True)}, "
            f"max naturalness spread {_fmt(st['max_spread']['naturalness'])}."
        )
    out.append("")
    return "\n".join(out)


def merge(summaries: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Shards (or separate runs) into one summary: rows concatenated, aggregates recomputed, spend summed."""
    rows = [r for s in summaries for r in s.get("runs", [])]
    first = summaries[0] if summaries else {}
    meta = {
        k: first.get(k) for k in ("evidence", "dataset_sha256", "code_sha", "models", "versions", "selection")
    }
    meta["run_id"] = ",".join(str(s.get("run_id")) for s in summaries)
    meta["started_at"] = min((s.get("started_at") or "" for s in summaries), default="")
    meta["finished_at"] = max((s.get("finished_at") or "" for s in summaries), default="")
    meta["spend"] = {
        "total_usd": round(sum(float((s.get("spend") or {}).get("total_usd") or 0) for s in summaries), 6)
    }
    meta["shards"] = len(summaries)
    return aggregate(rows, meta)


def stdev(values: Sequence[float]) -> float | None:
    return round(statistics.pstdev(values), 3) if len(values) >= 2 else None
