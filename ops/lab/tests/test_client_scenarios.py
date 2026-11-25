"""The client scenario set: the schema, its size, the protocol's order, and the exact wording laid over ours."""

from __future__ import annotations

import datetime as dt
import re
from collections import Counter
from pathlib import Path

import pytest

from conversation_lab.client.reading import dates_in
from conversation_lab.client.rubric import QUESTIONS
from conversation_lab.client.scenarios import (
    CLIENT_DIR,
    STEP_KINDS,
    ScenarioError,
    choose,
    fill_dates,
    load,
    parse_scenario,
)
from conversation_lab.config import REPO

DAY = dt.date(2026, 11, 24)


@pytest.fixture(scope="module")
def chosen():
    return load(DAY)


def test_the_set_is_large_enough_and_in_run_order(chosen) -> None:
    assert len(chosen.scenarios) >= 30
    assert chosen.turns >= 160
    groups = Counter(s.group for s in chosen.scenarios)
    assert groups["questions"] == 20
    assert groups["repeats"] == 10
    assert all(s.repeat == 3 for s in chosen.scenarios if s.group == "repeats")
    assert chosen.scenarios[0].group == "protocol"
    assert groups["adversarial"] == 4
    assert sum(1 for s in chosen.scenarios if any(x.channel == "call" for x in s.sessions)) >= 5


def test_every_question_is_asked_on_its_role_and_the_protocol_keeps_its_order(chosen) -> None:
    asked = {
        t.q: s for s in chosen.scenarios if s.group == "questions" for x in s.sessions for t in x.turns if t.q
    }
    assert set(asked) == set(QUESTIONS)
    for qid, s in asked.items():
        assert s.role == QUESTIONS[qid].role
        # The founder says what they are building first: the question is never asked into nothing.
        assert len(s.sessions[0].turns) >= 2
    for s in (x for x in chosen.scenarios if x.group == "protocol"):
        today, tomorrow = s.sessions
        # The setup names the idea: the client's own in the typed protocol, another (names are unique) on the call.
        assert today.turns[0].wording == ("P-setup" if s.id == "CP-01" else None)
        assert [t.wording for t in today.turns[1:]] == ["P-Q20", "P-Q4", "P-Q13", "P-Q14", "P-X1"]
        assert tomorrow.gap_days == 1
        assert [t.wording for t in tomorrow.turns] == ["P-Q19"]
        assert s.neighbour is not None


def test_the_expectations_that_must_never_be_missing_are_set(chosen) -> None:
    turns = [t for s in chosen.scenarios for x in s.sessions for t in x.turns if t.q]
    by_q: dict[str, list] = {}
    for t in turns:
        by_q.setdefault(t.q, []).append(t)
    for qid in ("Q10", "Q14", "Q15", "Q16"):
        assert all(t.expect.referral for t in by_q[qid])
    assert all(t.expect.no_flattery for t in by_q["Q20"])
    assert all(t.expect.challenge_friends for t in by_q["Q4"])
    assert all(t.expect.other_venture for t in by_q["Q13"])
    assert all(t.expect.remember for t in by_q["Q19"])
    coaching = sum(
        s.repeat for s in chosen.scenarios for x in s.sessions for t in x.turns if t.expect.kind in STEP_KINDS
    )
    assert coaching >= 110


def test_arcs_span_four_sessions_with_days_between(chosen) -> None:
    arc = chosen.by_id()["AR-01"]
    assert len(arc.sessions) == 4
    assert [s.gap_days for s in arc.sessions] == [0, 7, 7, 7]
    assert any(s.opener for s in arc.sessions)


def test_nothing_in_the_set_is_a_real_person_or_address(chosen) -> None:
    text = "\n".join(p.read_text(encoding="utf-8") for p in CLIENT_DIR.glob("*.yaml"))
    assert not re.search(r"[\w.]+@[\w.]+|https?://|\b\d{3}[- ]\d{3}[- ]\d{4}\b", text)


def test_exact_wording_replaces_ours_and_is_reported(chosen) -> None:
    assert chosen.wording == "equivalent"
    some = load(DAY, {"Q1": "Exact one?"})
    assert some.wording == "mixed"
    assert some.by_id()["CQ-01"].sessions[0].turns[1].say == "Exact one?"
    keys = {t.wording for s in chosen.scenarios for x in s.sessions for t in x.turns if t.wording}
    everything = load(DAY, {k: f"exact {k}" for k in keys})
    assert everything.wording == "exact"


