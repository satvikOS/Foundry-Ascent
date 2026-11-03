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


def calibration_fixture():
    scenarios = [json.loads(line) for line in (ROOT / "scenarios.jsonl").read_text().splitlines()]
    transcripts = [
        {"id": s["id"], "transcript": [{"role": "student", "text": s["objective"]}]} for s in scenarios
    ]
    results = [{"id": s["id"], "status": "passed_protocol"} for s in scenarios]
    prepare = runpy.run_path(str(ROOT / "calibration.py"))["prepare"]
    return scenarios, transcripts, results, prepare


def test_calibration_is_blinded_balanced_and_independent_of_input_order():
    scenarios, transcripts, results, prepare = calibration_fixture()
    packet, metadata = prepare(scenarios, transcripts, results)
    assert len(packet) == 60
    assert set(metadata["familyCounts"].values()) == {2}
    assert metadata["tagCounts"] == {
        "correction": 24,
        "conversationControl": 24,
        "multiSession": 6,
        "longRunning": 2,
    }
    assert metadata["humanReviewed"] == 0
    assert all(set(row) == {"sampleId", "transcript", "scores"} and row["scores"] is None for row in packet)
    assert prepare(list(reversed(scenarios)), list(reversed(transcripts)), list(reversed(results))) == (
        packet,
        metadata,
    )


def test_calibration_preserves_failures_and_rejects_incomplete_or_duplicate_runs():
    import pytest

    scenarios, transcripts, results, prepare = calibration_fixture()
    # Every failure is retained even when it was outside the balanced sixty.
    results[19]["status"] = "failed"
    packet, metadata = prepare(scenarios, transcripts, results)
    assert metadata["failedScenariosIncluded"] == 1
    assert scenarios[19]["id"] in metadata["selectionKey"].values()
    assert len(packet) >= 60
    with pytest.raises(ValueError, match="complete run"):
        prepare(scenarios, transcripts[:-1], results)
    with pytest.raises(ValueError, match="duplicate"):
        prepare(scenarios, [*transcripts, transcripts[0]], results)


def test_shard_merge_rejects_missing_duplicate_and_changed_source_evidence():
    import copy

    import pytest

    combine = runpy.run_path(str(ROOT / "merge_runs.py"))["combine"]

    def shard(sid):
        return {
            "manifest": {
                "sourceSha256": "source",
                "fixtureSha256": "fixture",
                "promptVersion": "policy",
                "model": "fixture",
                "liveModel": False,
                "code": "commit",
                "sourceUnchangedDuringRun": True,
                "scenariosAttempted": 1,
                "scenariosPassedProtocol": 1,
                "startedAt": "2026-11-03T00:00:00Z",
                "finishedAt": "2026-11-03T00:00:01Z",
                "skipped": 0,
                "blocked": 0,
                "conversationsStarted": 1,
                "conversationsCompleted": 1,
                "attemptedTurns": 1,
                "completedTurns": 1,
            },
            "results": [{"id": sid, "status": "passed_protocol", "studentTurns": 1}],
            "transcripts": [
                {
                    "id": sid,
                    "transcript": [
                        {"role": "student", "text": "A decision"},
                        {"role": "coach", "text": "An answer"},
                    ],
                }
            ],
        }

    runs = [shard("A"), shard("B")]
    good = combine(runs, {"A", "B"})
    assert good["manifest"]["completedTurns"] == 2
    assert good["manifest"]["concurrency"] == 2
    with pytest.raises(ValueError, match="missing"):
        combine(runs[:1], {"A", "B"})
    with pytest.raises(ValueError, match="duplicate"):
        combine([runs[0], runs[0]], {"A", "B"})
    changed = copy.deepcopy(runs)
    changed[1]["manifest"]["sourceSha256"] = "different"
    with pytest.raises(ValueError, match="incompatible"):
        combine(changed, {"A", "B"})
    missing_reply = copy.deepcopy(runs)
    missing_reply[1]["transcripts"][0]["transcript"].pop()
    with pytest.raises(ValueError, match="incomplete"):
        combine(missing_reply, {"A", "B"})
