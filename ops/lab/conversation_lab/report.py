"""The public summary of a lab run: numbers, ids, codes and fixed titles only (the repository and its Actions logs
are public). Everything here is built from the ``public()`` views of the results; nothing reads a transcript."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


def purpose_delta(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Spend per ledger purpose during the run (the app's own usage summary, end minus start)."""
    start = {row["purpose"]: row for row in before.get("byPurpose", [])}
    rows = []
    for row in after.get("byPurpose", []):
        base = start.get(row["purpose"], {})
        usd = round(float(row["usd"]) - float(base.get("usd", 0)), 6)
        calls = int(row["calls"]) - int(base.get("calls", 0))
        units = int(row.get("inputTokens", 0)) - int(base.get("inputTokens", 0))
        if calls or usd:
            rows.append({"purpose": row["purpose"], "usd": usd, "calls": calls, "input_units": units})
    return sorted(rows, key=lambda r: -r["usd"])


def _rate(passed: int, run: int) -> str:
    return f"{passed}/{run} ({passed / run:.0%})" if run else "0/0"


def _ms(cell: Mapping[str, Any] | None) -> str:
    if not cell or cell.get("p50") is None:
        return "-"
    return f"p50 {cell['p50']:.0f} ms, p95 {cell['p95']:.0f} ms"


def render(summary: Mapping[str, Any]) -> str:
    out: list[str] = []
    suite = summary["suite"]
    result = summary.get("result") or {}
    spend = summary.get("spend") or {}
    out.append(f"## Conversation lab: {suite}")
    out.append("")
    out.append("| | |")
    out.append("| --- | --- |")
    if "passed" in result and "run" in result:
        out.append(f"| Passed | {_rate(int(result['passed']), int(result['run']))} |")
    if result.get("pass_rate") is not None and "passed" not in result:
        out.append(f"| Pass rate | {result['pass_rate']:.0%} |")
    out.append(
        f"| Spend | USD {spend.get('total_usd', 0):.4f} (app {spend.get('app_usd', 0):.4f} of "
        f"{spend.get('app_budget_usd', 0):.2f}, lab {spend.get('lab_usd', 0):.4f} of {spend.get('lab_budget_usd', 0):.2f}) |"
    )
    out.append(f"| Stopped by | {summary.get('stopped_by') or 'completed'} |")
    if summary.get("harness_error"):
        out.append(f"| Harness error | {summary['harness_error']} (server logs are in the sealed outputs) |")
    out.append(f"| Duration | {summary.get('duration_seconds', 0):.0f} s |")
    models = summary.get("models") or {}
    app = models.get("app") or {}
    out.append(f"| App models | {app.get('primary')} / {app.get('fallback')} / {app.get('embeddings')} |")
    if models.get("probes"):
        probes = ", ".join(f"{k}: {v}" for k, v in models["probes"].items())
        out.append(
            f"| Lab models | simulator {models.get('simulator')}, judge {models.get('judge')} ({probes}) |"
        )
    if summary.get("backfill"):
        out.append(f"| Seed embeddings | {summary['backfill']} |")
    if summary.get("memory_venture"):
        out.append(f"| Memory venture (remembered conversations) | {summary['memory_venture']} |")
    if result.get("turn_seconds"):
        cell = result["turn_seconds"]
        out.append(f"| Turn time (client) | p50 {cell['p50']} s, p95 {cell['p95']} s |")
    if result.get("humanness") is not None:
        out.append(f"| Humanness (judge, 0-100) | {result['humanness']} |")
    out.append("")
    rows = spend.get("app_by_purpose") or []
    if rows:
        out.append("| App spend by purpose | USD | calls | units |")
        out.append("| --- | --- | --- | --- |")
        out.extend(f"| {r['purpose']} | {r['usd']:.4f} | {r['calls']} | {r['input_units']} |" for r in rows)
        out.append("")
    lab_rows = spend.get("lab_by_purpose") or {}
    if lab_rows:
        out.append("| Lab spend by purpose | USD | calls |")
        out.append("| --- | --- | --- |")
        out.extend(f"| {k} | {v['usd']:.4f} | {int(v['calls'])} |" for k, v in lab_rows.items())
        out.append("")
    out.extend(_suite_tables(suite, result))
    out.extend(_log_tables(summary.get("app_logs")))
    return "\n".join(out) + "\n"


