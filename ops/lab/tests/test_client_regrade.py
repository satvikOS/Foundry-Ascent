"""Today's graders over an earlier run's opened transcripts: read back, graded, compared with a person's scores, and
printed as numbers. The transcripts here are the fake app's own."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from conversation_lab import cli, config
from conversation_lab.client import regrade as rg
from conversation_lab.client.scenarios import load
from tests.test_client_pipeline import REPLY, GuidedApp, OneJudge, run

DAY = dt.date(2026, 11, 24)
FRAGMENT = "Your next step: write one line with a price, by Friday."
SECRET = "Zebrafinch"


def transcripts(folder: Path, *ids: str, reply: str = REPLY) -> Path:
    run(GuidedApp(replies=lambda _t: reply, call_intro="Hi."), *ids, judge=OneJudge(), tmp=folder)
    (folder / "client" / "failures.json").write_text("[]", encoding="utf-8")
    return folder / "client"


def regraded(folder: Path, said: list[str] | None = None) -> rg.Regraded:
    results, unknown = rg.read_folder(folder, load(DAY).by_id())
    return rg.regrade(results, unknown, DAY, said)


def test_a_run_read_back_is_graded_as_it_was_played(tmp_path: Path) -> None:
    played = run(
        GuidedApp(replies=lambda _t: REPLY, call_intro="Hi."), "CP-01", "RP-07", "CL-01", tmp=tmp_path
    )
    done = regraded(tmp_path / "client")
    assert [r.scenario.id for r in done.results] == ["CL-01", "CP-01", "RP-07"]
    by_id = {r.scenario.id: r for r in played}
    for r in done.results:
        assert r.failures == by_id[r.scenario.id].failures
        assert [t.founder for t in r.turns] == [t.founder for t in by_id[r.scenario.id].turns]
    assert done.unknown == []


def test_the_judges_scores_are_read_back_too(tmp_path: Path) -> None:
    done = regraded(transcripts(tmp_path, "CQ-14"))
    card = done.results[0].turns[1].card
    assert card is not None
    assert card.raw["referral"] == 5


def test_a_fault_is_the_models_or_the_servers(tmp_path: Path) -> None:
    folder = transcripts(tmp_path, "CL-01", reply=f"{REPLY}\n\nOn record: Box: A box sells for 12 dollars.")
    # The model wrote the clean part; the record label is the server's.
    done = regraded(folder, [REPLY])
    assert done.blame["no_internal_words"]["server"] == 5
    assert done.blame["no_internal_words"]["model"] == 0
    assert done.blame["answers_the_number"]["model"] >= 1
    nothing = regraded(folder, ["Nothing like it at all, anywhere in this log."])
    assert nothing.blame["no_internal_words"]["unknown"] == 5


def test_the_models_words_come_from_the_api_log(tmp_path: Path) -> None:
    log = tmp_path / "api.log"
    event = {"event": "turn.phase_a", "replyText": "Hello there, friend."}
    log.write_text(f"not json\n{json.dumps(event)}\n{json.dumps({'event': 'other'})}\n", encoding="utf-8")
    assert rg.model_words(log) == ["Hello there, friend."]
    assert rg.own_words("Hello there, friend. And more besides that.", ["Hello there, friend."]) is not None
    assert rg.own_words("Something else entirely here.", ["Hello there, friend."]) is None


def test_agreement_with_a_person(tmp_path: Path) -> None:
    folder = transcripts(tmp_path, "CL-01", reply=FRAGMENT)
    done = regraded(folder)
    found = rg.agreement(
        done, {"CL-01 1.1": 1, "CL-01 1.2": 2, "CL-01 2.1": 5, "CL-01 1.3": 3, "XX-01 1.1": 1}
    )
    assert found["bad_caught"] == 2
    assert found["bad_missed"] == 0
    assert found["good_flagged"] == 1
    assert found["generic_caught"] + found["generic_passed"] == 1
    assert found["agreement"] == pytest.approx(2 / 3, abs=0.001)
    assert rg.agreement(done, {})["agreement"] is None


def test_the_command_prints_numbers_and_writes_outside_the_repository(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    folder = transcripts(tmp_path / "run", "CL-01", reply=f"{FRAGMENT} {SECRET} says so.")
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps({"CL-01 1.2": 1}), encoding="utf-8")
    out = tmp_path / "out"
    base = ["client-regrade", "--transcripts", str(folder), "--day", DAY.isoformat()]
    assert cli.main([*base, "--labels", str(labels), "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "answers_the_number" in printed
    assert "strict, blocking" in printed
    assert '"bad_caught": 1' in printed
    assert SECRET not in printed
    assert SECRET not in (out / "regrade.json").read_text(encoding="utf-8")
    assert SECRET in (out / "regrade-failures.json").read_text(encoding="utf-8")
    inside = config.REPO / "ops" / "lab" / "regrade-out"
    assert cli.main([*base, "--out", str(inside)]) == 2
    assert not inside.exists()


@pytest.mark.parametrize(
    "broken",
    [
        {"--day": "yesterday"},
        {"--labels": "{}x"},
        {"--transcripts": "nowhere"},
    ],
)
def test_what_cannot_be_read_is_refused_without_its_content(
    tmp_path: Path, broken: dict[str, Any], capsys: pytest.CaptureFixture[str]
) -> None:
    folder = transcripts(tmp_path / "run", "CQ-01")
    args = {"--transcripts": str(folder), "--day": DAY.isoformat(), "--out": str(tmp_path / "o")}
    for key, value in broken.items():
        path = tmp_path / "broken"
        if key == "--labels":
            path.write_text(value, encoding="utf-8")
            args[key] = str(path)
        else:
            args[key] = value
    assert cli.main(["client-regrade", *[x for pair in args.items() for x in pair]]) == 2
    assert SECRET not in capsys.readouterr().err


def test_a_transcript_of_a_scenario_that_is_gone_is_named_not_graded(tmp_path: Path) -> None:
    folder = transcripts(tmp_path, "CQ-01")
    raw = json.loads((folder / "CQ-01.json").read_text(encoding="utf-8"))
    (folder / "ZZ-01.json").write_text(json.dumps({**raw, "id": "ZZ-01"}), encoding="utf-8")
    done = regraded(folder)
    assert done.unknown == ["ZZ-01"]
    assert rg.summary(done)["not_in_the_set"] == ["ZZ-01"]
    # A turn the scenario does not have is a wrong transcript, not a result.
    bad = {**raw, "transcript": [{**raw["transcript"][0], "at": "1.9"}]}
    (folder / "CQ-01.json").write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(rg.RegradeError, match=r"CQ-01: turn 1\.9"):
        rg.read_folder(folder, load(DAY).by_id())
