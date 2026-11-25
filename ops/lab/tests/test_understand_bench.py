from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

import pytest
import yaml

from conversation_lab import cli, config, understand_own
from conversation_lab import understand_bench as bench
from conversation_lab.client.scenarios import CLIENT_DIR, HELD_OUT, Expect, FounderTurn, load

DAY = dt.date(2026, 11, 25)
LAB = config.lab_models()
SCENARIOS = load(DAY).scenarios
CASES = bench.cases_of(SCENARIOS)
BY_ID = {c.id: c for c in CASES}
NOVA = "us.amazon.nova-2-lite-v1:0"


def case(**expect: object) -> bench.BenchCase:
    s = next(s for s in SCENARIOS if s.id == "NM-01")
    return bench.BenchCase("NM-01:1.1", s, FounderTurn("x", expect=Expect(**expect)), 1, 1)  # type: ignore[arg-type]


def read(**over: object) -> dict[str, object]:
    return {
        "kind": "question",
        "also": [],
        "record": [],
        "sums": [],
        "points": [],
        "choice": None,
        "result": None,
        "referral": None,
        "contradicts": None,
        "playId": None,
        "firstAction": None,
        **over,
    }


def part(ms: int, **over: object) -> dict[str, object]:
    return {
        "code": "ok",
        "ms": ms,
        "late": False,
        "inputTokens": 3000,
        "cachedInputTokens": 2000,
        "outputTokens": 90,
        "costUsd": 0.001,
        "raw": {"a": "SECRET WORDS"},
        **over,
    }


def row(arm: str, case_id: str, **over: object) -> dict[str, object]:
    return {
        "arm": arm,
        "caseId": case_id,
        "code": "ok",
        "ms": 900,
        "late": False,
        "inputTokens": 7000,
        "cachedInputTokens": 5000,
        "outputTokens": 300,
        "costUsd": 0.002,
        "parts": {
            "route": part(900),
            "sums": part(0, code="skipped"),
            "judge": part(1400, late=True, raw={"g": ["SECRET WORDS"]}),
        },
        "understanding": read(),
        "inTime": read(),
        "report": {"sumDrops": [], "inputs": {"named": 0, "found": 0, "anywhere": 0}, "textDrops": []},
        "playReferral": None,
        "phrasePlay": None,
        **over,
    }


# The cases ----------------------------------------------------------------------------------------------------------


def test_every_turn_with_something_to_grade_is_a_case_the_held_out_ones_too() -> None:
    assert len(CASES) == len(BY_ID) > 200
    assert sum(c.held_out for c in CASES) > 50
    for c in CASES:
        assert re.fullmatch(r"[A-Z]{2}-\d{2}:\d+\.\d+", c.id)
        assert bench.expects(c.expect)
        assert c.expect.kind not in ("crisis", "rehearsal")


def test_a_case_is_what_the_call_would_have_read() -> None:
    c = next(c for c in CASES if c.session == 2 and c.at > 1 and not c.held_out)
    data = bench.case_json(c, DAY)
    plans = c.scenario.sessions
    assert data["message"] == c.turn.say
    assert data["history"] == [t.say for t in plans[1].turns[: c.at - 1]]
    assert [s["text"] for s in data["said"]] == [t.say for t in plans[0].turns]
    assert all(s["daysAgo"] == plans[1].gap_days for s in data["said"])
    assert [r["content"] for r in data["record"]] == [r.content for r in c.scenario.record]
    assert all(
        r["daysAgo"] == item.days_ago + plans[1].gap_days
        for r, item in zip(data["record"], c.scenario.record, strict=True)
    )
    # Only what the venture's own founder told and recorded: no neighbour's, no expectation.
    assert set(data) == {
        "id",
        "day",
        "channel",
        "venture",
        "founder",
        "record",
        "said",
        "intake",
        "history",
        "message",
    }
    assert json.dumps(data)


def test_the_cases_of_a_budget_are_the_same_on_every_run_and_balanced() -> None:
    some = bench.chosen_cases(CASES, 70)
    assert some == bench.chosen_cases(CASES, 70)
    assert len(some) == 70
    found = {x for c in some for x in bench.expects(c.expect)}
    assert found == {"number", "referral", "pick", "news", "history", "kind", "friends"}
    for measure in ("number", "referral", "pick", "news"):
        assert sum(measure in bench.expects(c.expect) for c in some) >= 8
    assert sum(c.held_out for c in some) >= 25
    assert bench.chosen_cases(CASES, 10_000) == CASES


