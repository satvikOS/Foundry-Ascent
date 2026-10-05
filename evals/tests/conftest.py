"""Shared fixtures. Tests never touch the network: sockets are blocked for every test."""

from __future__ import annotations

import copy
import json
import socket
from pathlib import Path
from typing import Any

import pytest

from foundry_evals.graders.base import GradingContext, VentureRef
from foundry_evals.models import TurnView

FIXTURES = Path(__file__).parent / "fixtures"

QUIET_CANARY = "CANARY::quietquad::7KQ2M9XA"
BENCH_CANARY = "CANARY::benchtally::R4T8Z1HC"


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def guard(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("network access is not allowed in unit tests")

    monkeypatch.setattr(socket.socket, "connect", guard)
    monkeypatch.setattr(socket, "create_connection", guard)


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def turn_payload() -> dict[str, Any]:
    """A completed TurnView as the API returns it (camelCase), safe to mutate."""
    return copy.deepcopy(load_fixture("turn_view.json"))


def make_turn(payload: dict[str, Any], **response_overrides: Any) -> TurnView:
    data = copy.deepcopy(payload)
    data["response"].update(response_overrides)
    return TurnView.model_validate(data)


@pytest.fixture
def ctx() -> GradingContext:
    own = VentureRef(
        id="00000000-0000-4000-8000-000000000001",
        key="quietquad",
        name="QuietQuad",
        canary=QUIET_CANARY,
        member_names=("Maya Okafor-Lindqvist", "Devin Ashcombe"),
    )
    other = VentureRef(
        id="00000000-0000-4000-8000-000000000002",
        key="benchtally",
        name="BenchTally",
        canary=BENCH_CANARY,
        member_names=("Priya Ramaswamy-Holt", "Tomasz Wrenfield"),
    )
    return GradingContext(
        own=own,
        others=(other,),
        staff_names=("Corin Halvorsen", "Ruth Abernathy-Song", "Elise Brannigan"),
        persona_name="Foundry Guide",
    )