def _ms_cell(cell: Mapping[str, Any] | None) -> str:
    if not cell:
        return "-"
    return f"p50 {cell['p50']:g}, p95 {cell['p95']:g} (n={cell['n']})"


def _log_tables(logs: Mapping[str, Any] | None) -> list[str]:
    """The app's own log numbers: model attempts per purpose, invalid-output issues, server timings."""
    if not logs:
        return []
    out = ["| Model attempts (app logs) | First attempts | First invalid_output | Share | All attempts |"]
    out.append("| --- | --- | --- | --- | --- |")
    for purpose, c in (logs.get("model_attempts") or {}).items():
        share = c.get("first_invalid_share_pct")
        out.append(
            f"| {purpose} | {c.get('first_attempts', 0)} | {c.get('first_invalid_output', 0)} | "
            f"{'-' if share is None else f'{share:g} %'} | {c.get('attempts', 0)} |"
        )
    out.append("")
    issues = logs.get("invalid_output_issues") or {}
    if issues:
        out.append(
            f"Invalid-output issue codes ((root): max_tokens {logs.get('root_max_tokens', 0)}): "
            + ", ".join(f"`{code}` x{n}" for code, n in issues.items())
        )
        out.append("")
    totals = logs.get("turn_total_ms") or {}
    out.append(
        f"Server turn time: chat {_ms_cell(totals.get('chat'))} ms; voice {_ms_cell(totals.get('voice'))} ms; "
        f"voice first speech {_ms_cell(logs.get('voice_first_speech_ms'))} ms; "
        f"Polly first audio {_ms_cell(logs.get('polly_first_audio_ms'))} ms. Stream fallbacks: "
        f"{logs.get('stream_fallbacks') or 'none'}; interrupt requests: {logs.get('interrupt_requests', 0)}."
    )
    out.append("")
    voice_turns = [t for t in logs.get("turns") or [] if t.get("voice")]
    if voice_turns:
        out.append(
            'Per voice turn (ms; "at" = since the request reached the API, the rest are durations; Titan embed '
            "sums every embedding call of the request, including any after the reply):"
        )
        out.append("")
        out.append(
            "| Voice turn | Retrieval | Titan embed | Model start (at) | Time to first token | First token (at) | First delta (at) | Gate hold | First speech (at) | Polly first audio | Total |"
        )
        out.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for n, t in enumerate(voice_turns, start=1):
            cells = [
                t.get(k)
                for k in (
                    "retrievalMs",
                    "embedMs",
                    "modelStartMs",
                    "modelFirstTokenMs",
                    "modelFirstTokenAtMs",
                    "firstDeltaMs",
                    "firstTokenToDeltaMs",
                    "firstSpeechMs",
                    "pollyFirstAudioMs",
                    "totalMs",
                )
            ]
            out.append(f"| {n} | " + " | ".join("-" if c is None else f"{c:g}" for c in cells) + " |")
        out.append("")
    return out


