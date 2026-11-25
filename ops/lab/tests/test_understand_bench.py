from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
from pathlib import Path

import pytest
import yaml

from conversation_lab import cli, config
from conversation_lab import understand_bench as bench
from conversation_lab.client.scenarios import CLIENT_DIR, Expect, FounderTurn, load

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
        "raw": {"ask": "SECRET WORDS"},
        "understanding": read(),
        "anywhere": read(),
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
    assert 60 <= bench.affordable(LAB, every, 2.0) < len(CASES)
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


def test_picks_news_history_kinds_and_friends() -> None:
    pick = case(pick=("flyers", "no"))
    assert bench.grade(pick, read(choice={"pick": "The flyers first"}, kind="choice"), None)["pick"]
    assert bench.grade(pick, read(choice={"pick": "nothing now"}), None)["pick"] is False
    assert bench.grade(pick, read(choice={"pick": "Both"}), None)["pick"]
    news = case(news=("kits",))
    shown = {"verdict": "mixed", "shows": "Seven kits went."}
    assert bench.grade(news, read(result=shown, kind="result"), None)["news"]
    assert bench.grade(news, read(result={"verdict": "mixed", "shows": "It went."}), None)["news"] is False
    assert bench.grade(news, read(points=["Seven kits went."]), None)["news"] is False
    history = case(history=("costs",))
    assert bench.grade(history, read(record=[{"text": "A kit sells for 24 dollars."}]), None)["history"]
    assert bench.grade(history, read(record=[{"text": "Clay is brown."}]), None)["history"] is False
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
        anywhere=None,
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
        {"budgetReached": True}, rows, cases, exit_code=0, available=len(CASES), known=names
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
    first = result["arms"][0]["all"]
    assert first["failures"] == {"ThrottlingException": 1}
    assert first["sum_drops"] == {"input": 1, "other": 1}
    assert first["text_drops"] == {"points:number": 1}
    assert first["inputs"] == {"named": 4, "found": 3, "anywhere": 4}
    assert (first["cases"], first["ok"], first["late"]) == (20, 19, 1)
    assert first["ms"] == {"p50": 900, "p95": 900}
    assert first["usd_per_1000"] == 2.0
    # Every case counts, whatever became of its call.
    assert (
        first["measures"]["no_false_referral"]["n"] + first["measures"].get("referral", {"n": 0})["n"] == 20
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
    assert not list((tmp_path).glob("public/*"))


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
    sources = "\n".join(p.read_text(encoding="utf-8") for p in files)
    plain = " ".join(re.findall(r"[a-z0-9']+", sources.lower()))
    for path in sorted(CLIENT_DIR.glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        size = 4 if doc["group"] == "heldout" else 5
        for s in doc["scenarios"]:
            for turn in (t for session in s["sessions"] for t in session["turns"]):
                words = re.findall(r"[a-z0-9']+", turn["say"].lower())
                runs = {" ".join(words[i : i + size]) for i in range(len(words) - size + 1)}
                shared = [r for r in runs if r in plain]
                assert not shared, (s["id"], len(shared))
