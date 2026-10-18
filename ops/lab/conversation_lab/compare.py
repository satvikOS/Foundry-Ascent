"""Before/after: a run's public summary side by side with a baseline run's (numbers, ids and codes only).

The baseline is another run's `summary.json` (the public artifact of the workflow, or a committed copy under
ops/lab/baselines/ that adds what older runs did not report, such as the phrase census). Every table shows the
baseline, this run and the change, so a comparison needs no reading of transcripts.
"""

from __future__ import annotations

import json
import statistics
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from conversation_lab.config import LAB_DIR

BASELINES_DIR = LAB_DIR / "baselines"


def baseline_path(suite: str, run_id: str, downloaded: Path | None = None) -> Path | None:
    """The committed baseline `ops/lab/baselines/<suite>-<run id>.json` if there is one, else a downloaded summary."""
    committed = BASELINES_DIR / f"{suite}-{run_id}.json"
    if committed.is_file():
        return committed
    if downloaded is not None and downloaded.is_file():
        return downloaded
    return None


def load_baseline(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "suite" not in data:
        raise ValueError("not a lab summary")
    return data


#: The per-turn server stages compared between runs (medians over the run's voice turns).
VOICE_STAGES = (
    "retrievalMs",
    "embedMs",
    "modelStartMs",
    "modelFirstTokenMs",
    "firstTokenToDeltaMs",
    "firstSpeechMs",
    "pollyFirstAudioMs",
)


STAGE_LABELS = {
    "retrievalMs": "retrieval",
    "embedMs": "Titan embed (all calls)",
    "modelStartMs": "model start (offset)",
    "modelFirstTokenMs": "time to first token",
    "firstTokenToDeltaMs": "gate hold (first token → first delta)",
    "firstSpeechMs": "first speech (offset)",
    "pollyFirstAudioMs": "Polly first audio",
}


def _gate_hold(turn: Mapping[str, Any]) -> float | None:
    """First released words minus the first token's arrival, from the logged fields themselves (summaries
    written before 2026-10-18 stored this gap with the time to first token taken as an offset)."""
    start, ttft, delta = turn.get("modelStartMs"), turn.get("modelFirstTokenMs"), turn.get("firstDeltaMs")
    if all(isinstance(v, int | float) for v in (start, ttft, delta)):
        return float(delta) - float(start) - float(ttft)  # type: ignore[arg-type]
    return None


def voice_stage_medians(logs: Mapping[str, Any]) -> dict[str, float]:
    turns = [t for t in logs.get("turns") or [] if isinstance(t, Mapping) and t.get("voice")]
    out: dict[str, float] = {}
    for stage in VOICE_STAGES:
        if stage == "firstTokenToDeltaMs":
            values = [g for t in turns if (g := _gate_hold(t)) is not None]
        else:
            values = [t[stage] for t in turns if isinstance(t.get(stage), int | float)]
        if values:
            out[stage] = float(statistics.median(values))
    return out


def _flagged(openers: Any) -> int | None:
    """Openings that quote a question or name the founder in lower case or in the third person."""
    if not isinstance(openers, list):
        return None
    return sum(
        1
        for o in openers
        if isinstance(o, Mapping)
        and (o.get("quoted_question") or o.get("lowercase_name") or o.get("third_person_name"))
    )


def _rate(cell: Mapping[str, Any] | None) -> float | None:
    if not cell or not cell.get("run"):
        return None
    return cell["passed"] / cell["run"]


def _delta(before: float | None, after: float | None, digits: int = 1) -> float | None:
    if before is None or after is None:
        return None
    return round(after - before, digits)


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def compare(current: Mapping[str, Any], baseline: Mapping[str, Any]) -> dict[str, Any]:
    """A content-free comparison of two summaries of the same suite."""
    if current.get("suite") != baseline.get("suite"):
        raise ValueError("a baseline must be a run of the same suite")
    cur, base = current.get("result") or {}, baseline.get("result") or {}
    out: dict[str, Any] = {"baseline_suite": baseline.get("suite")}
    headline: list[dict[str, Any]] = []

    def row(name: str, before: Any, after: Any, digits: int = 1) -> None:
        headline.append(
            {
                "metric": name,
                "baseline": before,
                "now": after,
                "change": _delta(_num(before), _num(after), digits),
            }
        )

    b_rate = _rate({"passed": base.get("passed"), "run": base.get("run")})
    c_rate = _rate({"passed": cur.get("passed"), "run": cur.get("run")})
    row(
        "pass rate (%)",
        None if b_rate is None else round(100 * b_rate, 1),
        None if c_rate is None else round(100 * c_rate, 1),
    )
    row("passed", base.get("passed"), cur.get("passed"), 0)
    row("run", base.get("run"), cur.get("run"), 0)
    row("humanness (0-100)", base.get("humanness"), cur.get("humanness"))
    for key in ("p50", "p95"):
        row(
            f"turn time {key} (s)",
            (base.get("turn_seconds") or {}).get(key),
            (cur.get("turn_seconds") or {}).get(key),
            2,
        )
    voice_b, voice_c = base.get("voice") or {}, cur.get("voice") or {}
    if voice_b or voice_c:
        row("mean WER", voice_b.get("mean_wer"), voice_c.get("mean_wer"), 4)
        for name in ("first_audio_ms", "end_of_speech_to_turn_ms", "turn_to_first_audio_ms"):
            for key in ("p50", "p95"):
                row(
                    f"{name} {key}", (voice_b.get(name) or {}).get(key), (voice_c.get(name) or {}).get(key), 0
                )
        row(
            "barge-in stop p50 (ms)",
            (voice_b.get("barge_in") or {}).get("stop_ms"),
            (voice_c.get("barge_in") or {}).get("stop_ms"),
            0,
        )
        row("self-interruptions", voice_b.get("self_interruptions"), voice_c.get("self_interruptions"), 0)
    greet_b, greet_c = base.get("greeting") or {}, cur.get("greeting") or {}
    if greet_b or greet_c:
        row(
            "greeting: call opened → turn sent (ms)",
            greet_b.get("call_to_turn_ms"),
            greet_c.get("call_to_turn_ms"),
            0,
        )
    if base.get("openers") is not None or cur.get("openers") is not None:
        row("openers flagged", _flagged(base.get("openers")), _flagged(cur.get("openers")), 0)
    row(
        "spend (USD)",
        (baseline.get("spend") or {}).get("total_usd"),
        (current.get("spend") or {}).get("total_usd"),
        4,
    )
    logs_b, logs_c = baseline.get("app_logs") or {}, current.get("app_logs") or {}
    attempts_b, attempts_c = logs_b.get("model_attempts") or {}, logs_c.get("model_attempts") or {}
    for purpose in sorted(set(attempts_b) | set(attempts_c)):
        row(
            f"{purpose}: first attempts invalid_output (%)",
            (attempts_b.get(purpose) or {}).get("first_invalid_share_pct"),
            (attempts_c.get(purpose) or {}).get("first_invalid_share_pct"),
        )
    if logs_b or logs_c:
        row("(root): max_tokens issues", logs_b.get("root_max_tokens"), logs_c.get("root_max_tokens"), 0)
        for name in ("voice", "chat"):
            row(
                f"server turn time {name} p50 (ms)",
                ((logs_b.get("turn_total_ms") or {}).get(name) or {}).get("p50"),
                ((logs_c.get("turn_total_ms") or {}).get(name) or {}).get("p50"),
                0,
            )
        row("interrupt requests", logs_b.get("interrupt_requests"), logs_c.get("interrupt_requests"), 0)
        stages_b, stages_c = voice_stage_medians(logs_b), voice_stage_medians(logs_c)
        for stage in VOICE_STAGES:
            if stage in stages_b or stage in stages_c:
                row(
                    f"voice turn median {STAGE_LABELS.get(stage, stage)} (ms)",
                    stages_b.get(stage),
                    stages_c.get(stage),
                    0,
                )
    if base.get("findings") is not None or cur.get("findings") is not None:
        for key in ("structured_leak", "volunteered_ai_disclaimer", "repeated_reply", "stacked_questions"):
            row(
                f"finding {key}",
                (base.get("findings") or {}).get(key, 0),
                (cur.get("findings") or {}).get(key, 0),
                0,
            )
    out["headline"] = headline

    dims: list[dict[str, Any]] = []
    b_dims, c_dims = base.get("dimensions") or {}, cur.get("dimensions") or {}
    for dimension in sorted(set(b_dims) | set(c_dims)):
        values = set(b_dims.get(dimension) or {}) | set(c_dims.get(dimension) or {})
        for value in sorted(values):
            b_cell = (b_dims.get(dimension) or {}).get(value)
            c_cell = (c_dims.get(dimension) or {}).get(value)
            b, c = _rate(b_cell), _rate(c_cell)
            dims.append(
                {
                    "dimension": dimension,
                    "value": value,
                    "baseline": None if b_cell is None else f"{b_cell['passed']}/{b_cell['run']}",
                    "now": None if c_cell is None else f"{c_cell['passed']}/{c_cell['run']}",
                    "change_pct": None if b is None or c is None else round(100 * (c - b)),
                }
            )
    out["dimensions"] = dims

    census: list[dict[str, Any]] = []
    b_census, c_census = base.get("census") or {}, cur.get("census") or {}
    b_n, c_n = _num(b_census.get("replies")), _num(c_census.get("replies"))
    for name in [k for k in dict.fromkeys([*b_census, *c_census]) if k != "replies"]:
        b, c = _num(b_census.get(name)), _num(c_census.get(name))
        share = name not in ("words_p50", "words_p90")
        b_share = None if b is None or not b_n or not share else round(100 * b / b_n)
        c_share = None if c is None or not c_n or not share else round(100 * c / c_n)
        census.append(
            {
                "pattern": name,
                "baseline": b_census.get(name),
                "now": c_census.get(name),
                "baseline_share_pct": b_share,
                "now_share_pct": c_share,
                "change_pct": _delta(b_share, c_share, 0) if share else _delta(b, c, 0),
            }
        )
    out["census"] = census
    out["census_replies"] = {"baseline": b_census.get("replies"), "now": c_census.get("replies")}

    b_scen = {s["id"]: s for s in base.get("scenarios") or [] if isinstance(s, dict) and "id" in s}
    c_scen = {s["id"]: s for s in cur.get("scenarios") or [] if isinstance(s, dict) and "id" in s}
    changed = []
    for sid in sorted(set(b_scen) | set(c_scen)):
        b, c = b_scen.get(sid), c_scen.get(sid)
        if b is None or c is None or bool(b.get("passed")) != bool(c.get("passed")):
            changed.append(
                {
                    "id": sid,
                    "baseline": None if b is None else ("pass" if b.get("passed") else b.get("reason")),
                    "now": None if c is None else ("pass" if c.get("passed") else c.get("reason")),
                }
            )
    out["scenarios_changed"] = changed
    return out


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def _signed(value: Any) -> str:
    if value is None:
        return "-"
    return f"{value:+g}" if isinstance(value, int | float) else str(value)


def render(comparison: Mapping[str, Any], baseline_id: str) -> str:
    out = [f"### Compared with run {baseline_id}", ""]
    out += ["| Metric | Baseline | Now | Change |", "| --- | --- | --- | --- |"]
    for r in comparison["headline"]:
        if r["baseline"] is None and r["now"] is None:
            continue
        out.append(f"| {r['metric']} | {_fmt(r['baseline'])} | {_fmt(r['now'])} | {_signed(r['change'])} |")
    out.append("")
    if comparison["dimensions"]:
        out += ["| Dimension | Value | Baseline | Now | Change (pts) |", "| --- | --- | --- | --- | --- |"]
        for d in comparison["dimensions"]:
            out.append(
                f"| {d['dimension']} | {d['value']} | {_fmt(d['baseline'])} | {_fmt(d['now'])} | {_signed(d['change_pct'])} |"
            )
        out.append("")
    if comparison["census"]:
        n = comparison["census_replies"]
        out += [
            f"Phrase census (replies: baseline {_fmt(n['baseline'])}, now {_fmt(n['now'])}; shares are % of replies):",
            "",
            "| Pattern | Baseline | Now | Change |",
            "| --- | --- | --- | --- |",
        ]
        for c in comparison["census"]:
            if c["baseline_share_pct"] is not None or c["now_share_pct"] is not None:
                b = f"{_fmt(c['baseline'])} ({_fmt(c['baseline_share_pct'])} %)"
                a = f"{_fmt(c['now'])} ({_fmt(c['now_share_pct'])} %)"
                change = f"{_signed(c['change_pct'])} pts"
            else:
                b, a, change = _fmt(c["baseline"]), _fmt(c["now"]), _signed(c["change_pct"])
            out.append(f"| {c['pattern']} | {b} | {a} | {change} |")
        out.append("")
    if comparison["scenarios_changed"]:
        out += ["| Scenario | Baseline | Now |", "| --- | --- | --- |"]
        out += [
            f"| {s['id']} | {_fmt(s['baseline'])} | {_fmt(s['now'])} |"
            for s in comparison["scenarios_changed"]
        ]
        out.append("")
    return "\n".join(out) + "\n"
