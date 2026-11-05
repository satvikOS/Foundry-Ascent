"""An in-process stand-in for the app, for unit tests and the infrastructure-only smoke run (``live-smoke``). It
implements the founder API calls the runner makes with canned, deterministic coach replies. Nothing it produces is
behavioural evidence: every summary built on it is labelled infrastructure-only.
"""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from foundry_evals.client import TurnOutcome


@dataclass
class FakeApp:
    """Shared state: memory per venture, sessions, documents. ``replies`` overrides the canned coach reply."""

    memory: dict[str, list[SimpleNamespace]] = field(default_factory=dict)
    documents: dict[str, list[SimpleNamespace]] = field(default_factory=dict)
    aged: list[tuple[str, int]] = field(default_factory=list)
    replies: Any = None
    fail_on: str | None = None
    _ids: Any = field(default_factory=lambda: itertools.count(1))

    def next_id(self, prefix: str) -> str:
        return f"{prefix}-{next(self._ids)}"

    def founder_client(self, principal_id: str) -> FakeClient:
        return FakeClient(self, principal_id)

    def between_sessions(self, session_id: str, gap_days: int) -> str | None:
        self.aged.append((session_id, gap_days))
        return None

    def wait_distilled(self, session_id: str) -> str | None:
        return None


def canned_reply(text: str) -> str:
    words = re.findall(r"[A-Za-z']+", text)
    topic = " ".join(words[:6]).lower() or "that"
    return f"Thanks, that helps. On {topic}: what have you seen people actually do so far?"


class FakeClient:
    def __init__(self, app: FakeApp, principal_id: str) -> None:
        self.app = app
        self.principal_id = principal_id
        self.turns: list[str] = []

    def close(self) -> None:
        return None

    # memory
    def create_memory(
        self, venture_id: str, *, memory_type: str, title: str, content: str, visibility: str = "venture"
    ) -> Any:
        item = SimpleNamespace(
            id=self.app.next_id("mem"),
            title=title,
            content=content,
            status="confirmed",
            origin="founder",
            type=memory_type,
        )
        self.app.memory.setdefault(venture_id, []).append(item)
        return item

    def list_memory(self, venture_id: str, *, q: str | None = None) -> list[Any]:
        return [m for m in self.app.memory.get(venture_id, []) if m.status not in ("deleted", "rejected")]

    def delete_memory(self, memory_id: str) -> None:
        for items in self.app.memory.values():
            for m in items:
                if m.id == memory_id:
                    m.status = "deleted"

    def request(
        self, method: str, path: str, *, json_body: Any = None, idempotency_key: str | None = None, **_: Any
    ) -> Any:
        found = re.fullmatch(r"/memory/([\w-]+)", path)
        if method == "PATCH" and found:
            for items in self.app.memory.values():
                for m in items:
                    if m.id == found.group(1):
                        if json_body["action"] == "reject":
                            m.status = "rejected"
                        elif json_body["action"] == "correct":
                            m.content = json_body["patch"]["content"]
        return SimpleNamespace(status_code=200, json=dict)

    # documents
    def create_document_upload(
        self, venture_id: str, *, filename: str, content_type: str, size_bytes: int
    ) -> Any:
        doc = SimpleNamespace(id=self.app.next_id("doc"), filename=filename, status="pending_upload")
        self.app.documents.setdefault(venture_id, []).append(doc)
        return SimpleNamespace(document=doc, upload=SimpleNamespace(url="http://fake/upload", headers={}))

    def upload_presigned(self, url: str, headers: Any, body: bytes) -> None:
        return None

    def complete_document(self, document_id: str) -> Any:
        for docs in self.app.documents.values():
            for d in docs:
                if d.id == document_id:
                    d.status = "ready"
        return None

    def list_documents(self, venture_id: str) -> list[Any]:
        return list(self.app.documents.get(venture_id, []))

    # sessions and calls
    def create_session(self, venture_id: str, *, mode: str, privacy: str = "ephemeral") -> Any:
        opener = "Good to see you again. Where would you like to start?" if self.turns else None
        return SimpleNamespace(id=self.app.next_id("ses"), opener=opener)

    def end_session(self, session_id: str) -> None:
        return None

    def start_call(self, session_id: str) -> Any:
        return SimpleNamespace(call=SimpleNamespace(id=self.app.next_id("call")), intro=None)

    def end_call(self, call_id: str) -> None:
        return None

    def interrupt_turn(self, turn_id: str, call_id: str, heard: list[str]) -> None:
        return None

    def run_turn(self, session_id: str, text: str, *, call_id: str | None = None, **_: Any) -> TurnOutcome:
        self.turns.append(text)
        if self.app.fail_on and self.app.fail_on in text:
            return TurnOutcome(kind="error", error_code="model_error", duration_seconds=0.1)
        answer = self.app.replies(text) if callable(self.app.replies) else canned_reply(text)
        units = [u.strip() for u in re.split(r"(?<=[.!?])\s+", answer) if u.strip()] if call_id else []
        response = SimpleNamespace(
            answer=answer, spoken=answer if call_id else None, escalation=SimpleNamespace(required=False)
        )
        turn = SimpleNamespace(response=response, usage=SimpleNamespace(model_id="mock"), validator=None)
        return TurnOutcome(
            kind="completed", turn_id=self.app.next_id("turn"), turn=turn, duration_seconds=0.05, speech=units
        )
