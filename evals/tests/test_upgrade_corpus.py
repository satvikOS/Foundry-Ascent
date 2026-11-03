"""Acceptance-fixture coverage is data, not a claim of successful model behavior."""

import json
import runpy
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "datasets" / "upgrade"


def test_distinct_complete_scenarios_and_reproducible_generation():
    cases = [json.loads(line) for line in (ROOT / "scenarios.jsonl").read_text().splitlines()]
    generated = list(runpy.run_path(str(ROOT / "generate.py"))["generate"]())
    assert cases == generated
    assert len(cases) == len({case["id"] for case in cases}) == 600
    assert Counter(case["family"] for case in cases) == dict.fromkeys(range(1, 31), 20)
    for family in range(1, 31):
        decisions = [case["decision"] for case in cases if case["family"] == family]
        assert len(set(decisions)) == 20
    required = {
        "venture",
        "student",
        "priorApprovedMemory",
        "objective",
        "sources",
        "toolConditions",
        "branches",
        "expected",
        "prohibited",
        "expectedMemory",
        "expectedEscalation",
        "scoring",
        "version",
    }
    assert all(required <= case.keys() for case in cases)
    assert all(case["studentTurnsPerSession"] >= 8 for case in cases)
    assert sum(case["sessions"] for case in cases) == 720
    assert sum(case["sessions"] * case["studentTurnsPerSession"] for case in cases) == 5820


def test_required_longitudinal_corrections_control_and_overlap():
    cases = [json.loads(line) for line in (ROOT / "scenarios.jsonl").read_text().splitlines()]
    groups = {
        tag: {case["id"] for case in cases if case["tags"][tag]}
        for tag in ["multiSession", "longRunning", "correction", "conversationControl"]
    }
    assert len(groups["multiSession"]) == 60
    assert len(groups["longRunning"]) == 20
    assert len(groups["correction"]) == 240
    assert len(groups["conversationControl"]) == 240
    assert len(groups["multiSession"] & groups["correction"]) == 60
    assert len(groups["longRunning"] & groups["correction"]) == 20
    assert not groups["correction"] & groups["conversationControl"]
    assert all(case["sessions"] >= 3 for case in cases if case["tags"]["multiSession"])
    assert all(
        case["sessions"] * case["studentTurnsPerSession"] * 2 >= 50
        for case in cases
        if case["tags"]["longRunning"]
    )
