"""The voice suite around the browser run (apps/web/e2e/lab/voice.lab.ts): before it, Amazon Polly renders the
founder's lines to WAV files (line 1 becomes Chromium's fake microphone file); after it, the transcripts the app
sent are scored against the script (word error rate) and the timings the page recorded become latencies."""

from __future__ import annotations

import json
import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from conversation_lab.audio import duration_seconds, padded, wav
from conversation_lab.budget import Ledger, SpendGuard
from conversation_lab.config import SCENARIOS_DIR
from conversation_lab.polly import PollyClient, synthesize_pcm
from conversation_lab.wer import wer

#: Silence after an injected line (the app's end-of-turn detection needs 600 ms of it).
INJECTED_LEAD_SECONDS = 0.3
#: A line whose transcript is this far off counts as misheard.
WER_PASS = 0.25


def load_voice(path: Path = SCENARIOS_DIR / "voice.json") -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def prepare(
    script: Mapping[str, Any],
    out_dir: Path,
    *,
    client: PollyClient,
    guard: SpendGuard,
    ledger: Ledger,
    usd_per_million: float,
) -> dict[str, Any]:
    """Writes one WAV per line and a manifest the browser run reads; returns the manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = []
    for index, line in enumerate(script["lines"]):
        pcm = synthesize_pcm(
            client, line["text"], guard=guard, ledger=ledger, usd_per_million=usd_per_million
        )
        lead = float(script["leadSilenceSeconds"]) if index == 0 else INJECTED_LEAD_SECONDS
        audio = padded(pcm, lead=lead, tail=float(script["tailSilenceSeconds"]))
        path = out_dir / f"{line['id']}.wav"
        path.write_bytes(wav(audio))
        lines.append(
            {
                "id": line["id"],
                "file": str(path),
                "speechSeconds": round(duration_seconds(pcm), 3),
                "leadSeconds": lead,
                "bargeIn": bool(line.get("bargeIn", False)),
                "bargeInDelayMs": int(line.get("bargeInDelayMs", 0)),
            }
        )
    manifest = {"deviceFile": lines[0]["file"], "lines": lines}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


#: A transcript further off than this is not the line at all (a missed line must not take a later transcript).
ALIGN_MAX_WER = 0.6


def align(script: Sequence[str], transcripts: Sequence[str]) -> list[tuple[int, str | None, float | None]]:
    """Each script line with the transcript (in order) that matches it best among the next two not yet used: a
    misheard, merged or missing line must not shift every later line onto the wrong transcript."""
    out: list[tuple[int, str | None, float | None]] = []
    cursor = 0
    for index, line in enumerate(script):
        best: tuple[float, int] | None = None
        for j in range(cursor, min(cursor + 2, len(transcripts))):
            score = wer(line, transcripts[j])
            if best is None or score < best[0]:
                best = (score, j)
        if best is None or best[0] > ALIGN_MAX_WER:
            out.append((index, None, None))
            continue
        out.append((index, transcripts[best[1]], best[0]))
        cursor = best[1] + 1
    return out


def percentile(values: Sequence[float], q: float) -> float | None:
    """Nearest-rank percentile (the app's client stats use the same method)."""
    if not values:
        return None
    ordered = sorted(values)
    rank = min(len(ordered), max(1, math.ceil(q * len(ordered))))
    return round(ordered[rank - 1], 1)


@dataclass
class VoiceResult:
    input_mode: str | None = None
    lines: list[dict[str, Any]] = field(default_factory=list)
    first_audio_ms: list[float] = field(default_factory=list)
    endpoint_ms: list[float] = field(default_factory=list)
    reply_ms: list[float] = field(default_factory=list)
    barge_in: dict[str, Any] = field(default_factory=dict)
    client_stats: dict[str, Any] | None = None
    error: str | None = None
    passed: bool = False
    reason: str = "not_run"

    def public(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "reason": self.reason,
            "error": self.error,
            "input_mode": self.input_mode,
            "lines": self.lines,
            "mean_wer": round(statistics.fmean([x["wer"] for x in self.lines if x["wer"] is not None]), 4)
            if any(x["wer"] is not None for x in self.lines)
            else None,
            "first_audio_ms": {
                "p50": percentile(self.first_audio_ms, 0.5),
                "p95": percentile(self.first_audio_ms, 0.95),
            },
            "end_of_speech_to_turn_ms": {
                "p50": percentile(self.endpoint_ms, 0.5),
                "p95": percentile(self.endpoint_ms, 0.95),
            },
            "turn_to_first_audio_ms": {
                "p50": percentile(self.reply_ms, 0.5),
                "p95": percentile(self.reply_ms, 0.95),
            },
            "barge_in": self.barge_in,
            "client_stats": self.client_stats,
        }


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def score(script: Mapping[str, Any], captured: Mapping[str, Any] | None) -> VoiceResult:
    result = VoiceResult()
    if captured is None:
        result.reason = "not_captured"
        return result
    result.input_mode = captured.get("inputMode") if isinstance(captured.get("inputMode"), str) else None
    if captured.get("error"):
        result.error = str(captured["error"])[:64]
    texts = [line["text"] for line in script["lines"]]
    transcripts = [str(t) for t in captured.get("transcripts", [])]
    timings = {str(t.get("id")): t for t in captured.get("lines", []) if isinstance(t, dict)}
    for index, transcript, line_wer in align(texts, transcripts):
        line = script["lines"][index]
        t = timings.get(line["id"], {})
        ended, posted, audio = (_number(t.get(k)) for k in ("speechEndedAt", "turnPostedAt", "firstAudioAt"))
        row: dict[str, Any] = {
            "id": line["id"],
            "wer": line_wer,
            "heard": transcript is not None,
            "end_of_speech_to_turn_ms": None,
            "turn_to_first_audio_ms": None,
            "first_audio_ms": None,
        }
        if ended is not None and posted is not None and posted >= ended:
            row["end_of_speech_to_turn_ms"] = round(posted - ended)
            result.endpoint_ms.append(posted - ended)
        if posted is not None and audio is not None and audio >= posted:
            row["turn_to_first_audio_ms"] = round(audio - posted)
            result.reply_ms.append(audio - posted)
        if ended is not None and audio is not None and audio >= ended:
            row["first_audio_ms"] = round(audio - ended)
            result.first_audio_ms.append(audio - ended)
        result.lines.append(row)
    barge = captured.get("bargeIn") if isinstance(captured.get("bargeIn"), dict) else {}
    started, stopped = _number(barge.get("injectedAt")), _number(barge.get("playbackStoppedAt"))
    result.barge_in = {
        "attempted": bool(barge),
        "interrupt_sent": bool(barge.get("interruptSent")),
        "reply_was_playing": bool(barge.get("replyWasPlaying")),
        "stop_ms": round(stopped - started)
        if started is not None and stopped is not None and stopped >= started
        else None,
    }
    stats = captured.get("clientStats")
    if isinstance(stats, dict):
        result.client_stats = {
            k: _number(stats.get(k)) for k in ("firstAudioMsP50", "firstAudioMsP95", "bargeIns", "reconnects")
        }
    result.passed, result.reason = _decide(result)
    return result


def _decide(result: VoiceResult) -> tuple[bool, str]:
    if result.input_mode != "transcribe":
        return False, "no_voice_input"
    if result.error:
        return False, "run_error"
    if not result.lines or any(not row["heard"] for row in result.lines):
        return False, "line_not_heard"
    if any(row["wer"] is None or row["wer"] > WER_PASS for row in result.lines):
        return False, "misheard"
    if not result.first_audio_ms:
        return False, "no_audio"
    if result.barge_in.get("attempted") and not result.barge_in.get("interrupt_sent"):
        return False, "barge_in_missed"
    return True, "pass"
