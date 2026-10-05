"""Builders for turn-stream fixtures (the exact wire format of apps/api/src/http/turn-stream.ts)."""

from __future__ import annotations

import json
from typing import Any

TURN_ID = "6d0f8f8e-1a7b-4c1e-9a43-0c4e3a0d5b11"


def frame(event: str, payload: dict[str, Any], *, newline: str = "\n") -> str:
    body = json.dumps({"event": event, **payload})
    return f"event: {event}{newline}data: {body}{newline}{newline}"


def completed_stream(turn: dict[str, Any], *, newline: str = "\n", keepalive: bool = True) -> str:
    parts = [
        frame("turn.accepted", {"turnId": turn["id"], "ordinal": turn["ordinal"]}, newline=newline),
        frame(
            "turn.status", {"phase": "classifying", "detail": None, "evidenceCount": None}, newline=newline
        ),
    ]
    if keepalive:
        parts.append(f": keep-alive{newline}{newline}")
    parts += [
        frame(
            "turn.status",
            {"phase": "retrieving", "detail": None, "evidenceCount": len(turn["evidence"])},
            newline=newline,
        ),
        frame("turn.status", {"phase": "reasoning", "detail": None, "evidenceCount": None}, newline=newline),
        frame("turn.status", {"phase": "validating", "detail": None, "evidenceCount": None}, newline=newline),
        frame("turn.completed", {"turn": turn}, newline=newline),
    ]
    return "".join(parts)


def blocked_stream(
    turn_id: str = TURN_ID, *, reason: str = "crisis_support", support: str | None = "Call 988."
) -> str:
    return frame("turn.accepted", {"turnId": turn_id, "ordinal": 1}) + frame(
        "turn.blocked",
        {
            "turnId": turn_id,
            "reason": reason,
            "escalationId": "9e9e9e9e-0000-4000-8000-000000000001",
            "supportMessage": support,
        },
    )


def error_stream(
    turn_id: str | None = TURN_ID, *, code: str = "model_unavailable", retryable: bool = True
) -> str:
    accepted = frame("turn.accepted", {"turnId": turn_id, "ordinal": 1}) if turn_id else ""
    return accepted + frame(
        "turn.error",
        {"turnId": turn_id, "code": code, "message": "Please try again.", "retryable": retryable},
    )


def chunked(text: str, size: int) -> list[bytes]:
    data = text.encode("utf-8")
    return [data[i : i + size] for i in range(0, len(data), size)]
