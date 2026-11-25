"""The judge's calibration: the hand-graded set, the agreement numbers, and what an uncalibrated judge does to the gates."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

import pytest

from conversation_lab.client import calibration as cal
from conversation_lab.client.judge import Scorecard
from conversation_lab.client.report import aggregate, gates, render
from conversation_lab.client.rubric import CRITERIA, tool_summary
from conversation_lab.client.scenarios import load as load_scenarios

CASES = cal.load()


def card(scores: dict[str, int], answered: str = "yes", error: str | None = None) -> Scorecard:
    full: dict[str, int | None] = {**dict.fromkeys(CRITERIA), **scores}
    return Scorecard(scores=full, raw=dict(full), error=error, checks={"answered": answered, "invented": []})


def exact() -> list[Scorecard]:
    return [card(c.strict, c.answered) for c in CASES]


def test_the_set_is_large_and_holds_good_and_bad_replies() -> None:
    assert len(CASES) >= 24
    scores = [v for c in CASES for v in c.strict.values()]
    assert sum(1 for v in scores if v <= 2) >= 30
    assert sum(1 for v in scores if v >= 4) >= 30
    assert {c.answered for c in CASES} == {"yes", "partly", "no"}
    # Every criterion the client's sheet has is graded by hand somewhere.
    assert {k for c in CASES for k in c.strict} == set(CRITERIA)
    # A reply that does not answer never gets a decent relevance by hand.
    assert not [c.id for c in CASES if c.answered == "no" and c.strict.get("relevance", 1) > 2]


def test_the_set_is_invented_and_apart_from_the_scenarios() -> None:
    text = cal.CALIBRATION_FILE.read_text(encoding="utf-8")
    assert not re.search(r"[\w.]+@[\w.]+|https?://|\b\d{3}[- ]\d{3}[- ]\d{4}\b", text)
    for s in load_scenarios(dt.date(2026, 11, 25)).scenarios:
        assert s.venture["name"] not in text
        assert s.founder not in text


def test_a_judge_that_agrees_is_calibrated() -> None:
    found = cal.agreement(CASES, exact())
    assert (found["exact"], found["within_one"], found["bias"]) == (1.0, 1.0, 0.0)
    assert (found["bad_caught"], found["good_kept"], found["answered_same"]) == (1.0, 1.0, 1.0)
    assert found["calibrated"] is True
    assert found["off"] == []


def test_the_first_runs_lenient_judge_is_not_calibrated() -> None:
    # Fives and fours for everything, as the first live run's judge gave.
    found = cal.agreement(CASES, [card(dict.fromkeys(c.strict, 5)) for c in CASES])
    assert found["calibrated"] is False
    assert found["bias"] > 1.0
    assert found["bad_caught"] == 0.0
    assert found["lenient_by_two"] > 40
    assert "KB-02" in found["off"]


def test_a_judge_that_fails_everything_is_not_calibrated_either() -> None:
    found = cal.agreement(CASES, [card(dict.fromkeys(c.strict, 1), "no") for c in CASES])
    assert found["calibrated"] is False
    assert found["good_kept"] == 0.0


def test_a_judge_that_seldom_answers_is_not_measured() -> None:
    cards = exact()
    cards[:8] = [card({}, error="budget")] * 8
    found = cal.agreement(CASES, cards)
    assert found["errors"] == {"budget": 8}
    assert found["calibrated"] is None


def test_the_cases_are_scored_by_the_runs_own_judge() -> None:
    asked: list[tuple[str, Any]] = []

    class Judge:
        def score(self, prompt: str, criteria: Any) -> Scorecard:
            asked.append((prompt, criteria))
            case = next(c for c in CASES if c.prompt == prompt)
            return card(case.strict, case.answered)

    found, cards = cal.calibrate(Judge(), concurrency=2)
    assert len(asked) == len(cards) == len(CASES)
    assert found["calibrated"] is True
    assert "Coach's reply" in asked[0][0]
    rows = cal.private_rows(CASES, cards)
    assert rows[0]["strict"] == rows[0]["judge"]


def test_an_uncalibrated_judges_score_is_no_pass() -> None:
    summary = tool_summary([dict.fromkeys(CRITERIA, 5)])

    def gate(found: dict[str, Any] | None) -> tuple[Any, Any]:
        by = {g["gate"]: g["passed"] for g in gates([], summary, calibration=found)}
        return (
            by["the judge agrees with the hand-graded replies"],
            by["client score at least 4.5, no criterion under 4"],
        )

    good = cal.agreement(CASES, exact())
    lenient = cal.agreement(CASES, [card(dict.fromkeys(c.strict, 5)) for c in CASES])
    unmeasured = cal.agreement(CASES, [card({}, error="budget")] * len(CASES))
    assert gate(None) == (None, True)
    assert gate(good) == (True, True)
    assert gate(lenient) == (False, False)
    assert gate(unmeasured) == (None, None)


def test_the_public_summary_says_how_the_judge_agreed_in_numbers_only() -> None:
    lenient = cal.agreement(CASES, [card(dict.fromkeys(c.strict, 5)) for c in CASES])
    summary = aggregate(
        [],
        {
            "evidence": "live",
            "wording": "equivalent",
            "coach": "us.amazon.nova-2-lite-v1:0",
            "coach_choice": "default",
            "judge": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            "judge_prompt": "v",
            "judge_independent": True,
            "groups": ["numbers", "news"],
            "plan": {"total_usd": 0.4, "app_usd": 0.1, "lab_usd": 0.3, "turns": 20, "judged": 10},
            "calibration": lenient,
        },
    )
    text = render(summary)
    assert "NOT calibrated" in text
    assert "Coach: us.amazon.nova-2-lite-v1:0 (coach_model default)" in text
    assert "Groups: numbers, news" in text
    assert "KB-02" in text
    public = text + json.dumps(summary)
    raw = cal.CALIBRATION_FILE.read_text(encoding="utf-8")
    for line in (x.strip() for x in raw.splitlines()):
        if len(line) > 40 and not line.startswith("#"):
            assert line not in public


@pytest.mark.parametrize(
    "change",
    [
        {"answered": "maybe"},
        {"founder": "nobody"},
        {"strict": {"relevance": 6}},
        {"strict": {"taste": 3}},
        {"extra": 1},
    ],
)
def test_a_malformed_case_is_refused(tmp_path: Path, change: dict[str, Any]) -> None:
    case = {
        "id": "KB-99",
        "founder": "x",
        "asks": "a",
        "reply": "b",
        "tests": "t",
        "strict": {"relevance": 3},
        "answered": "yes",
    }
    path = tmp_path / "c.yaml"
    founders = {"x": {"about": "Someone", "role": "grad", "known": "k"}}
    path.write_text(json.dumps({"founders": founders, "cases": [case]}), encoding="utf-8")
    assert len(cal.load(path)) == 1
    path.write_text(json.dumps({"founders": founders, "cases": [{**case, **change}]}), encoding="utf-8")
    with pytest.raises(cal.CalibrationError, match="KB-99"):
        cal.load(path)
