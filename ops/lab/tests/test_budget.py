from __future__ import annotations

import json
from pathlib import Path

import pytest

from conversation_lab.budget import (
    BudgetExceededError,
    Charge,
    Ledger,
    SpendGuard,
    estimate_tokens,
    micro_ceil,
    token_cost,
)
from conversation_lab.config import Price


def test_costs_round_up_to_the_micro_dollar_like_the_app_ledger() -> None:
    assert micro_ceil(0) == 0
    assert micro_ceil(1e-9) == 0.000001
    assert micro_ceil(0.0000011) == 0.000002
    assert micro_ceil(0.000002) == 0.000002
    # Nova Premier: 1,000 in + 100 out = 0.0025 + 0.00125
    assert token_cost(Price(2.5, 12.5), 1000, 100) == 0.00375
    assert token_cost(Price(2.5, 12.5), -5, 0) == 0


def test_token_estimate_is_on_the_high_side() -> None:
    text = "word " * 400  # 2,000 characters, about 400-500 real tokens
    assert estimate_tokens(text) >= 600


def test_ledger_totals_and_file_hold_numbers_only(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "public" / "ledger.jsonl")
    ledger.add(Charge("bedrock", "judge", "us.amazon.nova-premier-v1:0", 1000, 100, 0.00375))
    ledger.add(Charge("polly", "voice", "polly:neural:Joanna", 80, 0, 0.00128))
    ledger.add(Charge("bedrock", "judge", "us.amazon.nova-premier-v1:0", 10, 1, 0.000038))
    assert ledger.total == 0.005068
    assert ledger.by_purpose() == {
        "judge": {"calls": 2, "usd": 0.003788, "units_in": 1010, "units_out": 101},
        "voice": {"calls": 1, "usd": 0.00128, "units_in": 80, "units_out": 0},
    }
    rows = [json.loads(line) for line in (tmp_path / "public" / "ledger.jsonl").read_text().splitlines()]
    assert [set(r) for r in rows] == [{"kind", "purpose", "model", "units_in", "units_out", "usd"}] * 3


def test_guard_refuses_a_lab_call_whose_worst_case_does_not_fit(ledger: Ledger) -> None:
    guard = SpendGuard(app_budget=1, lab_budget=0.01, ledger=ledger)
    guard.reserve_lab(0.01)
    ledger.add(Charge("bedrock", "judge", "m", 1, 1, 0.004))
    guard.reserve_lab(0.006)
    with pytest.raises(BudgetExceededError) as exc:
        guard.reserve_lab(0.0061)
    assert exc.value.side == "lab"
    assert guard.stopped_by == "lab"


def test_guard_stops_the_app_at_its_share(ledger: Ledger) -> None:
    spent = {"usd": 0.0}
    guard = SpendGuard(app_budget=0.5, lab_budget=0.1, ledger=ledger)
    guard.attach_app(lambda: spent["usd"])
    assert guard.check_app(reserve=0.1) == 0
    spent["usd"] = 0.45
    guard.check_app()
    with pytest.raises(BudgetExceededError) as exc:
        guard.check_app(reserve=0.05)
    assert exc.value.side == "app"
    spent["usd"] = 0.5
    with pytest.raises(BudgetExceededError):
        guard.check_app()
    ledger.add(Charge("bedrock", "judge", "m", 1, 1, 0.02))
    assert guard.snapshot() == {
        "app_usd": 0.5,
        "lab_usd": 0.02,
        "total_usd": 0.52,
        "app_budget_usd": 0.5,
        "lab_budget_usd": 0.1,
    }
