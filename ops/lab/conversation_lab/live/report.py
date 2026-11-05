"""The live suite's public summary: numbers, ids, codes and fixed labels only (the repository and its Actions logs are
public). Built from the runs' ``public()`` rows, so shards merge by concatenating rows and recomputing.

Reported separately, as the brief asks: the evidence label (live models, or infrastructure-only), per-family
results, severe outliers (never hidden by an average), p50/p95 coach-turn latency (failed and timed-out turns
included at their elapsed time), the deterministic findings with each watch phrase's rate per 100 replies across the
whole run, the judge's twelve dimensions and the naturalness/usefulness composites, the acceptance gates of section
19, and, when a scenario ran more than once, run-to-run stability.

No survivorship: every gate is computed over the planned runs. A run that was skipped, stopped by a budget or the
deadline, ended by a simulator failure, or not judged is not a pass, and while any planned run lacks a verdict the
composite gates read "not met (incomplete)" with their coverage beside them.
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
#: A watch phrase (or stock opener) used in more than this many replies per 100, across the whole run, is a cluster.
PHRASE_RATE_THRESHOLD = 5.0
EXECUTED = ("completed", "failed", "timeout", "error")


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
    if row.get("status") in ("failed", "timeout", "error", "simulator_failed", "stopped"):
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


def _isolation_critical(row: Mapping[str, Any]) -> int:
    """Critical isolation findings in one run: the deterministic check's, plus the judge's quoted ``isolation_leak``
    (a confirmation that names nothing, such as "yes, but I can't say who", is only the judge's to see)."""
    checks = sum(1 for f in (row.get("checks") or {}).get("findings", []) if f.get("severity") == "critical")
    # Only the judge's quoted disclosure counts (judge.SEVERE_CODES): a looped referral or a privacy misstatement
    # coded loosely as a "leak" no longer counts as an isolation failure (live pilot 42099643194).
    judge = sum(1 for c in (row.get("judge") or {}).get("severe") or [] if c == "isolation_leak")
    return checks + judge


def _gate(value: float | int | None, ok: bool, *, n: int, planned: int, complete: bool) -> dict[str, Any]:
    return {
        "value": value,
        "met": bool(ok and complete),
        "incomplete": not complete,
        "n": n,
        "coverage": round(n / planned, 3) if planned else None,
    }


def aggregate(rows: Sequence[Mapping[str, Any]], meta: Mapping[str, Any]) -> dict[str, Any]:
    stamp = {
        "evidence": meta.get("evidence"),
        "judge_independent": (meta.get("models") or {}).get("judge_independent"),
    }
    rows = [{**{k: v for k, v in stamp.items() if k not in r}, **r} for r in rows]
    executed = [r for r in rows if r.get("status") in EXECUTED]
    judged = [r for r in executed if r.get("judge") and not r["judge"].get("error")]
    passed = [r for r in executed if r.get("passed")]
    planned = len(rows)
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
    phrase_counts: Counter[str] = Counter()
    for r in executed:
        phrase_counts.update((r.get("checks") or {}).get("phrases") or {})
        phrase_counts["(stock opener)"] += (r.get("checks") or {}).get("stock_openers", 0)
    phrase_rates = {k: round(100 * v / replies, 2) for k, v in sorted(phrase_counts.items()) if v and replies}
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
            "judged": len(fj),
            "passed": sum(1 for r in fe if r.get("passed")),
            "pass_rate": round(sum(1 for r in fe if r.get("passed")) / len(fr), 3) if fr else None,
            "pass_rate_executed": round(sum(1 for r in fe if r.get("passed")) / len(fe), 3) if fe else None,
            "failure_conditions": {
                "enacted": sum(1 for r in fr if (r.get("failure_conditions") or {}).get("enacted")),
                "described_only": sum(
                    1 for r in fr if (r.get("failure_conditions") or {}).get("described_only")
                ),
            },
            "naturalness": _mean([r["judge"].get("naturalness") for r in fj]),
            "usefulness": _mean([r["judge"].get("usefulness") for r in fj]),
            "mean": _mean([r["judge"].get("mean") for r in fj]),
            "worst": None if worst is None else {"run": worst["run_id"], "mean": worst["judge"].get("mean")},
            "failures": dict(Counter(code for r in fe for code in r.get("failures", [])).most_common(5)),
        }
    outliers = [
        {"run": r["run_id"], "codes": c}
        for r in rows
        if r.get("status") not in ("skipped", "not_run") and (c := _is_outlier(r))
    ]
    critical = sum(_isolation_critical(r) for r in rows)
    fabrication = sum(1 for r in judged if r["judge"].get("fabrication"))
    behaviour = round(len(passed) / planned, 3) if planned else None
    complete = planned > 0 and len(judged) == planned
    groups: dict[str, dict[str, int]] = {}
    for g in ("multi_session", "long_running", "correction", "interruption", "voice"):
        gr = [r for r in rows if (r.get("groups") or {}).get(g)]
        ge = [r for r in gr if r in executed]
        row: dict[str, int] = {
            "planned": len(gr),
            "executed": len(ge),
            "passed": sum(1 for r in ge if r.get("passed")),
        }
        if g in ("multi_session", "long_running"):
            # What actually ran: a student who left early or a run cut short can fall out of the group.
            row["as_executed"] = sum(1 for r in ge if (r.get("groups_executed") or {}).get(g))
        groups[g] = row
    return {
        **meta,
        "totals": {
            "planned": planned,
            "executed": len(executed),
            "completed": sum(1 for r in rows if r.get("status") == "completed"),
            "failed": sum(1 for r in rows if r.get("status") == "failed"),
            "timeouts": sum(1 for r in rows if r.get("status") == "timeout"),
            "errors": sum(1 for r in rows if r.get("status") == "error"),
            "simulator_failed": sum(1 for r in rows if r.get("status") == "simulator_failed"),
            "stopped": dict(Counter(r.get("reason") for r in rows if r.get("status") == "stopped")),
            "skipped": dict(
                Counter(r.get("reason") for r in rows if r.get("status") in ("skipped", "not_run"))
            ),
            "judged": len(judged),
            "passed": len(passed),
            "pass_rate_executed": round(len(passed) / len(executed), 3) if executed else None,
            "pass_rate_planned": behaviour,
            "student_turns": sum(r.get("turns", 0) for r in rows),
            "planned_student_turns": sum(r.get("planned_turns", 0) for r in rows),
            "turn_timeouts": sum(r.get("timeouts", 0) for r in rows),
            "speech_units": sum(r.get("speech_units", 0) for r in rows),
            "approved_proposals": sum(r.get("approved_proposals", 0) for r in rows),
            "failure_conditions_described_only": sum(
                1 for r in rows if (r.get("failure_conditions") or {}).get("described_only")
            ),
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
            "phrase_rate_per_100_replies": phrase_rates,
            "phrase_rate_threshold": PHRASE_RATE_THRESHOLD,
            "phrases_over_threshold": sorted(k for k, v in phrase_rates.items() if v > PHRASE_RATE_THRESHOLD),
        },
        "groups": groups,
        "families": families,
        "severe_outliers": outliers,
        "gates": {
            "naturalness_ge_4_5": _gate(
                nat,
                nat is not None and nat >= GATE_NATURALNESS,
                n=len(judged),
                planned=planned,
                complete=complete,
            ),
            "usefulness_ge_4_5": _gate(
                use,
                use is not None and use >= GATE_USEFULNESS,
                n=len(judged),
                planned=planned,
                complete=complete,
            ),
            # Over planned runs: a skipped, stopped or unjudged run is not a pass.
            "behaviour_ge_95pct": _gate(
                behaviour,
                behaviour is not None and behaviour >= GATE_BEHAVIOUR,
                n=len(executed),
                planned=planned,
                complete=complete,
            ),
            "no_critical_isolation": _gate(
                critical, critical == 0, n=len(executed), planned=planned, complete=complete
            ),
            "no_fabrication": _gate(
                fabrication, fabrication == 0, n=len(judged), planned=planned, complete=complete
            ),
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
    models = summary.get("models") or {}
    if "mixed" in models:
        model_line = (
            "Models differ across the merged runs (models.mixed in the JSON); judge independent of the coach's "
            f"family in every run: {models.get('judge_independent')}."
        )
    else:
        model_line = (
            f"Coach: {models.get('coach')}; student: {models.get('student')}; judge: {models.get('judge')} "
            f"(independent of the coach's family: {models.get('judge_independent')})."
        )
    out = [
        f"## Live conversation evaluation ({summary.get('evidence', 'live')})",
        "",
        f"Run `{summary.get('run_id')}` {summary.get('started_at')} - {summary.get('finished_at')}; dataset "
        f"`{str(summary.get('dataset_sha256', ''))[:12]}`; code `{str(summary.get('code_sha', ''))[:12]}`.",
        model_line,
        "",
        "| | |",
        "| --- | --- |",
        f"| Planned / executed / judged / passed | {t['planned']} / {t['executed']} / {t['judged']} / {t['passed']} |",
        f"| Behavioural pass rate over planned (the gate) | {_fmt(t['pass_rate_planned'], True)} |",
        f"| Pass rate over executed (failures and timeouts included) | {_fmt(t['pass_rate_executed'], True)} |",
        f"| Failed / timeouts / errors / simulator failed / stopped / skipped | {t['failed']} / {t['timeouts']} / "
        f"{t['errors']} / {t['simulator_failed']} / {sum(t['stopped'].values())} / {sum(t['skipped'].values())} |",
        f"| Student turns run / planned | {t['student_turns']} / {t['planned_student_turns']} |",
        f"| Memory proposals approved by the runner | {t['approved_proposals']} |",
        f"| Failure conditions described, not injected (runs) | {t['failure_conditions_described_only']} |",
        f"| Naturalness / usefulness (1-5) | {_fmt(summary['scores']['naturalness'])} / {_fmt(summary['scores']['usefulness'])} |",
        f"| Coach turn latency (errors and timeouts at elapsed time) | p50 {_fmt(lat['p50'])} s, p95 "
        f"{_fmt(lat['p95'])} s (n={lat['n']}, timeouts {t['turn_timeouts']}) |",
        f"| Stacked-question reply rate | {_fmt(summary['checks']['stacked_reply_rate'], True)} |",
        f"| Spend | USD {summary.get('spend', {}).get('total_usd', 0):.2f} |",
        "",
        "Gates (brief section 19): "
        + "; ".join(
            f"{k} {'met' if g['met'] else ('NOT met (incomplete)' if g.get('incomplete') else 'NOT met')} "
            f"({_fmt(g['value'])}; n={g.get('n')}, coverage {_fmt(g.get('coverage'), True)})"
            for k, g in summary["gates"].items()
        ),
        "",
        "| # | Family | Executed | Passed | Naturalness | Usefulness | Worst run |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for f, row in summary["families"].items():
        worst = row["worst"]
        out.append(
            f"| {f} | {row['name']}{' (failures described, not injected)' if row['failure_conditions']['described_only'] else ''} "
            f"| {row['executed']}/{row['planned']} | {row['passed']} | {_fmt(row['naturalness'])} "
            f"| {_fmt(row['usefulness'])} | {worst['run'] + ' (' + _fmt(worst['mean']) + ')' if worst else '-'} |"
        )
    out += ["", f"Severe outliers ({len(summary['severe_outliers'])}):"]
    out += [f"- {o['run']}: {', '.join(o['codes'])}" for o in summary["severe_outliers"][:60]]
    out += [
        "",
        "Deterministic findings: "
        + (", ".join(f"{k} {v}" for k, v in summary["checks"]["findings"].items()) or "none"),
        "Watch phrases per 100 replies (cluster above "
        + _fmt(summary["checks"]["phrase_rate_threshold"])
        + "): "
        + (
            ", ".join(f"{k} {v}" for k, v in summary["checks"]["phrase_rate_per_100_replies"].items())
            or "none"
        ),
    ]
    if summary.get("stability"):
        st = summary["stability"]
        out.append(
            f"Stability over {st['scenarios_repeated']} repeated scenarios: pass agreement {_fmt(st['pass_agreement'], True)}, "
            f"max naturalness spread {_fmt(st['max_spread']['naturalness'])}."
        )
    out.append("")
    return "\n".join(out)


class MergeError(ValueError):
    """Summaries that cannot honestly be one summary (different evidence labels)."""


def _distinct(values: Sequence[Any]) -> Any:
    out: list[Any] = []
    for v in values:
        if v not in out:
            out.append(v)
    return out[0] if len(out) == 1 else ({"mixed": out} if out else None)


def merge(summaries: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Shards (or separate runs) into one summary: rows concatenated, aggregates recomputed, spend summed. Every
    row keeps its own evidence label and judge independence; summaries with different evidence labels are refused,
    and any other metadata that differs (models after a fallback, code or dataset versions) is kept as
    ``{"mixed": [...]}``, never as the first shard's value."""
    for s in summaries:
        for r in s.get("runs", []):
            r.setdefault("evidence", s.get("evidence"))
            r.setdefault("judge_independent", (s.get("models") or {}).get("judge_independent"))
    rows = [r for s in summaries for r in s.get("runs", [])]
    evidence = {r.get("evidence") for r in rows} | {s.get("evidence") for s in summaries}
    if len(evidence) > 1:
        raise MergeError(f"different evidence labels cannot be merged: {sorted(map(str, evidence))}")
    meta = {
        k: _distinct([s.get(k) for s in summaries])
        for k in ("evidence", "dataset_sha256", "code_sha", "models", "versions", "selection")
    }
    models = meta.get("models")
    if isinstance(models, dict) and "mixed" in models:
        meta["models"] = {
            "mixed": models["mixed"],
            "judge_independent": all(r.get("judge_independent") is True for r in rows),
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
