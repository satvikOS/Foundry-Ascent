"""The live scenario dataset: schema, required overlaps and distinctness (the build fails on near-duplicates)."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
import yaml

from conversation_lab.live.dataset import (
    FAMILIES,
    LIVE_DIR,
    MIN_TURNS,
    PER_FAMILY,
    DatasetError,
    Scenario,
    family_file,
    load,
    overlap,
    overlap_shortfalls,
    validate_scenario,
)
from conversation_lab.live.distinct import MAX_COSINE, MAX_MASKED_COSINE, MAX_SHINGLE_JACCARD, check


@pytest.fixture(scope="module")
def dataset():
    return load()


def test_six_hundred_scenarios_in_thirty_families_of_twenty(dataset) -> None:
    assert len(dataset.scenarios) == 600
    assert len(FAMILIES) == 30
    for number in FAMILIES:
        members = dataset.family(number)
        assert len(members) == PER_FAMILY, number
        assert [s.id for s in members] == [f"LV-{number:02d}-{i:02d}" for i in range(1, 21)]


def test_every_scenario_carries_the_section_17_fields(dataset) -> None:
    for s in dataset.scenarios:
        raw = s.raw
        for key in (
            "venture",
            "student",
            "purpose",
            "priorMemory",
            "objective",
            "constraints",
            "hidden",
            "arc",
        ):
            assert key in raw, (s.id, key)
        for key in (
            "branches",
            "expected",
            "prohibited",
            "memoryChanges",
            "escalation",
            "scoring",
            "version",
        ):
            assert key in raw, (s.id, key)
        assert raw["expected"], s.id
        assert raw["prohibited"], s.id
        assert raw["memoryChanges"], s.id
        # Substantive scenarios have at least eight student turns; shorter ones say why.
        assert s.student_turns >= MIN_TURNS or raw.get("short"), s.id


def test_the_required_overlaps_are_met_and_reported(dataset) -> None:
    report = overlap(dataset.scenarios)
    assert overlap_shortfalls(report) == []
    assert report["counts"]["multi_session_3plus"] >= 60
    assert report["counts"]["long_running_50plus_turns"] >= 20
    assert report["counts"]["corrections_or_contradictions"] >= 100
    assert report["counts"]["interruptions_or_topic_changes"] >= 100
    # The groups overlap; every pairwise intersection is reported.
    assert len(report["pairwise_overlap"]) == 6
    assert report["voice_scenarios"] >= 20


def test_long_running_means_fifty_conversational_turns(dataset) -> None:
    for s in dataset.scenarios:
        assert s.long_running == (2 * s.student_turns >= 50)


def test_the_dataset_has_no_near_duplicates_or_shared_boilerplate(dataset) -> None:
    report = check(dataset.scenarios)
    assert report.failures == [], [f.public() for f in report.failures][:5]
    assert report.shared_items == [], report.shared_items[:5]
    # Comfortably below the thresholds, so a templated batch cannot hide under them.
    assert report.nearest_across_families < MAX_COSINE * 0.75
    assert max(report.nearest_within_family.values()) < MAX_COSINE * 0.75


def test_a_name_only_variant_is_caught(dataset) -> None:
    base = dataset.by_id()["LV-05-01"]
    raw = copy.deepcopy(dict(base.raw))
    raw["student"] = {**raw["student"], "name": "Someone Else-Entirely"}
    raw["venture"] = {**raw["venture"], "name": "Otherly"}
    raw["title"] = raw["title"].replace("habit app", "habit tool")
    variant = Scenario(id="LV-05-21", family=5, raw=raw, sessions=base.sessions, arc=base.arc)
    report = check([*dataset.family(5), variant])
    assert any({f.a, f.b} == {"LV-05-01", "LV-05-21"} for f in report.failures)
    assert report.shared_items  # the copied expectations are shared boilerplate too


def test_an_industry_only_variant_is_caught_by_the_masked_comparison(dataset) -> None:
    base = dataset.by_id()["LV-06-03"]
    swap = {"clubs": "gyms", "club": "gym", "cafés": "salons", "bookkeeping": "laundry"}

    def sub(text: str) -> str:
        for a, b in swap.items():
            text = text.replace(a, b).replace(a.capitalize(), b.capitalize())
        return text

    raw = copy.deepcopy(dict(base.raw))
    for key in ("title", "challenge", "objective"):
        raw[key] = sub(raw[key])
    for key in ("constraints", "hidden", "branches", "expected", "prohibited", "memoryChanges"):
        raw[key] = [sub(x) + " (variant)" for x in raw[key]]
    variant = Scenario(id="LV-06-21", family=6, raw=raw, sessions=base.sessions, arc=base.arc)
    report = check([base, variant])
    pair = report.worst[0]
    assert pair.masked_cosine >= MAX_MASKED_COSINE or pair.jaccard >= MAX_SHINGLE_JACCARD


def test_a_templated_batch_like_the_old_upgrade_corpus_is_caught(dataset) -> None:
    """The audited 600 differed only by a decision string on a fixed template."""
    base = dataset.by_id()["LV-02-01"]
    variants = []
    for n, decision in enumerate(("raise prices", "hire a tutor", "launch on campus"), start=1):
        raw = copy.deepcopy(dict(base.raw))
        raw["title"] = f"We need to {decision} this term"
        raw["objective"] = f"Decide whether we need to {decision}."
        variants.append(Scenario(id=f"LV-02-2{n}", family=2, raw=raw, sessions=base.sessions, arc=base.arc))
    report = check(variants)
    assert report.failures
    assert report.shared_items


def test_the_schema_refuses_unknown_and_missing_fields(dataset) -> None:
    raw = copy.deepcopy(dict(dataset.by_id()["LV-01-01"].raw))
    raw["surprise"] = "x"
    del raw["prohibited"]
    problems: list[str] = []
    assert validate_scenario(raw, 1, problems) is None
    assert any("unknown keys" in p for p in problems)
    assert any("missing keys" in p for p in problems)


def test_the_schema_refuses_bad_beats_and_dangling_memory_actions(dataset) -> None:
    raw = copy.deepcopy(dict(dataset.by_id()["LV-17-01"].raw))
    raw["arc"] = [
        ["9.1", "hesitation", "A beat in a session that does not exist"],
        ["1.2", "dancing", "An unknown kind of beat"],
        ["2.0", "memory_delete", "A title nobody remembered"],
        ["1.3", "memory_delete", "Monthly revenue"],
    ]
    problems: list[str] = []
    validate_scenario(raw, 17, problems)
    joined = "\n".join(problems)
    assert "does not exist" in joined
    assert "unknown kind" in joined
    assert "names a priorMemory title" in joined
    assert "before a session (turn 0)" in joined


def test_a_short_scenario_must_say_why(dataset) -> None:
    raw = copy.deepcopy(dict(dataset.by_id()["LV-01-01"].raw))
    raw["sessions"] = [{"gap": 0, "turns": 3, "channel": "chat"}]
    raw["arc"] = [["1.2", "hesitation", "Hesitates about who would pay"]]
    problems: list[str] = []
    validate_scenario(raw, 1, problems)
    assert any("needs a 'short' reason" in p for p in problems)


def test_load_reports_every_problem_at_once(tmp_path: Path) -> None:
    for number in FAMILIES:
        src = family_file(number, LIVE_DIR)
        (tmp_path / src.name).write_bytes(src.read_bytes())
    doc = yaml.safe_load((tmp_path / family_file(3, tmp_path).name).read_text(encoding="utf-8"))
    doc["scenarios"][0]["title"] = "x"
    doc["scenarios"][1]["id"] = "LV-04-02"
    family_file(3, tmp_path).write_text(yaml.safe_dump(doc), encoding="utf-8")
    with pytest.raises(DatasetError) as err:
        load(tmp_path)
    assert "LV-03-01.title" in str(err.value)
    assert "LV-04-02" in str(err.value)
