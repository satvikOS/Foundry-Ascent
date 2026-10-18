"""Matrix reports: per-dimension pass rates, the weighted humanness score and the worst scenarios by id.

Per dimension value, two rates: ``implied`` counts the checks that value itself implies on the turns where it
happens (``request.names_option`` for an either/or question; small talk's presence checks), so it says how well the
vEIR handles that move; ``overall`` counts every check of the scenarios that have the value, so it shows the
context effect (how everything else holds up while the founder is angry, or on a call).

Humanness: the families' pass rates (presence, attunement, request, continuity, topic, craft, relational, voice)
weighted by ``taxonomy.yaml``; safety is gated, never averaged in. With a judge, blended with the judge's mean
criterion score on 0-1. Everything here is ids, codes and numbers.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from foundry_evals.matrix.checks import CheckOutcome, pass_rates
from foundry_evals.matrix.judge import JUDGE_CRITERIA
from foundry_evals.matrix.taxonomy import DIMENSIONS, Taxonomy
from foundry_evals.results import CaseResult

WORST = 10


def rule_score(taxonomy: Taxonomy, outcomes: Iterable[CheckOutcome]) -> float | None:
    """Weighted mean of the families' pass rates (families without checks drop out)."""
    rates = pass_rates(outcomes, "family")
    weights = taxonomy.humanness.families
    total = sum(weights[f] for f, (_, n) in rates.items() if f in weights and n)
    if not total:
        return None
    return sum(weights[f] * (p / n) for f, (p, n) in rates.items() if f in weights and n) / total


def blend(taxonomy: Taxonomy, rules: float | None, judge_scaled: float | None) -> float | None:
    if rules is None:
        return judge_scaled
    if judge_scaled is None:
        return rules
    rw, jw = taxonomy.humanness.rule_weight, taxonomy.humanness.judge_weight
    return (rw * rules + jw * judge_scaled) / (rw + jw)


def _judge_scaled(judge: Mapping[str, Any] | None) -> float | None:
    if not judge or judge.get("mean") is None:
        return None
    return (float(judge["mean"]) - 1) / 4


def scenario_humanness(
    taxonomy: Taxonomy, outcomes: Sequence[CheckOutcome], judge: Mapping[str, Any] | None
) -> float | None:
    score = blend(taxonomy, rule_score(taxonomy, outcomes), _judge_scaled(judge))
    return None if score is None else round(score, 4)


def _outcomes(result: CaseResult) -> list[CheckOutcome]:
    return [CheckOutcome.from_dict(c) for c in (result.matrix or {}).get("checks", [])]


def _rate(passed: int, checked: int) -> float | None:
    return passed / checked if checked else None


