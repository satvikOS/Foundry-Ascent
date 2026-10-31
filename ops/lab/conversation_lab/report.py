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
    if logs.get("face_approval_ms"):
        out.append(
            f"FULL face pre-approval, per spoken unit before it is sent: {_ms_cell(logs.get('face_approval_ms'))} ms "
            f"({logs.get('face_units_approved', 0)} admitted)."
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


AGENDA_ROWS = (
    ("conversations", "Conversations"),
    ("passed", "Passed (no deterministic failure, judge's expectation met)"),
    ("substanceOnRequest", "Help asked → substance given (of helpTurns)"),
    ("helpTurns", "Help asked (turns)"),
    ("questionBackOnly", "Help asked → only a question back"),
    ("fragmentsOnRequest", "Help asked → fewer than two sentences of content"),
    ("steerBack", "Other topic → steered back to the commitment (of otherTopicTurns)"),
    ("otherTopicTurns", "Turns on another topic"),
    ("reasks", "Replies re-asking an earlier question"),
    ("staleMentions", "Past-dated commitment called still open"),
    ("followUpWhenRaised", "Founder brings it up → follow-up asked"),
    ("openersReopeningCommitment", "Openers re-opening the commitment"),
    ("soOpenings", 'Replies opening "So …"'),
    ("distinctOpenings", "Distinct two-word openings"),
    ("judgeExpectationMet", "Judge: expectation met"),
    ("judgeAnswersTheRequest", "Judge: answers the actual request (1-5)"),
    ("judgeFollowsTopic", "Judge: follows topic changes (1-5)"),
    ("judgeFeltHeard", "Judge: felt heard (1-5)"),
)


def _agenda_tables(result: Mapping[str, Any]) -> list[str]:
    agenda = result.get("agenda") or {}
    channels = [c for c in ("chat", "call") if c in agenda]
    out = [
        "| Agenda check | " + " | ".join(["all", *channels]) + " |",
        "| --- |" + " --- |" * (1 + len(channels)),
    ]
    for key, label in AGENDA_ROWS:
        cells = [agenda.get(c, {}).get(key) for c in ("all", *channels)]
        out.append(f"| {label} | " + " | ".join("-" if v is None else str(v) for v in cells) + " |")
    out.append("")
    for conversation in result.get("conversations") or []:
        if conversation.get("failures") or conversation.get("error"):
            out.append(
                f"- {conversation['id']}: {', '.join(conversation.get('failures') or [])}"
                + (f" (error {conversation['error']})" if conversation.get("error") else "")
            )
    out.append("")
    return out


def _cell_text(value: Any, fmt: str = "{}") -> str:
    return "-" if value is None else fmt.format(value)


def _safety_tables(result: Mapping[str, Any]) -> list[str]:
    """The safety screen on the real model: precision and recall, counts by expected label, cost and latency."""
    if not result.get("report"):
        return [f"No report from lab-safety-screen.ts (exit {result.get('script_exit')}).", ""]
    out = [
        "| Crisis decision (lines labelled crisis or none) | Precision | Recall | TP | FP | FN | TN |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for key, label in (
        ("rules_only", "Rules only (as production today)"),
        ("pipeline", "Rules + safety screen"),
    ):
        c = result.get(key) or {}
        out.append(
            f"| {label} | {_cell_text(c.get('precision'))} | {_cell_text(c.get('recall'))} | "
            + " | ".join(_cell_text(c.get(k)) for k in ("tp", "fp", "fn", "tn"))
            + " |"
        )
    s = result.get("screen_alone") or {}
    out.append(
        f"| Screen alone (the {_cell_text(s.get('read'))} labelled lines it read) | {_cell_text(s.get('precision'))} | "
        f"{_cell_text(s.get('recall'))} | - | {_cell_text(s.get('false_crisis'))} | "
        f"{_cell_text(s.get('missed_crisis'))} | - |"
    )
    out.append("")
    out.append(
        "| Expected label | Lines | Rules: crisis | Screened | Screen: crisis | wellbeing | clear | failed "
        "| Turn: crisis | Turn: wellbeing |"
    )
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for label, cell in (result.get("by_expect") or {}).items():
        keys = ("rows", "rules", "screened", "crisis", "wellbeing", "clear", "failed")
        out.append(
            f"| {label} | "
            + " | ".join(_cell_text(cell.get(k)) for k in (*keys, "pipeline_crisis", "pipeline_wellbeing"))
            + " |"
        )
    out.append("")
    latency = result.get("latency_ms") or {}
    cost = result.get("cost_usd") or {}
    per_1000 = cost.get("per_1000_turns_at_hit_rate") or {}
    reply = result.get("with_reply") or {}
    out.append(
        f"Screen calls: {_cell_text(result.get('calls'))} of {_cell_text(result.get('rows'))} lines "
        f"(failed {_cell_text(result.get('failures'))}; budget reached: "
        f"{'yes' if result.get('budget_reached') else 'no'}). Latency p50 {_cell_text(latency.get('p50'))} ms, "
        f"p95 {_cell_text(latency.get('p95'))} ms. Cost USD {_cell_text(cost.get('total'))} "
        f"(USD {_cell_text(cost.get('per_call'))} a call); per 1,000 founder turns when "
        + ", ".join(
            f"{float(rate):.1%} reach the screen: USD {_cell_text(usd)}" for rate, usd in per_1000.items()
        )
        + "."
    )
    out.append(
        f"Closings read with the vEIR's previous reply: {_cell_text(reply.get('screened'))} (false crises "
        f"{_cell_text(reply.get('false_crisis'))}, missed crises {_cell_text(reply.get('missed_crisis'))}). "
        f"Wellbeing flags on ordinary lines: {_cell_text(result.get('wellbeing_on_ordinary'))}."
    )
    out.append("")
    return out


def _p(cell: Mapping[str, Any] | None) -> str:
    """A {p50, p95, n} cell of milliseconds."""
    if not cell:
        return "-"
    return f"p50 {cell['p50']} ms, p95 {cell['p95']} ms (n={cell['n']})"


def _face_tables(face: Mapping[str, Any]) -> list[str]:
    """The face suite's public numbers (conversation_lab/face.py public_result): checks, then each measurement."""
    out: list[str] = []
    if not face:
        return out
    credits = face.get("credits") or {}
    out.append(
        f"Vendor: {face.get('vendor')}; face mode: {face.get('face_mode') or 'full'}; founder made a platform admin: "
        f"{face.get('admin_grant')}; Playwright exit {face.get('playwright_exit')}; success codes (token, start): "
        f"{face.get('success_codes') or '-'}; credits before {credits.get('before')}, after {credits.get('after')}, "
        f"used {credits.get('used')}."
    )
    out.append("")
    out.append("| Check | Result |")
    out.append("| --- | --- |")
    for name, value in (face.get("checks") or {}).items():
        out.append(
            f"| {name} | {'pass' if value is True else 'FAIL' if value is False else 'not measured'} |"
        )
    out.append("")
    out.extend(_face_comparison(face))
    calls = face.get("vendor_calls") or {}
    if calls:
        out.append("| Vendor call | HTTP status | Envelope code |")
        out.append("| --- | --- | --- |")
        for path, row in calls.items():
            status = ", ".join(f"{k} x{v}" for k, v in row.get("status", {}).items()) or "-"
            code = ", ".join(f"{k} x{v}" for k, v in row.get("code", {}).items()) or "-"
            out.append(f"| {path} | {status} | {code} |")
        out.append("")
    lite_vendor = face.get("call_lite_vendor") or {}
    if lite_vendor:
        lite_credits = lite_vendor.get("credits") or {}
        lite_calls = lite_vendor.get("vendor_calls") or {}
        out.append(
            "LITE pass, its own API process (reported only; the checks above grade the FULL pass): success codes "
            f"(token, start): {lite_vendor.get('success_codes') or '-'}; credits before "
            f"{lite_credits.get('before')}, after {lite_credits.get('after')}, used {lite_credits.get('used')}; "
            "calls: "
            + (
                "; ".join(
                    f"{path} status {', '.join(f'{k} x{v}' for k, v in row.get('status', {}).items()) or '-'} "
                    f"code {', '.join(f'{k} x{v}' for k, v in row.get('code', {}).items()) or '-'}"
                    for path, row in lite_calls.items()
                )
                or "-"
            )
            + "."
        )
        out.append("")
    probe = face.get("probe") or {}
    if probe:
        exact = probe.get("exact") or {}
        queue = probe.get("queue") or {}
        interrupt = probe.get("interrupt") or {}
        transcript = probe.get("transcript_endpoint") or {}
        room = probe.get("full_room") or {}
        lite = probe.get("lite_room") or {}
        out.append("Vendor probe (raw sandbox rooms):")
        out.append(
            f"- Room: connected {room.get('connected_ms')} ms, first video {room.get('first_video_ms')} ms; FULL "
            f"token can publish data {room.get('can_publish_data')}, LITE token {lite.get('can_publish_data')}"
        )
        out.append(
            f"- speak_text: exact words {exact.get('matches')} ({exact.get('transcriptions')} transcription events); "
            f"publish → speak_started {exact.get('publish_to_started_ms')} ms, → first audio "
            f"{exact.get('publish_to_audio_ms')} ms, → avatar.transcription {exact.get('publish_to_transcription_ms')} ms"
        )
        out.append(
            f"- Three back to back: {queue.get('behaviour')} (starts {queue.get('starts')}, ends {queue.get('ends')}, "
            f"in order {queue.get('in_order')}); speak_ended → next speak_started {queue.get('gaps_ms')} ms"
        )
        out.append(
            f"- Interrupt: → speak_ended {interrupt.get('to_speak_ended_ms')} ms, → silence "
            f"{interrupt.get('to_silence_ms')} ms; queue cleared {interrupt.get('queue_cleared')}"
        )
        out.append(
            f"- speak_response in restricted mode ignored: {(probe.get('speak_response') or {}).get('ignored')}"
        )
        out.append(
            f"- Transcript endpoint during the session: status {transcript.get('status')} in {transcript.get('ms')} ms, "
            f"avatar lines {transcript.get('avatar_lines')}, user lines {transcript.get('user_lines')}, "
            f"has the exact line {transcript.get('has_exact')}"
        )
        for key, title in (("idle_end", "Idle session"), ("max_duration", "max_session_duration")):
            cell = probe.get(key) or {}
            out.append(
                f"- {title}: stopped {cell.get('stopped')} after {cell.get('seconds')} s"
                + (f" (asked {cell.get('requested_seconds')} s)" if cell.get("requested_seconds") else "")
                + f", end_reason {cell.get('end_reason')}"
            )
        out.append(
            f"- user.transcription events {probe.get('user_transcriptions')}; microphone requests "
            f"{probe.get('mic_requests')}; audio tracks published {probe.get('audio_senders')}"
            + (f"; error {probe['error']}" if probe.get("error") else "")
        )
        out.append("")
    call = face.get("call") or {}
    polly = face.get("polly") or {}
    if call:
        session = call.get("session") or {}
        fallback = call.get("fallback") or {}
        out.append("In-app call (the seeded founder, a platform admin of the synthetic venture):")
        out.append(
            f"- Face: {session.get('provider')} / {session.get('voicing')}, stock {session.get('stock_face')}, "
            f'LiveKit host {session.get("livekit_host")}; "AI avatar" label visible {call.get("label_visible")}'
        )
        out.append(
            f"- After the turn was sent: first face audio (level onset) {_p(call.get('first_face_audio_ms'))}, "
            f"first face speak_started {_p(call.get('first_speak_started_ms'))}; Polly alone (no face): first audio "
            f"(level onset, same meter) {_p(polly.get('first_audio_ms'))}, first buffer scheduled "
            f"{_p(polly.get('first_scheduled_ms'))}"
        )
        out.append(
            f"- First spoken unit arrives {_p(call.get('first_unit_ms'))} after the turn was sent; → its hand-over "
            f"to the face {_p(call.get('unit_to_hand_over_ms'))}; units pre-approved as signed "
            f"{call.get('units_preapproved')} of {call.get('units_streamed')}"
        )
        out.append(
            f"- Each unit, publish → speak_started {_p(call.get('publish_to_started_ms'))}; → first audio "
            f"{_p(call.get('publish_to_audio_ms'))}; speak_text sent {call.get('speak_text_sent')}, face/say "
            f"requests {call.get('say_requests')}, the call's own playback after the face joined "
            f"{call.get('app_playbacks_after_live')}"
        )
        out.append(
            f"- Microphone requests after the face joined {call.get('mic_requests_after_live')}; audio tracks "
            f"published {call.get('audio_senders')}; user.transcription events {call.get('user_transcriptions')}"
        )
        out.append(
            f"- Avatar audio and video in one remote stream (WebRTC lip sync applies): {call.get('av_same_stream')}"
        )
        out.append(
            f"- Session end: presence back {fallback.get('presence_back')} after {fallback.get('seconds_live')} s "
            f"live, end_reason {fallback.get('end_reason')}, typed line still editable "
            f"{fallback.get('typed_line_editable')}"
            + (f"; error {call['error']}" if call.get("error") else "")
        )
        out.append("")
    lite = face.get("call_lite") or {}
    if lite:
        session = lite.get("session") or {}
        out.append(
            "In-app call, LITE (the same founder turns; the avatar lip-syncs the call's Polly audio, relayed by the "
            "server over the speak socket):"
        )
        out.append(
            f"- Face: {session.get('provider')} / {session.get('voicing')}, stock {session.get('stock_face')}, "
            f"LiveKit host {session.get('livekit_host')}; shown {lite.get('face_shown')}; face reference "
            f"{face.get('lite_face_reference')}"
        )
        out.append(
            f"- Each unit, face/speak → answered {_p(lite.get('hand_over_to_done_ms'))}; → speak_started "
            f"{_p(lite.get('hand_over_to_started_ms'))}; → first audio {_p(lite.get('hand_over_to_audio_ms'))}; "
            f"face/speak requests {lite.get('speak_requests')} (answered 204: {lite.get('speak_accepted')}), the "
            f"call's own playback after the face joined {lite.get('app_playbacks_after_live')}"
        )
        out.append(
            f"- Microphone requests after the face joined {lite.get('mic_requests_after_live')}; audio tracks "
            f"published {lite.get('audio_senders')}"
            + (f"; error {lite['error']}" if lite.get("error") else "")
        )
        out.append("")
    injection = face.get("injection") or {}
    if injection:
        out.append(
            f"Injection (a tampered page's speak_text): injected {injection.get('injected')}; face ended "
            f"{injection.get('face_ended')} after {injection.get('seconds_to_end')} s (heartbeat "
            f"{injection.get('heartbeat_seconds')} s), injected {injection.get('seconds_into_session')} s into the "
            f"session; call.face_injection audits {injection.get('audit_injection_events')} (heartbeat "
            f"{injection.get('audit_heartbeat_events')}, after the face ended {injection.get('audit_at_end_events')}"
            f"); vendor end_reason {injection.get('end_reason')}"
            + (f"; error {injection['error']}" if injection.get("error") else "")
        )
        out.append("")
    return out


def _face_comparison(face: Mapping[str, Any]) -> list[str]:
    """The in-app arms side by side (conversation_lab/face.py comparison): FULL, LITE and Polly alone."""
    table = face.get("comparison") or {}
    rows: Sequence[Mapping[str, Any]] = table.get("rows") or []
    if not any(row.get(arm) for row in rows for arm in ("full", "lite", "polly")):
        return []
    out = [
        "In-app arms side by side (the same founder turns, the same meters; p50 / p95 in ms, n):",
        "",
        "| Moment | FULL | LITE | Polly only |",
        "| --- | --- | --- | --- |",
    ]
    for row in rows:
        cells = [_p_short(row.get(arm)) for arm in ("full", "lite", "polly")]
        out.append(f"| {row.get('title')} | {' | '.join(cells)} |")
    out.append("")
    delta = table.get("lite_minus_full_first_audio_p50_ms")
    if delta is not None:
        out.append(
            f"First audio at p50: LITE minus FULL {delta:+d} ms (faster: {table.get('faster_first_audio')}); "
            f"FULL minus Polly {_signed(table.get('full_minus_polly_first_audio_p50_ms'))}, LITE minus Polly "
            f"{_signed(table.get('lite_minus_polly_first_audio_p50_ms'))}."
        )
        out.append("")
    return out


def _p_short(cell: Mapping[str, Any] | None) -> str:
    return "-" if not cell else f"{cell['p50']} / {cell['p95']} (n={cell['n']})"


def _signed(value: Any) -> str:
    return "-" if not isinstance(value, int) else f"{value:+d} ms"


def _suite_tables(suite: str, result: Mapping[str, Any]) -> list[str]:
    out: list[str] = []
    if suite == "agenda":
        return _agenda_tables(result)
    if suite == "safety":
        return _safety_tables(result)
    if suite == "face":
        return _face_tables(result.get("face") or {})
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
