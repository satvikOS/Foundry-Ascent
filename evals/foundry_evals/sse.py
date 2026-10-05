"""Server-sent events: an incremental WHATWG ``text/event-stream`` parser and the turn-stream reader.

The API streams ``POST /sessions/:id/turns`` as ``event: <name>`` + ``data: <json>`` frames, with
``: keep-alive`` comments every 15 s (system design §6.1; apps/api/src/http/turn-stream.ts). The parser
follows the HTML Living Standard event-stream interpretation rules: UTF-8 decoding across chunk
boundaries, CRLF / LF / CR line endings (including a CR at the end of one chunk and LF at the start of
the next), a leading BOM, comments, multi-line ``data`` fields and single-space stripping after the
colon. An event that is not terminated by a blank line before the stream ends is discarded, as the
standard requires; the reader then reports the stream as truncated.
"""

from __future__ import annotations

import codecs
import json
from collections.abc import Iterable
from dataclasses import dataclass, field

from pydantic import ValidationError

from foundry_evals.models import (
    TURN_STREAM_EVENT_ADAPTER,
    TurnAccepted,
    TurnBlocked,
    TurnCompleted,
    TurnError,
    TurnStatus,
    TurnStreamEvent,
)


class SseProtocolError(Exception):
    """The stream violated the turn-stream contract. Messages never include payload content."""


@dataclass(frozen=True)
class SseMessage:
    event: str
    data: str
    id: str | None = None
    retry: int | None = None