def matrix_summary(taxonomy: Taxonomy, cases: Sequence[CaseResult]) -> dict[str, Any]:
    """The matrix section of results.json (and the source of the markdown tables)."""
    matrix = [c for c in cases if c.suite == "matrix"]
    executed = [c for c in matrix if c.status in ("passed", "failed") and c.matrix and c.matrix.get("checks")]
    all_outcomes = [o for c in executed for o in _outcomes(c)]
    judged = [c.matrix["judge"] for c in executed if c.matrix and c.matrix.get("judge")]
    criteria: dict[str, list[int]] = {k: [] for k in JUDGE_CRITERIA}
    for verdict in judged:
        for name, score in verdict.get("scores", {}).items():
            if score is not None and name in criteria:
                criteria[name].append(int(score))
    judge_means = {k: (sum(v) / len(v) if v else None) for k, v in criteria.items()}
    judge_overall = [verdict["mean"] for verdict in judged if verdict.get("mean") is not None]
    judge_mean = sum(judge_overall) / len(judge_overall) if judge_overall else None
    rules = rule_score(taxonomy, all_outcomes)
    humanness = blend(taxonomy, rules, None if judge_mean is None else (judge_mean - 1) / 4)

    families = {
        f: {"passed": p, "checked": n, "rate": _rate(p, n)}
        for f, (p, n) in sorted(pass_rates(all_outcomes).items())
    }
    checks = {
        k: {"passed": p, "checked": n, "rate": _rate(p, n), "family": taxonomy.checks[k].family}
        for k, (p, n) in sorted(pass_rates(all_outcomes, "check").items())
    }
    dimensions: dict[str, Any] = {}
    for dim in DIMENSIONS:
        rows: dict[str, Any] = {}
        for value in taxonomy.values_of(dim):
            tag = f"{dim}:{value}"
            with_value = [c for c in executed if c.matrix and c.matrix["values"].get(dim) == value]
            scenario_outcomes = [o for c in with_value for o in _outcomes(c)]
            implied = [o for o in scenario_outcomes if tag in o.sources]
            failing = Counter(o.check for o in (implied or scenario_outcomes) if not o.passed)
            scores = [
                c.matrix.get("humanness")
                for c in with_value
                if c.matrix and c.matrix.get("humanness") is not None
            ]
            ip, io = sum(o.passed for o in implied), len(implied)
            ap, ao = sum(o.passed for o in scenario_outcomes), len(scenario_outcomes)
            rows[value] = {
                "scenarios": len(with_value),
                "implied": {"passed": ip, "checked": io, "rate": _rate(ip, io)},
                "overall": {"passed": ap, "checked": ao, "rate": _rate(ap, ao)},
                "humanness": (sum(scores) / len(scores)) if scores else None,
                "topFailing": [k for k, _ in failing.most_common(3)],
            }
        dimensions[dim] = rows

    def badness(c: CaseResult) -> tuple[int, float]:
        outcomes = _outcomes(c)
        high = sum(1 for o in outcomes if not o.passed and o.severity == "high")
        score = (c.matrix or {}).get("humanness")
        return (-high, score if isinstance(score, float) else 1.0)

    worst = []
    for c in sorted(executed, key=badness)[:WORST]:
        failed = [o for o in _outcomes(c) if not o.passed]
        worst.append(
            {
                "id": c.case_id,
                "humanness": (c.matrix or {}).get("humanness"),
                "values": {
                    d: (c.matrix or {})["values"][d]
                    for d in ("question_type", "emotion", "trajectory", "continuity", "channel")
                },
                "failed": [
                    f"{o.check}@{o.turn if o.turn is not None else 's' + str(o.session)}" for o in failed
                ][:8],
                "highFailures": sum(1 for o in failed if o.severity == "high"),
            }
        )
    statuses = Counter(c.status for c in matrix)
    return {
        "scenarios": {
            "total": len(matrix),
            "executed": len(executed),
            "multiSession": sum(1 for c in executed if c.matrix and c.matrix.get("multiSession")),
            "byStatus": dict(statuses),
            "skippedReasons": dict(Counter(c.reason for c in matrix if c.status == "skipped" and c.reason)),
        },
        "humanness": humanness,
        "ruleScore": rules,
        "judge": {"scenarios": len(judged), "mean": judge_mean, "criteria": judge_means},
        "checks": {"passed": sum(o.passed for o in all_outcomes), "checked": len(all_outcomes)},
        "families": families,
        "byCheck": checks,
        "dimensions": dimensions,
        "worst": worst,
    }


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def render_matrix_markdown(
    taxonomy: Taxonomy, summary: Mapping[str, Any], extra: Mapping[str, Any] | None = None
) -> str:
    sc = summary["scenarios"]
    judge = summary["judge"]
    parts = [
        "## Conversation matrix",
        "",
        f"**Humanness {_pct(summary['humanness'])}** (rules {_pct(summary['ruleScore'])}"
        + (
            f" · judge {judge['mean']:.2f}/5 over {judge['scenarios']} scenarios"
            if judge["mean"] is not None
            else ""
        )
        + f") · scenarios executed {sc['executed']} of {sc['total']} ({sc['multiSession']} multi-session) · "
        f"checks passed {summary['checks']['passed']}/{summary['checks']['checked']}",
        "",
    ]
    if extra:
        parts += [" · ".join(f"{k} {v}" for k, v in extra.items()), ""]
    if sc["skippedReasons"]:
        parts += ["Skipped: " + ", ".join(f"{k} {v}" for k, v in sorted(sc["skippedReasons"].items())), ""]
    parts += [
        "### By family",
        "",
        _table(
            ["Family", "Weight", "Passed", "Checked", "Rate"],
            [
                [
                    f,
                    str(taxonomy.humanness.families.get(f, "gated")),
                    str(v["passed"]),
                    str(v["checked"]),
                    _pct(v["rate"]),
                ]
                for f, v in summary["families"].items()
            ],
        ),
        "",
        "### By dimension",
        "",
        "Implied: the checks the value itself implies where it happens. All: every check of the scenarios with it.",
        "",
    ]
    for dim, rows in summary["dimensions"].items():
        parts += [
            f"#### {taxonomy.dimensions[dim].title} (`{dim}`)",
            "",
            _table(
                ["Value", "Scenarios", "Implied", "Implied rate", "All rate", "Humanness", "Top failing"],
                [
                    [
                        f"`{value}`",
                        str(r["scenarios"]),
                        f"{r['implied']['passed']}/{r['implied']['checked']}",
                        _pct(r["implied"]["rate"]),
                        _pct(r["overall"]["rate"]),
                        _pct(r["humanness"]),
                        ", ".join(f"`{k}`" for k in r["topFailing"]) or "-",
                    ]
                    for value, r in rows.items()
                ],
            ),
            "",
        ]
    failing_checks = [
        (k, v) for k, v in summary["byCheck"].items() if v["checked"] and v["passed"] < v["checked"]
    ]
    if failing_checks:
        parts += [
            "### Checks that failed",
            "",
            _table(
                ["Check", "Family", "Severity", "Passed", "Checked", "Rate"],
                [
                    [
                        f"`{k}`",
                        v["family"],
                        taxonomy.checks[k].severity,
                        str(v["passed"]),
                        str(v["checked"]),
                        _pct(v["rate"]),
                    ]
                    for k, v in sorted(failing_checks, key=lambda kv: (kv[1]["rate"] or 0, kv[0]))
                ],
            ),
            "",
        ]
    if judge["mean"] is not None:
        parts += [
            "### Judge (1-5)",
            "",
            _table(
                ["Criterion", "Mean"],
                [[k, "n/a" if v is None else f"{v:.2f}"] for k, v in judge["criteria"].items()],
            ),
            "",
        ]
    if summary["worst"]:
        parts += [
            "### Worst scenarios",
            "",
            _table(
                ["Scenario", "Humanness", "Values", "High failures", "Failed checks (check@turn)"],
                [
                    [
                        w["id"],
                        _pct(w["humanness"]),
                        " · ".join(f"{v}" for v in w["values"].values()),
                        str(w["highFailures"]),
                        "<br>".join(f"`{x}`" for x in w["failed"]) or "-",
                    ]
                    for w in summary["worst"]
                ],
            ),
            "",
        ]
    return "\n".join(parts).rstrip() + "\n"
