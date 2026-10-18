from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from conversation_lab import cli
from conversation_lab.census import census
from conversation_lab.compare import BASELINES_DIR, baseline_path, compare, load_baseline, render
from conversation_lab.report import render_with_baseline


def test_census_counts_each_habit_once_per_reply() -> None:
    replies = [
        "Great, Maya. The riskiest assumption is demand. The cheapest test is a waitlist [E2]. Who signs? And when?",
        "Sure, I'm an AI, so neither: I'm Corin's vEIR, not Corin. Let's cut to the chase.\n\n- one\n- two",
        "Okay, let's see. The founder is asking about pricing. I need to figure out the mode.",
        "",
    ]
    out = census(replies, founder_names=("Maya",))
    assert out["replies"] == 3
    assert out["great_opening"] == 1
    assert out["riskiest_assumption"] == 1
    assert out["cheapest_test"] == 1
    assert out["evidence_keys"] == 1
    assert out["two_or_more_questions"] == 1
    assert out["so_neither"] == 1
    assert out["says_ai"] == 1
    assert out["cut_to_the_chase"] == 1
    assert out["markdown_list_or_heading"] == 1
    assert out["reasoning_leak"] == 1
    assert out["founder_name"] == 1
    assert out["words_p50"] == 18


def summary(passed: int, run: int, **result: Any) -> dict[str, Any]:
    return {
        "suite": "matrix",
        "spend": {"total_usd": 0.5},
        "result": {"passed": passed, "run": run, **result},
    }


BASE = summary(
    28,
    40,
    humanness=72.3,
    turn_seconds={"p50": 5.1, "p95": 8.7},
    dimensions={"emotion": {"bored": {"passed": 0, "run": 2}, "sad": {"passed": 1, "run": 1}}},
    census={"replies": 80, "riskiest_assumption": 21, "words_p50": 156},
    scenarios=[
        {"id": "SM-01", "passed": True, "reason": "pass"},
        {"id": "SM-04", "passed": False, "reason": "presence"},
    ],
)
NOW = summary(
    33,
    40,
    humanness=80.0,
    turn_seconds={"p50": 4.0, "p95": 7.0},
    dimensions={
        "emotion": {
            "bored": {"passed": 2, "run": 2},
            "sad": {"passed": 1, "run": 1},
            "proud": {"passed": 1, "run": 1},
        }
    },
    census={"replies": 90, "riskiest_assumption": 9, "words_p50": 70},
    scenarios=[
        {"id": "SM-01", "passed": False, "reason": "judge"},
        {"id": "SM-04", "passed": True, "reason": "pass"},
    ],
)


def test_compare_sets_each_number_beside_the_baseline() -> None:
    out = compare(NOW, BASE)
    headline = {r["metric"]: r for r in out["headline"]}
    assert headline["pass rate (%)"] == {
        "metric": "pass rate (%)",
        "baseline": 70.0,
        "now": 82.5,
        "change": 12.5,
    }
    assert headline["humanness (0-100)"]["change"] == 7.7
    assert headline["turn time p50 (s)"]["change"] == -1.1
    assert {(d["value"], d["baseline"], d["now"], d["change_pct"]) for d in out["dimensions"]} == {
        ("bored", "0/2", "2/2", 100),
        ("sad", "1/1", "1/1", 0),
        ("proud", None, "1/1", None),
    }
    census_rows = {c["pattern"]: c for c in out["census"]}
    # Shares of replies, so runs of different sizes compare: 21/80 = 26 %, 9/90 = 10 %.
    assert census_rows["riskiest_assumption"]["baseline_share_pct"] == 26
    assert census_rows["riskiest_assumption"]["now_share_pct"] == 10
    assert census_rows["riskiest_assumption"]["change_pct"] == -16
    assert census_rows["words_p50"]["change_pct"] == -86
    assert out["scenarios_changed"] == [
        {"id": "SM-01", "baseline": "pass", "now": "judge"},
        {"id": "SM-04", "baseline": "presence", "now": "pass"},
    ]