def test_dates_are_relative_to_the_run() -> None:
    assert fill_dates("on {date+9}, {weekday+3}, {iso-1}", DAY) == "on December 3, Friday, 2026-11-23"
    says = load(DAY).by_id()["CL-02"].sessions[0].turns[0].say
    assert "December 10" in says
    assert "{" not in says


def test_a_scenario_that_ages_names_no_absolute_date(chosen) -> None:
    """The lab moves earlier conversations back, not the clock forward: a date said then would stay where it was."""
    for s in chosen.scenarios:
        if len(s.sessions) > 1:
            assert not [t.say for x in s.sessions for t in x.turns if dates_in(t.say)], s.id


def test_an_intake_holds_only_what_the_contract_has(chosen) -> None:
    source = (REPO / "packages" / "contracts" / "src" / "path.ts").read_text(encoding="utf-8")
    body = source.split("export const PathIntake = z.object({", 1)[1].split("});", 1)[0]
    fields = set(re.findall(r"^  (\w+):", body, re.MULTILINE))
    given = [s.intake for s in chosen.scenarios if s.intake]
    assert len(given) >= 3
    assert all(set(i) <= fields for i in given)
    assert all(set(i["deadline"]) == {"what", "on"} for i in given if "deadline" in i)


def test_choosing_by_id(chosen) -> None:
    assert [s.id for s in choose(chosen.scenarios, ["OR-01", "CP-01"])] == ["CP-01", "OR-01"]
    assert len(choose(chosen.scenarios, [])) == len(chosen.scenarios)
    with pytest.raises(ScenarioError, match="XX-99"):
        choose(chosen.scenarios, ["XX-99"])


BASE = {
    "id": "TS-01",
    "title": "t",
    "role": "undergrad",
    "founder": "Someone Invented",
    "venture": {"name": "V", "oneLiner": "o", "stage": "idea", "domain": "general", "goal": "g"},
    "sessions": [{"turns": [{"say": "hello"}]}],
}


@pytest.mark.parametrize(
    ("change", "what"),
    [
        ({"id": "bad"}, "valid id"),
        ({"extra": 1}, "unknown field extra"),
        ({"role": "dean"}, "role"),
        ({"venture": {**BASE["venture"], "stage": "later"}}, "stage"),
        ({"sessions": []}, "first session"),
        ({"sessions": [{"gap_days": 3, "turns": [{"say": "x"}]}]}, "first session"),
        ({"sessions": [{"turns": []}]}, "no turns"),
        ({"sessions": [{"turns": [{"say": "x", "q": "Q21"}]}]}, "unknown question"),
        ({"sessions": [{"turns": [{"say": "x", "wording": "Z1"}]}]}, "wording"),
        ({"sessions": [{"turns": [{"say": "x", "judge": ["taste"]}]}]}, "judge"),
        ({"sessions": [{"turns": [{"say": "x", "expect": {"kind": "other"}}]}]}, "kind"),
        ({"sessions": [{"turns": [{"say": "x", "expect": {"remember": ["nope"]}}]}]}, "unknown fact"),
        ({"sessions": [{"turns": [{"say": "x", "expect": {"referral": ["plumber"]}}]}]}, "referral"),
        ({"repeat": 9}, "repeat"),
        ({"repeat": 2, "sessions": [BASE["sessions"][0], BASE["sessions"][0]]}, "one session"),
        ({"record": [{"type": "rumour", "title": "t", "content": "c"}]}, "type"),
    ],
)
def test_a_malformed_scenario_is_refused(change: dict, what: str) -> None:
    with pytest.raises(ScenarioError, match=what):
        parse_scenario({**BASE, **change}, "arcs")


def test_the_base_scenario_is_valid_and_files_name_their_group(tmp_path: Path) -> None:
    assert parse_scenario(BASE, "arcs").turns == 1
    (tmp_path / "x.yaml").write_text("group: nowhere\nscenarios: []\n", encoding="utf-8")
    with pytest.raises(ScenarioError, match="group"):
        load(DAY, directory=tmp_path)