def test_what_a_run_can_afford_follows_its_price() -> None:
    every = bench.arms(LAB, "")
    assert every == [
        f"{NOVA}@none",
        f"{NOVA}@low",
        "openai.gpt-oss-120b-1:0@low",
        "openai.gpt-oss-20b-1:0@low",
        "qwen.qwen3-next-80b-a3b",
        "us.amazon.nova-micro-v1:0",
        "us.amazon.nova-lite-v1:0",
    ]
    assert bench.arms(LAB, NOVA) == every[:2]
    assert 50 <= bench.affordable(LAB, every, 2.0) < len(CASES)
    assert bench.affordable(LAB, bench.arms(LAB, "openai.gpt-oss-20b-1:0"), 2.0) > len(CASES)
    assert bench.call_usd(LAB, f"{NOVA}@low") > bench.call_usd(LAB, f"{NOVA}@none") > 0
    assert sum(bench.call_usd(LAB, a) for a in every) * bench.affordable(LAB, every, 2.0) <= 2.0


# Grading ------------------------------------------------------------------------------------------------------------


def test_a_number_is_right_when_code_worked_it_out() -> None:
    c = case(number=("13", "1,300"))
    assert bench.grade(c, read(sums=[{"value": 13, "said": "$13"}], kind="sum"), None) == {
        "number": True,
        "number_said": True,
        "no_false_referral": True,
        "kind": True,
    }
    assert bench.grade(c, read(sums=[{"value": 1300.0, "said": "$1,300"}]), None)["number"]
    said = bench.grade(c, read(points=["One kit leaves 13 dollars."]), None)
    assert (said["number"], said["number_said"]) == (False, True)
    assert bench.grade(c, read(sums=[{"value": 13.5, "said": "$13.50"}]), None)["number"] is False


def test_a_failed_reading_gets_nothing_right_and_no_false_referral() -> None:
    c = case(number=("13",), pick=("flyers", "posters"), history=("costs",))
    assert bench.grade(c, None, "pricing") == {
        "number": False,
        "number_said": False,
        "no_false_referral": True,
        "pick": False,
        "history": False,
        "kind": False,
        "phrase_play": False,
    }


def test_referrals() -> None:
    assert bench.grade(case(referral=("legal",)), read(referral="legal"), None)["referral"]
    # The person who splits shares is the one a lawyer's is.
    assert bench.grade(case(referral=("equity",)), read(referral="legal"), None)["referral"]
    assert bench.grade(case(referral=("ip",)), read(referral="legal"), None)["referral"] is False
    assert bench.grade(case(number=("1",)), read(referral="ip"), None)["no_false_referral"] is False
    assert bench.grade(case(number=("1",)), read(referral="wellbeing"), None)["no_false_referral"]
    # A reply the judge reads for who decides is no place for a false one.
    judged = bench.BenchCase(
        "NM-01:1.1",
        case().scenario,
        FounderTurn("x", expect=Expect(number=("1",)), judge=("referral",)),
        1,
        1,
    )
    assert "no_false_referral" not in bench.grade(judged, read(referral="ip"), None)


def test_picks_news_history_kinds_and_friends() -> None:
    pick = case(pick=("flyers", "no"))
    assert bench.grade(pick, read(choice={"pick": "The flyers first"}, kind="choice"), None)["pick"]
    assert bench.grade(pick, read(choice={"pick": "nothing now"}), None)["pick"] is False
    assert bench.grade(pick, read(choice={"pick": "Both"}), None)["pick"]
    # "flyer*" is any word that begins so.
    starred = case(pick=("flyer*", "no"))
    assert bench.grade(starred, read(choice={"pick": "the flyers first"}), None)["pick"]
    assert bench.grade(starred, read(choice={"pick": "posters"}), None)["pick"] is False
    assert bench.grade(case(pick=("no*",)), read(choice={"pick": "nothing"}), None)["pick"]
    assert bench.grade(case(pick=("no",)), read(choice={"pick": "nothing"}), None)["pick"] is False
    news = case(news=("kits",))
    shown = {"verdict": "mixed", "shows": "Seven kits went."}
    assert bench.grade(news, read(result=shown, kind="result"), None)["news"]
    assert bench.grade(news, read(result={"verdict": "mixed", "shows": "It went."}), None)["news"] is False
    assert bench.grade(news, read(points=["Seven kits went."]), None)["news"] is False
    history = case(history=("costs",))
    assert bench.grade(history, read(record=[{"text": "A kit sells for 24 dollars."}]), None)["history"]
    assert bench.grade(history, read(record=[{"text": "Clay is brown."}]), None)["history"] is False
    # What was only said in this conversation is no record line to point at.
    said = next(c for c in CASES if not c.held_out and c.expect.history and not bench.shown_facts(c))
    assert "history" not in bench.grade(said, read(), None)
    # The verdict is said as a word.
    weak = case(news=("kits",))
    assert (
        bench.grade(weak, read(result={"verdict": "too_early", "shows": "It went."}), None)["news"] is False
    )
    assert bench.grade(case(kind="social"), read(kind="update"), None)["kind"]
    assert bench.grade(case(kind="social"), read(kind="choice"), None)["kind"] is False
    assert bench.grade(case(kind="recall", remember=("kits",)), read(kind="recall"), None)["kind"]
    assert bench.grade(case(other_venture=True), read(also=["privacy"]), None)["kind"]
    assert bench.grade(case(other_venture=True), read(), None)["kind"] is False
    friends = case(challenge_friends=True)
    assert bench.grade(friends, read(result={"verdict": "weak"}), None)["friends"]
    assert bench.grade(friends, read(result={"verdict": "strong"}), None)["friends"] is False


