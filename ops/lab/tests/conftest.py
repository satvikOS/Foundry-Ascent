"""Shared fixtures. Tests never touch the network or AWS: sockets are blocked for every test."""

from __future__ import annotations

import copy
import json
import socket
from pathlib import Path
from typing import Any

import pytest

from conversation_lab.budget import Ledger, SpendGuard
from conversation_lab.config import REPO, Price

EVALS_FIXTURES = REPO / "evals" / "tests" / "fixtures"


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def guard(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("network access is not allowed in unit tests")

    monkeypatch.setattr(socket.socket, "connect", guard)
    monkeypatch.setattr(socket, "create_connection", guard)


@pytest.fixture
def turn_payload() -> dict[str, Any]:
    """A completed TurnView as the API returns it (evals' fixture), safe to mutate."""
    return copy.deepcopy(json.loads((EVALS_FIXTURES / "turn_view.json").read_text(encoding="utf-8")))


PRICES = {"amazon.nova-pro-v1:0": Price(0.8, 3.2), "amazon.nova-premier-v1:0": Price(2.5, 12.5)}


@pytest.fixture
def ledger(tmp_path: Path) -> Ledger:
    return Ledger(tmp_path / "ledger.jsonl")


@pytest.fixture
def guard(ledger: Ledger) -> SpendGuard:
    return SpendGuard(app_budget=1.0, lab_budget=0.5, ledger=ledger)


class FakeConverse:
    """bedrock-runtime Converse stand-in: replies in order, records requests; an Exception reply is raised."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.requests.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        text, tokens_in, tokens_out = reply
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
            "usage": {
                "inputTokens": tokens_in,
                "outputTokens": tokens_out,
                "totalTokens": tokens_in + tokens_out,
            },
            "stopReason": "end_turn",
        }


class AwsError(Exception):
    """Shaped like botocore's ClientError (``response['Error']['Code']``)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.response = {"Error": {"Code": code, "Message": message}}
