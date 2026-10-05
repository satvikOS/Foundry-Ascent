from __future__ import annotations

from typing import Any

import pytest

from foundry_evals.models import TurnBlocked, TurnCompleted, TurnError
from foundry_evals.sse import SseParser, SseProtocolError, TurnStreamReader, parse_sse, read_turn_stream
from tests.sse_helpers import TURN_ID, blocked_stream, chunked, completed_stream, error_stream, frame


class TestParser:
    def test_basic_events_comments_and_defaults(self) -> None:
        messages, parser = parse_sse([b": hello\n\nevent: a\ndata: 1\n\ndata: 2\n\n"])
        assert [(m.event, m.data) for m in messages] == [("a", "1"), ("message", "2")]
        assert parser.comments == 1

    def test_multiline_data_and_space_stripping(self) -> None:
        messages, _ = parse_sse([b"data:first\ndata:  second\ndata\n\n"])
        assert messages[0].data == "first\n second\n"

    @pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
    def test_line_endings(self, newline: str) -> None:
        text = f"event: x{newline}data: y{newline}{newline}"
        messages, _ = parse_sse([text.encode()])
        assert [(m.event, m.data) for m in messages] == [("x", "y")]

    def test_crlf_split_across_chunks_is_one_line_break(self) -> None:
        messages, _ = parse_sse([b"event: x\r", b"\ndata: y\r", b"\n\r", b"\n"])
        assert [(m.event, m.data) for m in messages] == [("x", "y")]

    def test_utf8_split_inside_multibyte_character(self) -> None:
        raw = "data: café — ✓\n\n".encode()
        cut = raw.index("é".encode()) + 1
        messages, _ = parse_sse([raw[:cut], raw[cut:]])
        assert messages[0].data == "café — ✓"

    def test_leading_bom_is_ignored(self) -> None:
        messages, _ = parse_sse(["﻿event: x\ndata: 1\n\n".encode()])
        assert messages[0].event == "x"

    def test_unterminated_event_is_discarded(self) -> None:
        messages, parser = parse_sse([b"event: x\ndata: 1\n\nevent: y\ndata: 2"])
        assert [m.event for m in messages] == ["x"]
        assert parser.discarded_partial_event

    def test_id_and_retry_fields(self) -> None:
        messages, _ = parse_sse([b"id: 7\nretry: 1500\nretry: soon\ndata: z\n\n"])
        assert messages[0].id == "7"
        assert messages[0].retry == 1500

    def test_invalid_utf8_is_a_protocol_error(self) -> None:
        with pytest.raises(SseProtocolError):
            SseParser().feed(b"data: \xff\xfe\n\n")


class TestTurnStream:
    @pytest.mark.parametrize("size", [1, 3, 7, 64, 100_000])
    def test_completed_stream_any_chunking(self, turn_payload: dict[str, Any], size: int) -> None:
        result = read_turn_stream(chunked(completed_stream(turn_payload), size))
        assert isinstance(result.terminal, TurnCompleted)
        assert result.terminal.turn.id == turn_payload["id"]
        assert result.phases == ["classifying", "retrieving", "reasoning", "validating"]
        assert result.keepalives == 1
        assert not result.truncated

    def test_completed_stream_with_crlf(self, turn_payload: dict[str, Any]) -> None:
        result = read_turn_stream(chunked(completed_stream(turn_payload, newline="\r\n"), 5))
        assert isinstance(result.terminal, TurnCompleted)

    def test_blocked_stream(self) -> None:
        result = read_turn_stream([blocked_stream().encode()])
        assert isinstance(result.terminal, TurnBlocked)
        assert result.terminal.reason == "crisis_support"
        assert result.terminal.escalation_id is not None

    def test_error_after_acceptance(self) -> None:
        result = read_turn_stream([error_stream().encode()])
        assert isinstance(result.terminal, TurnError)
        assert result.terminal.retryable

    def test_error_before_acceptance(self) -> None:
        result = read_turn_stream([error_stream(None, code="rate_limited", retryable=False).encode()])
        assert isinstance(result.terminal, TurnError)
        assert result.accepted is None

    def test_truncated_stream(self, turn_payload: dict[str, Any]) -> None:
        text = completed_stream(turn_payload)
        result = read_turn_stream([text[: text.index("event: turn.completed")].encode()])
        assert result.truncated
        assert result.terminal is None

    def test_malformed_json_is_rejected_without_echoing_content(self) -> None:
        with pytest.raises(SseProtocolError) as info:
            read_turn_stream([b"event: turn.accepted\ndata: {secret content\n\n"])
        assert "secret" not in str(info.value)

    def test_contract_violation_names_fields_only(self) -> None:
        bad = frame("turn.accepted", {"turnId": TURN_ID})  # ordinal missing
        with pytest.raises(SseProtocolError, match="ordinal"):
            read_turn_stream([bad.encode()])

    def test_event_name_must_match_payload(self) -> None:
        text = frame("turn.accepted", {"turnId": TURN_ID, "ordinal": 1}).replace(
            "event: turn.accepted", "event: turn.status"
        )
        with pytest.raises(SseProtocolError, match="disagrees"):
            read_turn_stream([text.encode()])

    def test_status_before_acceptance_is_rejected(self) -> None:
        text = frame("turn.status", {"phase": "reasoning", "detail": None, "evidenceCount": None})
        with pytest.raises(SseProtocolError, match=r"before turn\.accepted"):
            read_turn_stream([text.encode()])

    def test_frames_after_terminal_are_rejected(self) -> None:
        text = blocked_stream() + frame(
            "turn.status", {"phase": "reasoning", "detail": None, "evidenceCount": None}
        )
        with pytest.raises(SseProtocolError, match="after the terminal"):
            read_turn_stream([text.encode()])

    def test_completed_for_another_turn_is_rejected(self, turn_payload: dict[str, Any]) -> None:
        text = frame(
            "turn.accepted", {"turnId": "00000000-0000-4000-8000-00000000ffff", "ordinal": 1}
        ) + frame("turn.completed", {"turn": turn_payload})
        with pytest.raises(SseProtocolError, match="different turn"):
            read_turn_stream([text.encode()])

    def test_incremental_reader_reports_done(self) -> None:
        reader = TurnStreamReader()
        for chunk in chunked(blocked_stream(), 4):
            reader.feed(chunk)
        assert reader.done