def test_compare_refuses_another_suite() -> None:
    with pytest.raises(ValueError, match="same suite"):
        compare(NOW, {**BASE, "suite": "recall"})


def test_rendered_comparison_is_tables_of_numbers() -> None:
    text = render(compare(NOW, BASE), "39084323076")
    assert "### Compared with run 39084323076" in text
    assert "| pass rate (%) | 70 | 82.5 | +12.5 |" in text
    assert "| emotion | bored | 0/2 | 2/2 | +100 |" in text
    assert "| riskiest_assumption | 21 (26 %) | 9 (10 %) | -16 pts |" in text
    assert "| SM-04 | presence | pass |" in text


def test_the_committed_baseline_is_found_first_and_holds_numbers_only(tmp_path: Path) -> None:
    committed = BASELINES_DIR / "matrix-39084323076.json"
    assert baseline_path("matrix", "39084323076", tmp_path / "missing.json") == committed
    data = load_baseline(committed)
    assert data["result"]["run"] == 40
    assert data["result"]["census"]["replies"] > 0
    # The run's public view only: ids, tags, codes and numbers for each scenario, no text but the note.
    public_keys = {"id", "tags", "channel", "passed", "reason", "turns", "turn_seconds", "craft_findings"}
    public_keys |= {"blocking_findings", "presence_findings", "judge"}
    for scenario in data["result"]["scenarios"]:
        assert set(scenario) <= public_keys
    strings = [v for v in json.dumps(data, ensure_ascii=False).split('"') if len(v) > 120]
    assert strings == [data["baseline_note"]]
    downloaded = tmp_path / "summary.json"
    downloaded.write_text(json.dumps(BASE), encoding="utf-8")
    assert baseline_path("matrix", "1", downloaded) == downloaded
    assert baseline_path("matrix", "1", None) is None


def test_attach_baseline_compares_or_says_why_not(tmp_path: Path) -> None:
    downloaded = tmp_path / "summary.json"
    downloaded.write_text(json.dumps(BASE), encoding="utf-8")
    current = json.loads(json.dumps(NOW))
    cli.attach_baseline(current, "matrix", "123", downloaded)
    assert current["baseline"]["comparison"]["headline"][0]["now"] == 82.5
    text = render_with_baseline(current | {"spend": {}, "models": {}})
    assert "### Compared with run 123" in text
    missing: dict[str, Any] = dict(NOW)
    cli.attach_baseline(missing, "matrix", "456", None)
    assert missing["baseline"] == {"run_id": "456", "error": "not_found"}
    assert "No comparison with run 456: not_found." in render_with_baseline(
        missing | {"spend": {}, "models": {}}
    )
    bad: dict[str, Any] = dict(NOW)
    cli.attach_baseline(bad, "matrix", "../x", downloaded)
    assert bad["baseline"]["error"] == "bad_run_id"


def test_the_matrix_result_carries_the_census_of_what_the_founder_heard() -> None:
    from conversation_lab.smoke import ScenarioResult, TurnRecord

    result = ScenarioResult(
        id="SM-01", tags={"emotion": "neutral"}, channel="chat", passed=True, reason="pass"
    )
    result.turns = [
        TurnRecord(
            founder="hi",
            heard="Great, Maya. The riskiest assumption is demand.",
            kind="completed",
            seconds=3.0,
        ),
        TurnRecord(founder="ok", heard="", kind="error", seconds=0.0),
    ]
    out = cli.matrix_result([result], None, founder_name="Maya", llm_simulator=True)
    assert out["census"]["replies"] == 1
    assert out["census"]["riskiest_assumption"] == 1
    assert out["census"]["founder_name"] == 1
    assert (out["passed"], out["run"], out["simulator"]) == (1, 1, "llm")
    assert out["dimensions"] == {"emotion": {"neutral": {"passed": 1, "run": 1}}}
    assert "Great, Maya" not in json.dumps(out)