def test_the_playbooks_phrase_is_what_a_play_is_compared_with() -> None:
    c = case(number=("13",))
    assert bench.grade(c, read(playId="unit-economics"), "unit-economics")["phrase_play"]
    assert bench.grade(c, read(playId=None), "unit-economics")["phrase_play"] is False
    assert "phrase_play" not in bench.grade(c, read(), None)
    assert "phrase_play" not in bench.grade(case(kind="recall", remember=("kits",)), read(), "pricing")


# What is public -----------------------------------------------------------------------------------------------------


def some_result() -> dict[str, object]:
    cases = bench.chosen_cases(CASES, 30)
    names = bench.arms(LAB, "")[:2]
    rows = [row(a, c.id) for a in names for c in cases[:20]]
    rows[0] = row(
        names[0],
        cases[0].id,
        code="ThrottlingException",
        understanding=None,
        inTime=None,
        report=None,
        late=True,
    )
    rows[1]["report"] = {
        "sumDrops": ["input", "what the founder said 12 dollars"],
        "inputs": {"named": 4, "found": 3, "anywhere": 4},
        "textDrops": ["points:number"],
    }
    rows.append(row("another.model", cases[1].id))
    return bench.public_result(
        {"budgetReached": True, "caps": {"text": 3000, "voice": 1400, "other": "x"}},
        rows,
        cases,
        exit_code=0,
        available=len(CASES),
        known=names,
    )


def test_the_summary_is_numbers_ids_and_codes() -> None:
    result = some_result()
    text = "\n".join(bench.tables(result)) + json.dumps(result)
    assert "SECRET" not in text
    assert "another.model" not in text
    assert "what the founder said" not in text
    for s in SCENARIOS:
        assert s.venture["name"] not in text
        assert s.founder not in text
    assert result["budget_reached"] is True
    assert result["cases_read"] == 20
    read_cases = bench.chosen_cases(CASES, 30)[:20]
    first = result["arms"][0]["all"]
    assert first["failures"] == {"ThrottlingException": 1}
    assert first["sum_drops"] == {"input": 1, "other": 1}
    assert first["text_drops"] == {"points:number": 1}
    assert first["inputs"] == {"named": 4, "found": 3, "anywhere": 4}
    assert (first["cases"], first["ok"], first["late"]) == (20, 19, 1)
    assert first["ms"] == {"p50": 900, "p95": 900}
    assert first["usd_per_1000"] == 2.0
    assert first["parts"]["route"] == {
        "calls": 20,
        "skipped": 0,
        "again": 0,
        "ok": 20,
        "failures": {},
        "ms": {"p50": 900, "p95": 900},
        "late": 0,
        "tokens": {"input": 3000, "cached": 2000, "output": 90},
        "cost_usd": 0.02,
    }
    assert (first["parts"]["sums"]["calls"], first["parts"]["sums"]["skipped"]) == (0, 20)
    assert (first["parts"]["judge"]["late"], first["parts"]["judge"]["ms"]["p95"]) == (20, 1400)
    assert first["in_time"]["read"] == 19
    assert result["caps"] == {"text": 3000, "voice": 1400}
    assert "3000 ms typed, 1400 ms on a call" in text
    # Every case counts, whatever became of its call.
    assert (
        first["measures"]["no_false_referral"]["n"]
        + first["measures"].get("referral", {"n": 0})["n"]
        + sum(1 for c in read_cases if not c.expect.referral and "referral" in c.turn.judge)
        == 20
    )