class SseParser:
    """Incremental event-stream parser: ``feed`` bytes as they arrive, then ``close``."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        self._buffer = ""
        self._started = False
        self._event = ""
        self._data: list[str] = []
        self._last_id: str | None = None
        self._retry: int | None = None
        self.comments = 0
        self.discarded_partial_event = False

    def feed(self, chunk: bytes) -> list[SseMessage]:
        try:
            text = self._decoder.decode(chunk)
        except UnicodeDecodeError as exc:
            raise SseProtocolError("event stream is not valid UTF-8") from exc
        return self._consume(text, final=False)

    def close(self) -> list[SseMessage]:
        try:
            text = self._decoder.decode(b"", final=True)
        except UnicodeDecodeError as exc:
            raise SseProtocolError("event stream ended inside a UTF-8 sequence") from exc
        messages = self._consume(text, final=True)
        if self._buffer:
            # A final line without a terminator still belongs to the pending event.
            self._process_line(self._buffer, messages)
            self._buffer = ""
        if self._data or self._event:
            self.discarded_partial_event = True
            self._event = ""
            self._data = []
        return messages

    def _consume(self, text: str, *, final: bool) -> list[SseMessage]:
        if not self._started and text:
            self._started = True
            if text.startswith("﻿"):
                text = text[1:]
        self._buffer += text
        messages: list[SseMessage] = []
        start = 0
        buffer = self._buffer
        length = len(buffer)
        i = 0
        while i < length:
            ch = buffer[i]
            if ch == "\n":
                self._process_line(buffer[start:i], messages)
                i += 1
                start = i
            elif ch == "\r":
                if i + 1 < length:
                    self._process_line(buffer[start:i], messages)
                    i += 2 if buffer[i + 1] == "\n" else 1
                    start = i
                elif final:
                    self._process_line(buffer[start:i], messages)
                    i += 1
                    start = i
                else:
                    break  # wait: the next chunk may start with the LF of a CRLF pair
            else:
                i += 1
        self._buffer = buffer[start:]
        return messages

    def _process_line(self, line: str, out: list[SseMessage]) -> None:
        if line == "":
            self._dispatch(out)
            return
        if line.startswith(":"):
            self.comments += 1
            return
        name, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        elif name == "id":
            if "\x00" not in value:
                self._last_id = value
        elif name == "retry" and value.isdigit():
            self._retry = int(value)
        # Unknown field names are ignored (standard behaviour).

    def _dispatch(self, out: list[SseMessage]) -> None:
        if not self._data:
            self._event = ""
            return
        out.append(
            SseMessage(
                event=self._event or "message",
                data="\n".join(self._data),
                id=self._last_id,
                retry=self._retry,
            )
        )
        self._event = ""
        self._data = []


def parse_sse(chunks: Iterable[bytes]) -> tuple[list[SseMessage], SseParser]:
    """Parses a complete stream (fixtures, tests). Returns the messages and the parser state."""
    parser = SseParser()
    messages: list[SseMessage] = []
    for chunk in chunks:
        messages.extend(parser.feed(chunk))
    messages.extend(parser.close())
    return messages, parser


def decode_turn_event(message: SseMessage) -> TurnStreamEvent:
    """Validates one SSE frame against the TurnStreamEvent contract."""
    try:
        payload = json.loads(message.data)
    except json.JSONDecodeError as exc:
        raise SseProtocolError(f"frame '{message.event}' carries invalid JSON") from exc
    if not isinstance(payload, dict):
        raise SseProtocolError(f"frame '{message.event}' is not a JSON object")
    try:
        event = TURN_STREAM_EVENT_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        fields = sorted({".".join(str(p) for p in err["loc"]) for err in exc.errors()})[:8]
        raise SseProtocolError(
            f"frame '{message.event}' does not match the turn-stream contract (fields: {', '.join(fields)})"
        ) from exc
    if message.event != event.event:
        raise SseProtocolError(f"SSE event name '{message.event}' disagrees with payload '{event.event}'")
    return event


@dataclass
class TurnStreamResult:
    """Everything a turn stream said, in order. ``terminal`` is None when the stream was truncated."""

    accepted: TurnAccepted | None = None
    statuses: list[TurnStatus] = field(default_factory=list)
    terminal: TurnCompleted | TurnBlocked | TurnError | None = None
    keepalives: int = 0
    frames: int = 0
    truncated: bool = False

    @property
    def phases(self) -> list[str]:
        return [s.phase for s in self.statuses]


class TurnStreamReader:
    """Consumes turn-stream bytes incrementally and enforces the event order contract:
    ``turn.accepted`` → ``turn.status``* → exactly one terminal event (or a lone pre-acceptance
    ``turn.error``). Frames after the terminal event are a protocol error.
    """

    def __init__(self) -> None:
        self._parser = SseParser()
        self.result = TurnStreamResult()

    @property
    def done(self) -> bool:
        return self.result.terminal is not None

    def feed(self, chunk: bytes) -> None:
        for message in self._parser.feed(chunk):
            self._handle(message)

    def close(self) -> TurnStreamResult:
        for message in self._parser.close():
            self._handle(message)
        self.result.keepalives = self._parser.comments
        if self.result.terminal is None:
            self.result.truncated = True
        return self.result

    def _handle(self, message: SseMessage) -> None:
        if message.event == "message" and message.data == "":
            return
        event = decode_turn_event(message)
        result = self.result
        result.frames += 1
        if result.terminal is not None:
            raise SseProtocolError(f"frame '{event.event}' after the terminal event")
        if isinstance(event, TurnAccepted):
            if result.accepted is not None:
                raise SseProtocolError("duplicate turn.accepted")
            result.accepted = event
            return
        if isinstance(event, TurnError) and result.accepted is None:
            result.terminal = event  # refused before acceptance
            return
        if result.accepted is None:
            raise SseProtocolError(f"frame '{event.event}' before turn.accepted")
        if isinstance(event, TurnStatus):
            result.statuses.append(event)
            return
        if isinstance(event, TurnCompleted) and event.turn.id != result.accepted.turn_id:
            raise SseProtocolError("turn.completed refers to a different turn than turn.accepted")
        if isinstance(event, TurnBlocked) and event.turn_id != result.accepted.turn_id:
            raise SseProtocolError("turn.blocked refers to a different turn than turn.accepted")
        result.terminal = event


def read_turn_stream(chunks: Iterable[bytes]) -> TurnStreamResult:
    """Reads a whole turn stream (used by tests and by the client)."""
    reader = TurnStreamReader()
    for chunk in chunks:
        reader.feed(chunk)
    return reader.close()