def _suite_tables(suite: str, result: Mapping[str, Any]) -> list[str]:
    out: list[str] = []
    scenarios: Sequence[Mapping[str, Any]] = result.get("scenarios") or []
    greeting = result.get("greeting") if suite == "recall" else None
    if greeting:
        out.append(
            f"Greeting (RG-01): typed while the greeting played {greeting.get('greeting_playing_when_typed')}; "
            f"call opened → turn sent {greeting.get('call_to_turn_ms')} ms; typed → turn sent "
            f"{greeting.get('typed_to_turn_ms')} ms; greeting stopped {greeting.get('greeting_stopped')}; "
            f"{'pass' if greeting.get('passed') else 'fail'}"
            + (f" ({greeting['error']})" if greeting.get("error") else "")
            + "."
        )
        out.append("")
    openers = result.get("openers") if suite == "recall" else None
    if openers:
        flagged = [
            o for o in openers if o["quoted_question"] or o["lowercase_name"] or o["third_person_name"]
        ]
        out.append(
            f"Openers: {len(openers)} checked, {len(flagged)} flagged"
            + (
                ": " + ", ".join(f"{o['id']} {o['conversation']}" for o in flagged)
                if flagged
                else " (no quoted question, no lower-case or third-person name)"
            )
            + "."
        )
        out.append("")
    if suite == "recall" and scenarios:
        out.append("| Scenario | Passed | Why | Facts named | Judge accuracy / natural / invented |")
        out.append("| --- | --- | --- | --- | --- |")
        for s in scenarios:
            facts = ", ".join(c["facts_named"] for c in s["checks"]) or "-"
            judge = ", ".join(
                "-"
                if not c["judge"]
                else (
                    c["judge"]["error"]
                    or f"{c['judge']['accuracy']} / {c['judge']['natural']} / {c['judge']['invented']}"
                )
                for c in s["checks"]
            )
            out.append(
                f"| {s['id']} | {'yes' if s['passed'] else 'no'} | {s['reason']} | {facts} | {judge or '-'} |"
            )
        out.append("")
    aged = result.get("aged_gaps") if suite == "matrix" else None
    if aged:
        out.append(
            f"Days and weeks later: {aged['aged']} gaps aged in the lab's database "
            f"({aged['after_distillation']} after the conversation was distilled)."
        )
        out.append("")
    skipped = result.get("skipped") if suite == "matrix" else None
    if skipped:
        reasons: dict[str, list[str]] = {}
        for item in skipped:
            reasons.setdefault(item["reason"], []).append(item["id"])
        out.append(
            f"Skipped: {len(skipped)} ("
            + "; ".join(f"{reason}: {', '.join(ids)}" for reason, ids in sorted(reasons.items()))
            + ")."
        )
        out.append("")
    if suite == "matrix" and result.get("evals_report_md"):
        out.append(
            f"Source: {result.get('source')} (exit {result.get('evals_exit')}). Its report (ids, codes, numbers):"
        )
        out.append("")
        out.append(str(result["evals_report_md"]).replace("\n# ", "\n#### ").replace("\n## ", "\n#### "))
        out.append("")
    if suite == "matrix" and scenarios:
        out.append("| Scenario | Passed | Why | Judge mean | Findings |")
        out.append("| --- | --- | --- | --- | --- |")
        for s in scenarios:
            judge = s.get("judge") or {}
            findings = (
                ", ".join(
                    [
                        *s.get("blocking_findings", []),
                        *s.get("presence_findings", []),
                        *s.get("craft_findings", []),
                    ]
                )
                or "-"
            )
            mean = judge.get("mean")
            out.append(
                f"| {s['id']} | {'yes' if s['passed'] else 'no'} | {s['reason']} | {mean if mean is not None else '-'} | {findings} |"
            )
        out.append("")
        notes = result.get("validator_notes") or {}
        findings = result.get("findings") or {}
        if notes or findings:
            out.append(
                f"Voice turns: {result.get('voice_turns', 0)}. Validator notes: "
                + (", ".join(f"`{k}` x{v}" for k, v in notes.items()) or "none")
                + ". Grader findings: "
                + (", ".join(f"`{k}` x{v}" for k, v in findings.items()) or "none")
                + "."
            )
            out.append("")
        census = result.get("census") or {}
        if census:
            n = census.get("replies") or 0
            out.append(f"Phrase census over {n} replies (count of replies with the pattern):")
            out.append("")
            out.append("| Pattern | Replies |")
            out.append("| --- | --- |")
            out.extend(f"| {k} | {v} |" for k, v in census.items() if k != "replies")
            out.append("")
        dims = result.get("dimensions") or {}
        if dims:
            out.append("| Dimension | Value | Passed |")
            out.append("| --- | --- | --- |")
            for dimension, values in sorted(dims.items()):
                for value, cell in sorted(values.items()):
                    out.append(f"| {dimension} | {value} | {_rate(cell['passed'], cell['run'])} |")
            out.append("")
    if suite == "voice" and result.get("voice"):
        v = result["voice"]
        out.append(
            f"Input: {v.get('input_mode')} (microphone opened {v.get('mic_opened')}, line 1 through the fake device "
            f"{v.get('device_line_heard')}); mean WER {v.get('mean_wer')}; result {v.get('reason')}."
        )
        out.append("")
        out.append(f"- First audio after the founder stops speaking: {_ms(v.get('first_audio_ms'))}")
        out.append(
            f"- End of speech to turn sent (endpointing + transcription): {_ms(v.get('end_of_speech_to_turn_ms'))}"
        )
        out.append(f"- Turn sent to first audio (model + speech): {_ms(v.get('turn_to_first_audio_ms'))}")
        b = v.get("barge_in") or {}
        out.append(
            f"- Barge-in: attempted {b.get('attempted')}, reply was playing {b.get('reply_was_playing')}, "
            f"interrupt sent {b.get('interrupt_sent')}, playback stopped after {b.get('stop_ms')} ms"
            + (f" (p50 of {b.get('stops_ms')})" if len(b.get("stops_ms") or []) > 1 else "")
        )
        out.append(
            f"- Calls: {v.get('calls', 1)}; self-interruptions (interrupts the test did not cause): "
            f"{v.get('self_interruptions')}"
        )
        if v.get("client_stats"):
            out.append(f"- App-reported (call end): {json.dumps(v['client_stats'])}")
        out.append("")
        out.append("| Line | WER | End of speech → turn | Turn → first audio | First audio |")
        out.append("| --- | --- | --- | --- | --- |")
        for row in v.get("lines", []):
            out.append(
                f"| {row['id']} | {row['wer']} | {row['end_of_speech_to_turn_ms']} | {row['turn_to_first_audio_ms']} | {row['first_audio_ms']} |"
            )
        out.append("")
    if suite == "ui" and result.get("ui"):
        u = result["ui"]
        t = u["totals"]
        out.append(
            f"Passed {t['expected']}, failed {t['unexpected']}, flaky {t['flaky']}, skipped {t['skipped']} "
            f"in {u['duration_seconds']} s."
        )
        out.append("")
        out.append("| Spec | Passed | Failed | Flaky | Skipped |")
        out.append("| --- | --- | --- | --- | --- |")
        for file, row in sorted(u["per_file"].items()):
            out.append(
                f"| {file} | {row['expected']} | {row['unexpected']} | {row['flaky']} | {row['skipped']} |"
            )
        out.append("")
        if u["failing"]:
            out.append("Failing tests (titles only; errors are in the sealed report):")
            out.extend(f"- {f['file']} [{f['project']}] {f['title']}" for f in u["failing"])
            out.append("")
    return out


def render_with_baseline(summary: Mapping[str, Any]) -> str:
    from conversation_lab.compare import render as render_comparison

    text = render(summary)
    baseline = summary.get("baseline")
    if isinstance(baseline, Mapping):
        if baseline.get("comparison"):
            text += "\n" + render_comparison(baseline["comparison"], str(baseline.get("run_id")))
        else:
            text += f"\nNo comparison with run {baseline.get('run_id')}: {baseline.get('error')}.\n"
    return text


def write(summary: Mapping[str, Any], public_dir: Path) -> str:
    public_dir.mkdir(parents=True, exist_ok=True)
    (public_dir / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    text = render_with_baseline(summary)
    (public_dir / "summary.md").write_text(text, encoding="utf-8")
    return text
