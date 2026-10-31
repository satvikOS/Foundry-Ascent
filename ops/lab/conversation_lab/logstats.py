"""What the app's own logs say about a run, as public-safe numbers (the API's log lines carry ids, codes, counts and
timings only, by its logging contract; this module keeps only event names, purposes, outcomes, codes and numbers,
and drops any code that does not look like one).

* model attempts per purpose: first attempts, how many ended `invalid_output` (and the share), retries, fallbacks,
  the validation issue codes (`path: code`) grouped, and how often `(root): max_tokens` appears;
* turn timing (server): total and first speech, p50/p95; Polly first audio per unit; a FULL face's pre-approval of
  each spoken unit as it is signed (`turn.face_approval`), p50/p95 and how many units it admitted;
* streamed turns that fell back to a whole reply, by reason; interrupt requests.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

#: An issue or note code as the API logs it: a JSON path, a colon and a code, or a bare snake_case code.
SAFE_CODE = re.compile(r"^[A-Za-z0-9_().\[\]: -]{1,80}$")


def _percentiles(values: Sequence[float]) -> dict[str, float] | None:
    if not values:
        return None
    ordered = sorted(values)

    def at(q: float) -> float:
        return round(ordered[min(len(ordered), max(1, math.ceil(q * len(ordered)))) - 1], 1)

    return {"p50": at(0.5), "p95": at(0.95), "n": len(ordered)}


def _events(lines: Iterable[str]) -> Iterable[dict[str, Any]]:
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def _codes(value: Any) -> list[str]:
    raw = value.split(",") if isinstance(value, str) else value if isinstance(value, list) else []
    return [c.strip() for c in raw if isinstance(c, str) and SAFE_CODE.match(c.strip())]


#: Per-turn server stages from `turn.timing` (apps/api/src/http/turn-timing.ts). Offsets since the request
#: reached the API: modelStartMs, firstDeltaMs, firstSpeechMs, totalMs. Durations: retrievalMs (embedding wait +
#: queries), embedMs (every embedding call of the request, including any after the reply), modelFirstTokenMs
#: (model start → first token, i.e. time to first token).
TURN_STAGES = (
    "retrievalMs",
    "embedMs",
    "modelStartMs",
    "modelFirstTokenMs",
    "firstDeltaMs",
    "firstSpeechMs",
    "totalMs",
)


def _ms(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _epoch_ms(stamp: Any) -> float | None:
    from datetime import datetime

    if not isinstance(stamp, str):
        return None
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def turn_breakdown(events: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every turn's server stages, when the model's first token arrived (offset), the gap from it to the first
    released words (the gate's hold), and the Polly first-audio time of the first speech request after the
    turn's first speech (numbers only)."""
    speech = sorted(
        (t, _ms(e.get("firstAudioMs")))
        for e in events
        if (e.get("event") or e.get("msg")) == "speech.timing" and (t := _epoch_ms(e.get("time"))) is not None
    )
    turns = []
    for e in events:
        if (e.get("event") or e.get("msg")) != "turn.timing":
            continue
        row: dict[str, Any] = {"voice": bool(e.get("voice"))}
        for stage in TURN_STAGES:
            row[stage] = _ms(e.get(stage))
        model_start, ttft, first_delta = row["modelStartMs"], row["modelFirstTokenMs"], row["firstDeltaMs"]
        first_token_at = model_start + ttft if model_start is not None and ttft is not None else None
        row["modelFirstTokenAtMs"] = first_token_at
        row["firstTokenToDeltaMs"] = (
            round(first_delta - first_token_at)
            if first_token_at is not None and first_delta is not None
            else None
        )
        end, total, first_speech = _epoch_ms(e.get("time")), row["totalMs"], row["firstSpeechMs"]
        row["pollyFirstAudioMs"] = None
        if end is not None and total is not None and first_speech is not None and row["voice"]:
            spoke_at = end - total + first_speech
            after = [audio for t, audio in speech if t >= spoke_at - 50]
            row["pollyFirstAudioMs"] = after[0] if after else None
        turns.append(row)
    return turns


def summarize(lines: Iterable[str]) -> dict[str, Any]:
    purposes: dict[str, Counter[str]] = {}
    issues: Counter[str] = Counter()
    fallbacks: Counter[str] = Counter()
    total_ms: list[float] = []
    first_speech_ms: list[float] = []
    voice_total_ms: list[float] = []
    first_audio_ms: list[float] = []
    face_approval_ms: list[float] = []
    face_approved = 0
    interrupts = 0
    events = list(_events(lines))
    for e in events:
        name = e.get("event") or e.get("msg")
        if name == "ai.model.attempt":
            purpose = str(e.get("purpose") or "unknown")
            if not SAFE_CODE.match(purpose):
                continue
            c = purposes.setdefault(purpose, Counter())
            kind, outcome = str(e.get("kind") or ""), str(e.get("outcome") or "")
            c["attempts"] += 1
            if kind == "initial":
                c["first_attempts"] += 1
                if outcome == "invalid_output":
                    c["first_invalid_output"] += 1
            if outcome == "invalid_output":
                c["invalid_output"] += 1
                issues.update(_codes(e.get("issues")))
            if kind and kind != "initial":
                c[f"kind:{kind}" if SAFE_CODE.match(kind) else "kind:other"] += 1
        elif name == "turn.timing":
            if isinstance(e.get("totalMs"), int | float):
                (voice_total_ms if e.get("voice") else total_ms).append(float(e["totalMs"]))
            if isinstance(e.get("firstSpeechMs"), int | float) and e.get("voice"):
                first_speech_ms.append(float(e["firstSpeechMs"]))
        elif name == "speech.timing":
            if isinstance(e.get("firstAudioMs"), int | float):
                first_audio_ms.append(float(e["firstAudioMs"]))
        elif name == "turn.face_approval":
            if isinstance(e.get("ms"), int | float) and not isinstance(e.get("ms"), bool):
                face_approval_ms.append(float(e["ms"]))
            face_approved += 1 if e.get("approved") is True else 0
        elif name == "turn.stream_fallback":
            reason = str(e.get("fallback") or e.get("reason") or "unknown")
            fallbacks[reason if SAFE_CODE.match(reason) else "other"] += 1
        elif name == "http.request" and str(e.get("route", "")).endswith("/interrupt"):
            interrupts += 1
    by_purpose = {}
    for purpose, c in sorted(purposes.items()):
        first = c["first_attempts"]
        by_purpose[purpose] = {
            **dict(sorted(c.items())),
            "first_invalid_share_pct": round(100 * c["first_invalid_output"] / first, 1) if first else None,
        }
    return {
        "model_attempts": by_purpose,
        "invalid_output_issues": dict(issues.most_common(15)),
        "root_max_tokens": sum(
            n for code, n in issues.items() if code.replace(" ", "") == "(root):max_tokens"
        ),
        "turn_total_ms": {"chat": _percentiles(total_ms), "voice": _percentiles(voice_total_ms)},
        "voice_first_speech_ms": _percentiles(first_speech_ms),
        "polly_first_audio_ms": _percentiles(first_audio_ms),
        # What admitting each unit to a FULL face held it on the server before it was sent (and how many it admitted).
        "face_approval_ms": _percentiles(face_approval_ms),
        "face_units_approved": face_approved,
        "stream_fallbacks": dict(fallbacks),
        "interrupt_requests": interrupts,
        "turns": turn_breakdown(events),
    }


def from_file(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    with path.open(encoding="utf-8", errors="replace") as fh:
        return summarize(fh)
