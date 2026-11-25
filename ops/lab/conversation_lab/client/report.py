"""The client suite's outputs. Public: numbers, ids and codes only (this repository and its logs are public). Private
(sealed): transcripts, the filled Tool Test Log, and the comparison with the other tools' recorded scores."""

from __future__ import annotations

import csv
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from conversation_lab.client.graders import BLOCKING, GRADERS
from conversation_lab.client.rubric import (
    COLUMN_TITLES,
    CRITERIA,
    EXTRA,
    QUESTIONS,
    ToolSummary,
    meets_target,
    tool_summary,
    weighted,
)
from conversation_lab.client.runner import ScenarioResult, TurnResult
from conversation_lab.client.scenarios import STEP_KINDS

TOOL_NAME = "Foundry Ascent (ours)"
#: The release's targets (spec "Acceptance").
FIRST_TOKEN_P50_MS = 1200
TURN_P50_SECONDS = 3.5
TURN_COST_USD = 0.003
#: Graders of what only a real model can say: a mock run's figures for them are no evidence.
MODEL_SAYS = frozenset({"answers_the_number", "news_interpreted", "first_time_adapted"})
#: The first empty row and test number of the client's log.
LOG_START_ROW = 19
LOG_START_TEST = 15


def percentile(values: Sequence[float], q: float) -> float | None:
    """Nearest rank."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, min(len(ordered), int(-(-q * len(ordered) // 1))))
    return ordered[rank - 1]


def spread(values: Sequence[float], digits: int = 2) -> dict[str, float | int] | None:
    p50, p95 = percentile(values, 0.5), percentile(values, 0.95)
    if p50 is None or p95 is None:
        return None
    return {"p50": round(p50, digits), "p95": round(p95, digits), "n": len(values)}


def all_turns(results: Sequence[ScenarioResult]) -> list[TurnResult]:
    return [t for r in results for t in r.turns]


def grader_rates(results: Sequence[ScenarioResult]) -> dict[str, dict[str, int]]:
    """grader -> how many replies it applied to and how many passed (scenario-level graders included)."""
    out: dict[str, dict[str, int]] = {}
    for grades in [t.grades for t in all_turns(results)] + [r.grades for r in results]:
        for name, grade in grades.items():
            if grade.passed is None:
                continue
            row = out.setdefault(name, {"applied": 0, "passed": 0})
            row["applied"] += 1
            row["passed"] += int(grade.passed)
    order = [*GRADERS, "opener_names", "same_step"]
    return {k: out[k] for k in order if k in out}


def log_turns(results: Sequence[ScenarioResult]) -> list[tuple[ScenarioResult, TurnResult]]:
    """The rows of the client's log: every reply to one of its questions."""
    return [(r, t) for r in results for t in r.turns if t.plan.q is not None]


def scored_rows(results: Sequence[ScenarioResult], *, raw: bool = False) -> list[dict[str, int | None]]:
    return [
        (t.card.raw if raw else t.card.scores)
        for _, t in log_turns(results)
        if t.card is not None and t.card.error is None
    ]


def _gate(name: str, value: Any, passed: bool | None) -> dict[str, Any]:
    return {"gate": name, "value": value, "passed": passed}