def test_no_report_is_said_so() -> None:
    assert "no report" in bench.tables({"report": False, "script_exit": 3})[0]


# Running ------------------------------------------------------------------------------------------------------------


def test_a_run_writes_its_cases_grades_what_was_read_and_prints_neither(tmp_path: Path) -> None:
    seen: list[list[str]] = []

    def runner(cmd: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        seen.append(cmd)
        out = Path(cmd[cmd.index("--out") + 1])
        cases = json.loads(Path(cmd[cmd.index("--cases") + 1]).read_text(encoding="utf-8"))["cases"]
        rows = [row(a, c["id"]) for a in bench.arms(LAB, NOVA) for c in cases]
        (out / "private" / bench.REPORT_FILE).write_text(
            json.dumps({"report": {"budgetReached": False}, "rows": rows}), encoding="utf-8"
        )
        return subprocess.CompletedProcess(cmd, 0, b"{}", b"")

    result, code = bench.run_understand(
        tmp_path,
        env={},
        budget_usd=1.0,
        pnpm="pnpm",
        lab=LAB,
        groups=("numbers", "heldout"),
        model=NOVA,
        today=DAY,
        runner=runner,
    )
    assert code == 0
    assert set(result["groups"]) == {"numbers", "heldout"}
    assert seen[0][seen[0].index("--budget-usd") + 1] == "1.00"
    assert seen[0][-2:] == ["--candidates", NOVA]
    grades = json.loads((tmp_path / "private" / bench.GRADES_FILE).read_text(encoding="utf-8"))
    assert len(grades) == result["cases_read"] * 2
    assert {g["contradicts"] for g in grades} == {None}
    assert not list((tmp_path).glob("public/*"))


def ran(tmp_path: Path, **over: object) -> tuple[list[str], list[str]]:
    """The command of a run and the ids of the cases it was given."""
    seen: list[str] = []
    ids: list[str] = []

    def runner(cmd: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        seen.extend(cmd)
        doc = json.loads(Path(cmd[cmd.index("--cases") + 1]).read_text(encoding="utf-8"))
        ids.extend(c["id"] for c in doc["cases"])
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    bench.run_understand(
        tmp_path, env={}, budget_usd=2.0, pnpm="pnpm", lab=LAB, model=NOVA, today=DAY, runner=runner, **over
    )
    return seen, ids


@pytest.mark.parametrize("group", sorted(bench.UNSEEN))
def test_an_unseen_group_is_read_only_where_it_is_named(tmp_path: Path, group: str) -> None:
    unseen = {s.id for s in SCENARIOS if s.group == group}
    assert len(unseen) == 16
    named = sorted(unseen)[0]
    of = {
        "default": ran(tmp_path / "a")[1],
        "group": ran(tmp_path / "b", groups=(group,))[1],
        "scenario": ran(tmp_path / "c", scenario_ids=(named,))[1],
    }
    assert of["default"]
    assert not [i for i in of["default"] if i.split(":")[0] in unseen]
    assert [i for i in of["default"] if i.startswith("HO-")]
    assert {i.split(":")[0] for i in of["group"]} <= unseen
    assert of["group"]
    assert {i.split(":")[0] for i in of["scenario"]} == {named}


def test_the_caps_reach_the_script_and_the_api_process(tmp_path: Path) -> None:
    caps = config.understand_caps("4500, 2500")
    assert caps == config.UnderstandCaps(4_500, 2_500)
    cmd, _ = ran(tmp_path / "a", caps=caps)
    assert (cmd[cmd.index("--typed-ms") + 1], cmd[cmd.index("--voice-ms") + 1]) == ("4500", "2500")
    assert "--typed-ms" not in ran(tmp_path / "b")[0]
    assert config.understand_env("on", "", LAB, caps) == {
        "CORE_UNDERSTAND": "on",
        "CORE_UNDERSTAND_TYPED_MS": "4500",
        "CORE_UNDERSTAND_VOICE_MS": "2500",
    }
    assert config.understand_caps("") is None
    for wrong in ("4500", "4500,2500,1", "a,b", "100,2000", "20000,2000", "4500,9000", "45 00,2000"):
        with pytest.raises(ValueError, match="understand_ms"):
            config.understand_caps(wrong)
    with pytest.raises(ValueError, match="understand_ms"):
        config.understand_env("off", "", LAB, caps)


def test_own_cases_are_the_suites_own_in_two_halves() -> None:
    own = understand_own.load_own()
    sums = [c for c in own if c.id.startswith("US-")]
    assert len(sums) >= 48
    assert len(own) - len(sums) >= 38
    for some in (sums, own):
        assert abs(sum(c.held for c in some) - sum(not c.held for c in some)) <= 4
    for c in own:
        assert json.dumps(understand_own.own_case_json(c, DAY))
        assert c.expect
    # Every shape of sum stands in both halves, so that the held one tells of the same work.
    for half in (True, False):
        assert {"commission", "break-even", "price", "same-but", "total", "hours", "runway", "costs"} <= {
            c.tag for c in sums if c.held is half
        }


def test_own_cases_are_in_no_scenarios_words() -> None:
    told = " ".join(
        " ".join(re.findall(r"[a-z0-9']+", text.lower()))
        for c in understand_own.load_own()
        for text in (c.say, *c.record, *(x for pair in c.talk for x in pair))
    )
    for path in sorted(CLIENT_DIR.glob("*.yaml")):
        for s in yaml.safe_load(path.read_text(encoding="utf-8"))["scenarios"]:
            for turn in (t for session in s["sessions"] for t in session["turns"]):
                words = re.findall(r"[a-z0-9']+", turn["say"].lower())
                shared = sum(1 for i in range(len(words) - 5) if " ".join(words[i : i + 6]) in told)
                assert shared == 0, s["id"]


def test_own_grades() -> None:
    def own(**expect: object) -> understand_own.OwnCase:
        return understand_own.OwnCase("US-99", False, "x", "say", expect=expect)

    grade = understand_own.own_grade
    asked = {"sums": [{"value": 12.0, "asked": True}]}
    assert grade(own(number=("12", "12.5")), asked) == {"number": True}
    assert grade(own(number=("13",)), asked) == {"number": False}
    assert grade(own(number=("12",)), {"sums": [{"value": 12.0, "asked": False}]}) == {"number": False}
    assert grade(own(none=True), asked) == {"no_figure": False}
    assert grade(own(missing=True), {"sums": [], "missing": "what one costs"}) == {"missing": True}
    assert grade(own(no_result=True), {"result": None, "kind": "feelings"}) == {"no_result": True}
    assert grade(own(no_result=True), None) == {"no_result": False}
    shown = {"result": {"verdict": "weak", "shows": "Two of nine paid.", "settles": "Ask ten."}}
    assert grade(own(shows=("nine",), verdicts=("weak",), settles=True), shown) == {
        "shows": True,
        "settles": False,
        "verdict": True,
    }
    assert understand_own.testable("Ask 10 to pay: 4 or more, keep it; fewer, change it.")
    assert understand_own.testable("If five of ten come back, go on; if fewer, stop.")
    assert not understand_own.testable("Ask 10 of them to pay and count who does.")
    assert grade(own(referral=("legal",)), {"referral": "equity"}) == {"referral": False}
    assert grade(own(no_referral=True), {"referral": None}) == {"no_referral": True}
    assert grade(own(second=("price",)), {"ask": "x", "secondAsk": "what to price it"}) == {"second": True}
    assert grade(own(second=("price",)), {"ask": "the price", "secondAsk": None}) == {"second": False}
    pick = {"choice": {"pick": "the five dollars"}}
    assert grade(own(pick=("five",), not_pick=("free",)), pick) == {"pick": True}
    assert grade(own(first=("letter",)), {"points": ["Answer the letter first."]}) == {"first": True}
    assert grade(own(kind=("feelings",)), {"kind": "question", "also": ["feelings"]}) == {"kind": True}


def test_the_held_back_half_is_counted_and_kept_nowhere(tmp_path: Path) -> None:
    held = {c.case_id for c in understand_own.load_own() if c.held}

    def runner(cmd: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        out = Path(cmd[cmd.index("--out") + 1])
        cases = json.loads(Path(cmd[cmd.index("--cases") + 1]).read_text(encoding="utf-8"))["cases"]
        rows = [row(a, c["id"]) for a in bench.arms(LAB, NOVA) for c in cases]
        (out / "private" / bench.REPORT_FILE).write_text(
            json.dumps({"report": {}, "rows": rows}), encoding="utf-8"
        )
        return subprocess.CompletedProcess(cmd, 0, b"{}", b"")

    result, code = bench.run_understand(
        tmp_path,
        env={},
        budget_usd=2.0,
        pnpm="pnpm",
        lab=LAB,
        groups=("own", "ownheld"),
        model=NOVA,
        today=DAY,
        runner=runner,
    )
    assert code == 0
    assert held
    assert result["own"][0]["held"]["cases"] == len(held)
    kept = "".join(p.read_text(encoding="utf-8") for p in (tmp_path / "private").glob("*.json"))
    assert not [i for i in held if i in kept]
    assert "Own cases, the held-back half" in "\n".join(bench.tables(result))
    # One half alone, and none where client groups alone are named.
    assert {c.group for c in bench.own_cases(("own",), ())} == {"own"}
    assert bench.own_cases(("numbers",), ()) == []
    assert [c.id for c in bench.own_cases((), ("US-01",))] == ["US-01"]


def test_a_script_that_wrote_nothing_is_no_result(tmp_path: Path) -> None:
    def runner(cmd: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(cmd, 1)

    result, code = bench.run_understand(
        tmp_path, env={}, budget_usd=1.0, pnpm="pnpm", lab=LAB, model=NOVA, today=DAY, runner=runner
    )
    assert (result["report"], code) == (False, 124)


def test_the_command_refuses_what_it_does_not_offer(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    base = ["run", "--suite", "understand", "--out", str(tmp_path / "o"), "--mock"]
    assert cli.main([*base, "--budget-usd", "2.5"]) == 2
    assert "at most USD 2" in capsys.readouterr().err
    assert cli.main([*base, "--budget-usd", "1", "--understand-model", "us.amazon.nova-pro-v1:0"]) == 2
    assert cli.main([*base, "--budget-usd", "1", "--groups", "sums"]) == 2
    assert cli.main([*base, "--budget-usd", "1", "--understand-ms", "9"]) == 2
    assert not (tmp_path / "o").exists()


def test_the_client_suites_inputs_reach_the_api_process_alone() -> None:
    from conversation_lab.stack import api_env

    models = config.app_models()
    plain = api_env({}, models=models, database_url="d", speech=False)
    assert not [k for k in plain if "UNDERSTAND" in k]
    on = api_env(
        {}, models=models, database_url="d", speech=False, understand=config.understand_env("on", NOVA, LAB)
    )
    assert (on["CORE_UNDERSTAND"], on["MODEL_UNDERSTAND_ID"]) == ("on", NOVA)


def test_the_workflow_runs_the_suite_without_an_app_under_its_cap() -> None:
    path = config.REPO / ".github" / "workflows" / "ops-conversation-lab.yml"
    text = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    assert "understand" in doc[True]["workflow_dispatch"]["inputs"]["suite"]["options"]
    steps = doc["jobs"]["lab"]["steps"]
    for name in ("Install Playwright Chromium", "Build the web app", "Reset and seed the lab database"):
        step = next(s for s in steps if s.get("name") == name)
        assert "matrix.suite != 'understand'" in step["if"]
    assert "the understand suite takes at most USD 2" in text


def test_no_prompt_or_rule_of_the_call_holds_the_wording_of_a_scenario() -> None:
    """The call is never tuned on what it is measured on: no five words in a row of a founder's line are in its prompt,
    checks, rules or tests, nor four of a held-out one."""
    packages = config.REPO / "packages"
    files = [
        *sorted((packages / "ai" / "src" / "understand").glob("*.ts")),
        packages / "ai" / "src" / "gateway" / "mock-understand.ts",
        *sorted((packages / "core" / "src" / "orchestrator").glob("understand*.ts")),
        *sorted((packages / "core" / "src" / "path").glob("record-lines*.ts")),
    ]
    plain = {p: " ".join(re.findall(r"[a-z0-9']+", p.read_text(encoding="utf-8").lower())) for p in files}
    for path in sorted(CLIENT_DIR.glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        size = 4 if doc["group"] in HELD_OUT else 5
        found: Counter[str] = Counter()
        for s in doc["scenarios"]:
            for turn in (t for session in s["sessions"] for t in session["turns"]):
                words = re.findall(r"[a-z0-9']+", turn["say"].lower())
                runs = {" ".join(words[i : i + size]) for i in range(len(words) - size + 1)}
                counts = {p.name: n for p, text in plain.items() if (n := sum(1 for r in runs if r in text))}
                found.update(counts)
                # A number alone: a failure shows no wording, and of an unseen group not even which scenario.
                if doc["group"] not in bench.UNSEEN:
                    assert sum(counts.values()) == 0, s["id"]
        if found:
            pytest.fail(f"{doc['group']} shares wording with {dict(found)}", pytrace=False)