def gates(
    results: Sequence[ScenarioResult],
    summary: ToolSummary,
    *,
    timed: bool = True,
    calibration: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """The release's acceptance, one line each. ``timed``: whether the run's latency and cost are evidence (a mock
    model's are not). ``calibration``: how the judge agreed with the hand-graded replies."""
    rates = grader_rates(results)
    turns = all_turns(results)
    typed = [t for t in turns if t.channel == "chat" and t.kind != "error"] if timed else []

    def rate(*names: str) -> tuple[str | None, bool | None]:
        applied = sum(rates[n]["applied"] for n in names if n in rates)
        passed = sum(rates[n]["passed"] for n in names if n in rates)
        return (f"{passed}/{applied}", passed == applied) if applied else (None, None)

    out = []
    planned = sum(r.scenario.turns for r in results)
    answered = sum(1 for t in turns if t.kind != "error")
    out.append(_gate("every planned turn answered", f"{answered}/{planned}", answered == planned))
    for label, names in (
        ("next step named on every coaching reply", ("next_step",)),
        ("done-when and by-when on every coaching reply", ("done_when", "by_when")),
        ("same step on every repeat", ("same_step",)),
        ("the path's step not repeated to other asks", ("no_nagging",)),
        ("no question-only reply", ("direct_answer",)),
        ("no deferral", ("no_deferral",)),
        ("no unsupported figure", ("grounded_figures",)),
        ("no unsupported name or date", ("grounded_names", "grounded_dates")),
        ("every citation known and supporting", ("known_citations", "supported_citations")),
        ("referral on every question that needs one", ("referral",)),
        ("no other venture's detail", ("no_other_venture",)),
        ("no flattery, friends challenged", ("no_flattery", "friends_challenged")),
        ("required facts remembered", ("remembers", "opener_names")),
        ("the figure asked for is given", ("answers_the_number",)),
        ("no fragment, no scrap of another line", ("no_fragment",)),
        ("one step, one date, one done-check", ("single_step_line",)),
        ("no date of the model's own", ("no_step_by_model_dates",)),
        ("no invented fact of the founder", ("no_invented_founder_fact",)),
        ("no internal words, no identity inside an answer", ("no_internal_words", "no_identity_leak")),
        ("the story told once", ("no_duplicate_story_entries",)),
        ("the founder's news read", ("news_interpreted",)),
        ("a newcomer met where they are", ("first_time_adapted",)),
        ("lists whole", ("list_formatting",)),
        ("no reply over again", ("repeats_previous_reply",)),
    ):
        value, passed = rate(*names)
        # What only a model can say (a sum, what a result means) is shown for a mock run, never judged.
        out.append(_gate(label, value, passed if timed or not set(names) & MODEL_SAYS else None))
    unscored = sum(1 for t in turns if t.card is not None and t.card.error is not None)
    judged = sum(1 for t in turns if t.card is not None)
    out.append(
        _gate(
            "every judged reply scored",
            f"{judged - unscored}/{judged}" if judged else None,
            (unscored == 0) if judged else None,
        )
    )
    fit = calibration.get("calibrated") if calibration else None
    out.append(
        _gate(
            "the judge agrees with the hand-graded replies",
            None
            if not calibration
            else f"within one {calibration['within_one']}, bias {calibration['bias']}",
            fit,
        )
    )
    target = meets_target(summary)
    overall = None if summary.overall is None else round(summary.overall, 2)
    if calibration is not None and fit is not True:
        # A judge that is lenient (or harsh) on replies graded by hand makes its scores no evidence of a pass.
        target = None if target is None or fit is None else False
    out.append(_gate("client score at least 4.5, no criterion under 4", overall, target))
    out.append(
        _gate(
            "privacy gate",
            summary.privacy_gate or None,
            None if not summary.privacy_gate else summary.privacy_gate == "OK",
        )
    )
    first = spread([float(t.first_token_ms) for t in typed if t.first_token_ms is not None], 0)
    out.append(
        _gate(
            "typed first token p50 (ms)",
            first["p50"] if first else None,
            first["p50"] <= FIRST_TOKEN_P50_MS if first else None,
        )
    )
    whole = spread([t.seconds for t in typed])
    out.append(
        _gate(
            "typed whole turn p50 (s)",
            whole["p50"] if whole else None,
            whole["p50"] <= TURN_P50_SECONDS if whole else None,
        )
    )
    costs = [t.cost_usd for t in typed if t.cost_usd]
    average = sum(costs) / len(costs) if costs else None
    out.append(
        _gate(
            "cost per typed turn (USD)",
            None if average is None else round(average, 5),
            None if average is None else average <= TURN_COST_USD,
        )
    )
    return out


def aggregate(results: Sequence[ScenarioResult], meta: Mapping[str, Any]) -> dict[str, Any]:
    """The public summary."""
    turns = all_turns(results)
    summary = tool_summary(scored_rows(results))
    raw = tool_summary(scored_rows(results, raw=True))
    blocking = sum(
        1 for t in turns for k, g in t.grades.items() if g.passed is False and k in BLOCKING
    ) + sum(1 for r in results for k, g in r.grades.items() if g.passed is False and k in BLOCKING)
    by_question = {}
    for qid in (*QUESTIONS, *EXTRA):
        rows = [
            t.card.scores for _, t in log_turns(results) if t.plan.q == qid and t.card and not t.card.error
        ]
        asked = [t for _, t in log_turns(results) if t.plan.q == qid]
        if not asked:
            continue
        line = tool_summary(rows)
        by_question[qid] = {
            "replies": len(asked),
            "scored": line.tests,
            "weighted": None if line.overall is None else round(line.overall, 2),
            "criteria": line.public()["criteria"],
            "failed": sorted({k for t in asked for k, g in t.grades.items() if g.passed is False}),
        }
    judge_errors = [t.card.error for t in turns if t.card is not None and t.card.error]
    channels = {}
    for channel in ("chat", "call"):
        mine = [t for t in turns if t.channel == channel]
        channels[channel] = {
            "turns": len(mine),
            "errors": sum(1 for t in mine if t.kind == "error"),
            "seconds": spread([t.seconds for t in mine if t.kind != "error"]),
            "first_token_ms": spread(
                [float(t.first_token_ms) for t in mine if t.first_token_ms is not None], 0
            ),
            "cost_usd": spread([t.cost_usd for t in mine if t.cost_usd], 5),
            "input_tokens": spread([float(t.input_tokens) for t in mine if t.input_tokens], 0),
        }
    applied = sum(1 for r in results if r.status == "completed")
    return {
        **meta,
        "scenarios": {
            "planned": len(results),
            "completed": applied,
            "by_status": _counts(r.status for r in results),
        },
        "turns": {
            "planned": sum(r.scenario.turns for r in results),
            "run": len(turns),
            "coaching": sum(1 for t in turns if t.plan.expect.kind in STEP_KINDS),
            "with_guidance": sum(1 for t in turns if t.guidance is not None),
        },
        "blocking_failures": blocking,
        "graders": grader_rates(results),
        "score": summary.public(),
        "score_before_caps": raw.public(),
        "judge_errors": _counts(judge_errors),
        "judge_checks": judge_checks(results),
        "questions": by_question,
        "channels": channels,
        "gates": gates(
            results,
            summary,
            timed=meta.get("evidence") == "live",
            calibration=meta.get("calibration"),
        ),
        "results": [r.public() for r in results],
    }


def _counts(values: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in values:
        out[str(v)] = out.get(str(v), 0) + 1
    return dict(sorted(out.items()))


def gates_failed(summary: Mapping[str, Any]) -> list[str]:
    return [g["gate"] for g in summary["gates"] if g["passed"] is False]


def render(summary: Mapping[str, Any]) -> str:
    """The public summary as Markdown: numbers, ids and codes."""
    out = ["## Client test", ""]
    turns, scenarios = summary["turns"], summary["scenarios"]
    out.append(
        f"Evidence: {summary['evidence']}. Wording: {summary['wording']}. Scenarios {scenarios['completed']}/"
        f"{scenarios['planned']} completed, turns {turns['run']}/{turns['planned']}, with guidance "
        f"{turns['with_guidance']}, blocking failures {summary['blocking_failures']}."
    )
    if summary.get("coach"):
        out.append(
            f"Coach: {summary['coach']} (coach_model {summary.get('coach_choice', 'default')}, coach_think "
            f"{summary.get('coach_think', 'default')}, understand {summary.get('understand', 'default')}, "
            f"understand_model {summary.get('understand_model', 'default')}). Judge: "
            f"{summary.get('judge') or 'none'} ({summary.get('judge_prompt', '-')}, "
            f"{'of another family than the coach' if summary.get('judge_independent') else 'no independent judge'}). "
            f"Groups: {_groups(summary.get('groups'))}."
        )
    plan = summary.get("plan")
    if plan:
        out.append(
            f"Estimate before the run: USD {plan['total_usd']:.2f} (app {plan['app_usd']:.2f}, judge and simulator "
            f"{plan['lab_usd']:.2f}; {plan['turns']} turns, {plan['judged']} judged)."
        )
    out += ["", "| Gate | Value | Result |", "| --- | --- | --- |"]
    for g in summary["gates"]:
        result = "not measured" if g["passed"] is None else "pass" if g["passed"] else "FAIL"
        out.append(f"| {g['gate']} | {'-' if g['value'] is None else g['value']} | {result} |")
    out += ["", "| Grader | Passed / applied |", "| --- | --- |"]
    for name, row in summary["graders"].items():
        mark = " (blocking)" if name in BLOCKING else ""
        out.append(f"| {name}{mark} | {row['passed']}/{row['applied']} |")
    score = summary["score"]
    if score["tests"]:
        out += ["", "| Criterion | Mean (capped) | Judge alone |", "| --- | --- | --- |"]
        for name in CRITERIA:
            mine, alone = score["criteria"][name], summary["score_before_caps"]["criteria"][name]
            out.append(f"| {COLUMN_TITLES[name]} | {_cell(mine)} | {_cell(alone)} |")
        out.append(
            f"| Overall (mean of {score['tests']} rows) | {_cell(score['overall'])} | "
            f"{_cell(summary['score_before_caps']['overall'])} |"
        )
        out.append(f"| Privacy gate | {score['privacy_gate'] or '-'} | |")
    out += _calibration_lines(summary.get("calibration"))
    if summary.get("judge_checks"):
        out += ["", "| The judge's checks | Replies |", "| --- | --- |"]
        out += [f"| {name} | {count} |" for name, count in summary["judge_checks"].items()]
    if summary["questions"]:
        out += ["", "| Question | Replies | Weighted | Failed graders |", "| --- | --- | --- | --- |"]
        for qid, q in summary["questions"].items():
            out.append(
                f"| {qid} | {q['replies']} | {_cell(q['weighted'])} | {', '.join(q['failed']) or '-'} |"
            )
    out += ["", "| Channel | Turns | Errors | Whole turn s | First token ms | USD a turn |"]
    out.append("| --- | --- | --- | --- | --- | --- |")
    for name, c in summary["channels"].items():
        out.append(
            f"| {name} | {c['turns']} | {c['errors']} | {_spread(c['seconds'])} | {_spread(c['first_token_ms'])} | "
            f"{_spread(c['cost_usd'])} |"
        )
    out += ["", "| Scenario | Status | Turns | Failed |", "| --- | --- | --- | --- |"]
    for r in summary["results"]:
        failed = [f"{t['at']}:{k}" for t in r["turns"] for k in t["failed"]] + r["scenario_failed"]
        shown = ", ".join(failed[:8]) + (f" +{len(failed) - 8}" if len(failed) > 8 else "")
        out.append(f"| {r['id']} | {r['status']} | {len(r['turns'])}/{r['planned_turns']} | {shown or '-'} |")
    return "\n".join(out) + "\n"


def _groups(value: Any) -> str:
    return ", ".join(value) if isinstance(value, list) else "all"


def _calibration_lines(found: Mapping[str, Any] | None) -> list[str]:
    """How the judge agreed with the hand-graded replies: numbers and case ids."""
    if not found:
        return []
    verdict = {True: "calibrated", False: "NOT calibrated", None: "not measured"}[found["calibrated"]]
    out = [
        "",
        f"Judge on {found['scored']}/{found['cases']} hand-graded replies: {verdict}.",
        "",
        "| Scores | Exact | Within one | Bias (judge - hand) | Lenient by 2+ | Harsh by 2+ | Bad caught | Good kept "
        "| Same answered |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        f"| {found['pairs']} | {_cell(found['exact'])} | {_cell(found['within_one'])} | {_cell(found['bias'])} | "
        f"{found['lenient_by_two']} | {found['harsh_by_two']} | {_cell(found['bad_caught'])} | "
        f"{_cell(found['good_kept'])} | {_cell(found['answered_same'])} |",
        "",
        "| Criterion | Scores | Within one | Bias |",
        "| --- | --- | --- | --- |",
    ]
    out += [
        f"| {COLUMN_TITLES[c]} | {row['pairs']} | {_cell(row['within_one'])} | {_cell(row['bias'])} |"
        for c, row in found["by_criterion"].items()
    ]
    if found["off"]:
        out += ["", f"Two or more apart on: {', '.join(found['off'])}."]
    return out


def judge_checks(results: Sequence[ScenarioResult]) -> dict[str, int]:
    """How many judged replies the judge's own checks found wanting (counts only)."""
    cards = [
        t.card for t in all_turns(results) if t.card is not None and t.card.error is None and t.card.checks
    ]
    if not cards:
        return {}
    count = lambda test: sum(1 for c in cards if test(c.checks))  # noqa: E731
    return {
        "judged": len(cards),
        "answered": count(lambda c: c["answered"] == "yes"),
        "answered in part": count(lambda c: c["answered"] == "partly"),
        "not answered": count(lambda c: c["answered"] == "no"),
        "something invented": count(lambda c: bool(c["invented"])),
        "steps or dates in conflict": count(lambda c: c["conflict"]),
        "not readable": count(lambda c: not c["readable"]),
        "no fact of the founder's": count(lambda c: not c["own_facts"]),
        "newcomer not met": count(lambda c: c["adapted"] is False),
        "news not read": count(lambda c: c["news_read"] is False),
    }


def _cell(value: Any) -> str:
    return "-" if value is None else f"{value:g}"


def _spread(cell: Mapping[str, Any] | None) -> str:
    return "-" if not cell else f"p50 {cell['p50']:g}, p95 {cell['p95']:g} (n={cell['n']})"


# Private outputs ---------------------------------------------------------------------------------------------------


def safe_cell(text: str) -> str:
    """A CSV cell a spreadsheet never runs: text that starts like a formula is marked as text."""
    clean = text.replace("\r", "").strip()
    return f"'{clean}" if clean[:1] in ("=", "+", "-", "@", "\t") else clean


def _notes(t: TurnResult) -> str:
    parts = []
    failed = sorted(k for k, g in t.grades.items() if g.passed is False)
    if failed:
        parts.append("failed checks: " + ", ".join(failed))
    if t.card is not None:
        if t.card.error:
            parts.append(f"not scored: {t.card.error}")
        if t.card.capped:
            parts.append("capped: " + ", ".join(f"{c} by {g}" for c, g in t.card.capped.items()))
        if t.card.note:
            parts.append(t.card.note)
    step = (t.guidance or {}).get("step")
    if isinstance(step, dict) and step.get("title"):
        parts.append(
            f"next step shown: {step['title']}" + (f" by {step['dueOn']}" if step.get("dueOn") else "")
        )
    parts.append(f"{t.seconds:.1f} s")
    return "; ".join(parts)


def write_log(
    results: Sequence[ScenarioResult],
    path: Path,
    *,
    start_row: int = LOG_START_ROW,
    start_test: int = LOG_START_TEST,
) -> int:
    """The filled Tool Test Log, ready to paste at ``start_row`` of the client's sheet: the automatic columns carry the
    sheet's own formulas (question, test type, weighted score), so pasting keeps them working. Returns the rows."""
    header = [
        "Test ID",
        "Tool",
        "Q#",
        "Question (auto)",
        "Test type (auto)",
        "Fictional startup / role",
        "Answer (paste or summarize)",
        *COLUMN_TITLES.values(),
        "Weighted score (auto)",
        "Notes / evidence",
    ]
    rows = log_turns(results)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        out = csv.writer(fh)
        out.writerow(header)
        for n, (r, t) in enumerate(rows):
            row = start_row + n
            number = t.plan.q[1:] if t.plan.q in QUESTIONS else ""
            scores = t.card.scores if t.card is not None and t.card.error is None else {}
            extra = "" if number else f'EXTRA: asked "{t.founder}". '
            out.writerow(
                [
                    f"T{start_test + n:03d}",
                    TOOL_NAME,
                    number,
                    f'=IF(C{row}="","",INDEX(\'Founder Questions\'!$D$5:$D$24,C{row}))',
                    f'=IF(C{row}="","",INDEX(\'Founder Questions\'!$C$5:$C$24,C{row}))',
                    safe_cell(
                        f"{r.scenario.venture['name']} - {r.scenario.venture['oneLiner']} (fictional, "
                        f"{r.scenario.role}, {'voice call' if t.channel == 'call' else 'typed'}, {r.scenario.id})"
                    ),
                    safe_cell(t.reply or f"(no reply: {t.error})"),
                    *["" if scores.get(c) is None else scores[c] for c in CRITERIA],
                    f'=IF(COUNT(H{row}:N{row})=0,"",SUMPRODUCT(H{row}:N{row},$H$3:$N$3)/'
                    f'SUMIF(H{row}:N{row},">0",$H$3:$N$3))',
                    safe_cell(extra + _notes(t)),
                ]
            )
    return len(rows)


def comparison(ours: ToolSummary, tools: Mapping[str, ToolSummary]) -> str:
    """Our line beside the other tools' recorded ones (private: their scores are the client's)."""
    names = [TOOL_NAME, *tools]
    lines = {TOOL_NAME: ours, **tools}
    out = ["| | " + " | ".join(names) + " |", "| --- |" + " --- |" * len(names)]
    out.append("| Rows scored | " + " | ".join(str(lines[n].tests) for n in names) + " |")
    for c in CRITERIA:
        cells = [lines[n].criteria[c] for n in names]
        out.append(
            f"| {COLUMN_TITLES[c]} | " + " | ".join("-" if v is None else f"{v:.2f}" for v in cells) + " |"
        )
    overall = [lines[n].overall for n in names]
    out.append("| Overall weighted | " + " | ".join("-" if v is None else f"{v:.2f}" for v in overall) + " |")
    out.append("| Privacy gate | " + " | ".join(lines[n].privacy_gate or "-" for n in names) + " |")
    return "\n".join(out) + "\n"


def write_private(
    results: Sequence[ScenarioResult], folder: Path, tools: Mapping[str, ToolSummary]
) -> dict[str, Any]:
    folder.mkdir(parents=True, exist_ok=True)
    rows = write_log(results, folder / "tool-test-log.csv")
    ours = tool_summary(scored_rows(results))
    if tools:
        (folder / "comparison.md").write_text(comparison(ours, tools), encoding="utf-8")
    failures = [
        {
            "scenario": r.scenario.id,
            "at": t.at,
            "grader": k,
            "why": g.detail,
            "founder": t.founder,
            "reply": t.reply,
        }
        for r in results
        for t in r.turns
        for k, g in t.grades.items()
        if g.passed is False
    ]
    (folder / "failures.json").write_text(json.dumps(failures, indent=1), encoding="utf-8")
    return {
        "log_rows": rows,
        "weighted_rows": [w for s in scored_rows(results) if (w := weighted(s)) is not None],
    }
