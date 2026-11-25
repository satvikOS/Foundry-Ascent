"""The client run's cost, planned before anything runs, its groups, and the coach and judge it may use."""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import re
from collections import Counter
from pathlib import Path

import pytest
import yaml

from conversation_lab import cli, config
from conversation_lab.bedrock import LabModelClient, request_fields
from conversation_lab.budget import Ledger, SpendGuard
from conversation_lab.client import calibration, suite
from conversation_lab.client import plan as plan_module
from conversation_lab.client.judge import judge_candidates
from conversation_lab.client.plan import (
    PLAN_LIMIT_USD,
    estimate,
    followed_sessions,
    in_groups,
    judged_turns,
    parse_groups,
    refusal,
)
from conversation_lab.client.scenarios import GROUPS, HELD_OUT, ScenarioError, load
from tests.conftest import AwsError, FakeConverse

DAY = dt.date(2026, 11, 25)
LAB = config.lab_models()
NOVA = "us.amazon.nova-2-lite-v1:0"
HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
HAIKU_5_5 = "us.anthropic.claude-haiku-5-5"
LUNA = "us.openai.gpt-6-luna"
ALL = list(load(DAY).scenarios)
#: What an unnamed run plays: the held-out groups are beside it.
EVERY = in_groups(ALL, ())


def plan(scenarios=EVERY, coach: str = NOVA, judge: str = HAIKU, think: str = "default"):
    return estimate(
        scenarios,
        prices=LAB.prices,
        coach=coach,
        judge=judge,
        simulator=LAB.live_simulator[0],
        calibration_cases=len(calibration.load()),
        think=think,
    )


def test_the_whole_set_fits_under_the_owners_cap_with_the_strict_judge() -> None:
    found = plan()
    assert found.total_usd <= PLAN_LIMIT_USD < suite.CLIENT_HARD_CAP_USD
    assert found.turns == sum(s.turns for s in EVERY)
    assert found.judged == sum(judged_turns(s) for s in EVERY)
    # Both sides have the same room above their estimate.
    app, lab = config.budget_parts("client", 2.0, found.app_share)
    assert app > found.app_usd
    assert lab > found.lab_usd


def test_the_estimate_is_what_the_first_run_cost() -> None:
    """The first live run on Nova 2 Lite: 170 turns, 86 conversations ended, USD 1.16 of the app's."""
    first = in_groups(EVERY, ("protocol", "questions", "organise", "calls", "arcs", "repeats", "adversarial"))
    assert sum(s.turns for s in first) == 170
    found = plan(first)
    ended = sum(len(s.sessions) * s.repeat for s in first)
    assert ended == 86
    every_one_ended = found.app_usd + (ended - sum(followed_sessions(s) for s in first)) * 0.0066
    assert every_one_ended == pytest.approx(1.16, abs=0.06)


def test_growth_covers_the_gaps_of_the_first_run() -> None:
    by_group: Counter[str] = Counter()
    for s in EVERY:
        by_group[s.group] += s.turns
    assert by_group["numbers"] == 12
    assert by_group["news"] == 8
    assert by_group["followups"] >= 6
    assert by_group["novice"] == 6
    assert by_group["odd"] == 10
    assert sum(by_group[g] for g in GROUPS[5:12]) >= 60
    turns = {g: [t for s in EVERY if s.group == g for x in s.sessions for t in x.turns] for g in GROUPS}
    assert all(t.expect.number for t in turns["numbers"])
    assert all(t.expect.news and t.expect.kind == "report" for t in turns["news"])
    assert all(t.expect.adapt for t in turns["novice"])
    long = next(s for s in EVERY if s.group == "memory")
    assert len(long.sessions) == 5
    assert sum(x.gap_days for x in long.sessions) == 42
    four_ways = next(s for s in EVERY if s.same_step)
    assert len(four_ways.same_step) == 4


def test_a_run_that_would_not_fit_is_refused_with_the_numbers() -> None:
    dear = dataclasses.replace(LAB, client_coach=("us.anthropic.claude-sonnet-4-6",))
    found = estimate(
        EVERY,
        prices=dear.prices,
        coach="us.anthropic.claude-sonnet-4-6",
        judge=NOVA,
        simulator=None,
    )
    why = refusal(found, 2.0, EVERY, prices=LAB.prices, coach="us.anthropic.claude-sonnet-4-6", judge=NOVA)
    assert why is not None
    assert f"USD {found.total_usd:.2f}" in why
    assert "Choose groups (--groups): protocol " in why
    assert "memory " in why
    assert refusal(plan(), 2.0, EVERY, prices=LAB.prices, coach=NOVA, judge=HAIKU) is None
    # A smaller budget than the plan's limit is the limit.
    assert refusal(plan(), 1.0, EVERY, prices=LAB.prices, coach=NOVA, judge=HAIKU) is not None
    some = in_groups(EVERY, parse_groups("numbers,news"))
    assert refusal(plan(some), 1.0, some, prices=LAB.prices, coach=NOVA, judge=HAIKU) is None


def test_a_refused_run_calls_and_seeds_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("E2E_OWNER_ACCESS_CODE", "FA-TEST")
    monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/none")
    monkeypatch.setattr(suite, "seed", lambda *_a: pytest.fail("seeded"))
    base = ["run", "--suite", "client", "--out", str(tmp_path / "out")]
    assert cli.main([*base, "--budget-usd", "1"]) == 2
    err = capsys.readouterr().err
    assert "estimated at USD" in err
    assert "Choose groups" in err
    assert cli.main([*base, "--budget-usd", "2", "--groups", "sums"]) == 2
    assert "unknown groups: sums" in capsys.readouterr().err
    assert cli.main([*base, "--budget-usd", "2", "--coach-model", "us.anthropic.claude-sonnet-4-6"]) == 2
    assert "coach_model must be default or one of" in capsys.readouterr().err
    args = ["--coach-model", HAIKU_5_5, "--judge-model", HAIKU]
    assert cli.main([*base, "--budget-usd", "2", *args]) == 2
    assert "own family" in capsys.readouterr().err
    assert not list((tmp_path / "out").rglob("lab-ledger.jsonl"))


def test_groups_are_read_in_run_order() -> None:
    assert parse_groups("") == ()
    assert parse_groups("news, numbers") == ("numbers", "news")
    with pytest.raises(ScenarioError, match="unknown groups: x"):
        parse_groups("numbers,x")
    assert {s.group for s in in_groups(EVERY, ("odd",))} == {"odd"}
    assert len(in_groups(EVERY, ())) == len(EVERY)


@pytest.mark.parametrize(
    ("group", "first"), [("heldout", "HO-01"), ("heldoutb", "HB-01"), ("heldoutc", "HC-01")]
)
def test_a_held_out_group_is_played_only_when_named(group: str, first: str) -> None:
    assert group in HELD_OUT
    assert group not in {s.group for s in EVERY}
    held = in_groups(ALL, parse_groups(group))
    assert len(held) == 16
    assert {s.group for s in held} == {group}
    assert len(ALL) == len(EVERY) + len(in_groups(ALL, tuple(HELD_OUT)))
    assert all(judged_turns(s) for s in held)
    assert plan(held, think="typed").total_usd <= PLAN_LIMIT_USD
    assert [s.id for s in suite.planned((first, "CP-01"), "", DAY)] == ["CP-01", first]
    assert suite.planned((), "", DAY) == EVERY
    assert [s.id for s in suite.planned((), group, DAY)] == [s.id for s in held]


@pytest.mark.parametrize(("group", "with_calls"), [("heldoutb", 3), ("heldoutc", 4)])
def test_a_later_held_out_group_is_nearly_all_judged(group: str, with_calls: int) -> None:
    held = in_groups(ALL, parse_groups(group))
    turns = sum(s.turns for s in held)
    assert 60 <= turns <= 75
    assert sum(judged_turns(s) for s in held) >= turns - 2
    assert sum(1 for s in held if any(x.channel == "call" for x in s.sessions)) == with_calls


# The models ---------------------------------------------------------------------------------------------------------


def test_the_coach_a_b_offers_haiku_5_5_and_luna_to_the_lab_alone() -> None:
    assert {HAIKU_5_5, "global.anthropic.claude-haiku-5-5", LUNA} <= set(LAB.client_coach)
    app = config.coach_app_models(HAIKU_5_5, LAB, offered=LAB.client_coach)
    assert (app.primary, app.fallback) == (HAIKU_5_5, HAIKU_5_5)
    assert app.background == config.app_models().background
    # The live suite does not offer it, and production is none of it.
    with pytest.raises(ValueError, match="coach_model must be"):
        config.coach_app_models(HAIKU_5_5, LAB)
    assert config.app_models().primary == NOVA
    assert "haiku-5" not in config.PRODUCTION_CONFIG.read_text(encoding="utf-8").replace("haiku-5-5 ", "")
    # Never below its list price, and planned at no less than Nova's.
    assert LAB.prices["anthropic.claude-haiku-5-5"].input >= 0.11
    assert LAB.prices["anthropic.claude-haiku-5-5"].output >= 0.55
    judge = "us.amazon.nova-pro-v1:0"
    assert plan(coach=HAIKU_5_5, judge=judge).app_usd == plan().app_usd


def test_the_open_weight_candidates_are_offered_to_the_lab_alone_and_judged_by_another_family() -> None:
    for coach in (
        "openai.gpt-oss-120b-1:0",
        "openai.gpt-oss-20b-1:0",
        "qwen.qwen3-next-80b-a3b",
        "deepseek.v3.2",
        "mistral.mistral-large-3-675b-instruct",
    ):
        app = config.coach_app_models(coach, LAB, offered=LAB.client_coach)
        assert (app.primary, app.fallback) == (coach, coach)
        assert judge_candidates(coach, LAB)[0] == HAIKU
        # The whole set or some of its groups: what does not fit is refused before any call.
        assert plan(in_groups(EVERY, ("numbers", "news")), coach=coach).total_usd <= PLAN_LIMIT_USD / 2
        assert coach not in config.PRODUCTION_CONFIG.read_text(encoding="utf-8")


def test_reasoning_is_planned_for() -> None:
    off, judgement, typed = (plan(think=t).app_usd for t in ("off", "judgement", "typed"))
    assert plan().app_usd == off < judgement < typed
    assert typed - off < 0.5
    # The groups it is for fit; the whole set does not, and is refused with each group's estimate.
    assert (
        plan(in_groups(EVERY, ("news", "followups", "hard")), think="judgement").total_usd <= PLAN_LIMIT_USD
    )
    assert set(plan_module.THINK_SHARE) | {"default", "off"} == set(config.THINK_CHOICES)


def test_the_understand_call_is_planned_for() -> None:
    def planned(understand: bool, model: str | None = None) -> float:
        return estimate(
            EVERY,
            prices=LAB.prices,
            coach=NOVA,
            judge=None,
            simulator=None,
            understand=understand,
            understand_model=model,
        ).app_usd

    off, nova = planned(False), planned(True)
    assert off < planned(True, "openai.gpt-oss-20b-1:0") < nova
    # Every turn pays for it: a run that would not fit is refused before any call.
    assert nova - off < 1.0
    held = in_groups(ALL, ("heldout",))
    assert (
        estimate(held, prices=LAB.prices, coach=NOVA, judge=HAIKU, simulator=None, understand=True).total_usd
        <= PLAN_LIMIT_USD
    )


def test_each_model_family_gets_the_request_it_takes() -> None:
    assert request_fields(NOVA, 4, 0.0) == {"inferenceConfig": {"maxTokens": 4, "temperature": 0.0}}
    assert request_fields(HAIKU, 9, 0.0) == {"inferenceConfig": {"maxTokens": 9, "temperature": 0.0}}
    # Haiku 5.5 thinks by default and takes no temperature; its thinking is turned off.
    for model in (HAIKU_5_5, "global.anthropic.claude-haiku-5-5"):
        assert request_fields(model, 64, 0.0) == {
            "inferenceConfig": {"maxTokens": 64},
            "additionalModelRequestFields": {"thinking": {"type": "disabled"}},
        }
    assert request_fields("us.anthropic.claude-opus-5-5", 64, 0.0) == {"inferenceConfig": {"maxTokens": 64}}
    # gpt-oss always reasons, the least it takes, asked with the flat field.
    assert request_fields("openai.gpt-oss-20b-1:0", 64, 0.0) == {
        "inferenceConfig": {"maxTokens": 64, "temperature": 0.0},
        "additionalModelRequestFields": {"reasoning_effort": "low"},
    }
    assert request_fields("deepseek.v3.2", 4, 0.0) == {
        "inferenceConfig": {"maxTokens": 4, "temperature": 0.0}
    }
    luna = request_fields(LUNA, 64, 0.0)
    assert luna["additionalModelRequestFields"] == {"reasoning": {"effort": "none"}}


def test_what_aws_said_is_kept_for_the_sealed_report_with_accounts_masked(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "l.jsonl")
    said = "User arn:aws:sts::123456789012:assumed-role/Lab/x: model access is denied for this account"
    fake = FakeConverse([AwsError("AccessDeniedException", said), AwsError("AccessDeniedException", said)])
    models = LabModelClient(
        client=fake,
        prices=LAB.prices,
        guard=SpendGuard(app_budget=1, lab_budget=1, ledger=ledger),
        ledger=ledger,
    )
    result = models.probe((HAIKU_5_5, LUNA))
    assert result.chosen is None
    assert result.outcomes == {HAIKU_5_5: "AccessDeniedException", LUNA: "AccessDeniedException"}
    assert [r.model for r in models.refusals] == [HAIKU_5_5, LUNA]
    assert "model access is denied" in models.refusals[0].message
    assert "123456789012" not in models.refusals[0].message
    # A model that thinks before its first word is given room for it.
    assert fake.requests[0]["inferenceConfig"]["maxTokens"] == 64
    ctx = cli.Context(suite="client", out=tmp_path, budget_usd=2.0, max_scenarios=1, recall_gap_seconds=None)
    ctx.private.mkdir(parents=True)
    cli._write_refusals(ctx, models)
    kept = json.loads((ctx.private / "model-refusals.json").read_text(encoding="utf-8"))
    assert kept[0]["code"] == "AccessDeniedException"


# The workflow -------------------------------------------------------------------------------------------------------


def workflow() -> tuple[str, dict]:
    path = config.REPO / ".github" / "workflows" / "ops-conversation-lab.yml"
    text = path.read_text(encoding="utf-8")
    return text, yaml.safe_load(text)


def test_the_workflow_offers_the_groups_the_coaches_and_the_judges_of_the_code() -> None:
    text, doc = workflow()
    inputs = doc[True]["workflow_dispatch"]["inputs"]
    assert inputs["coach_model"]["options"] == [config.DEFAULT_COACH, *LAB.client_coach]
    assert inputs["judge_model"]["options"] == [config.JUDGE_AUTO, *LAB.client_judge]
    assert inputs["coach_model"]["default"] == config.DEFAULT_COACH
    assert inputs["understand"]["options"] == list(config.UNDERSTAND_CHOICES)
    assert inputs["understand_model"]["options"] == [config.DEFAULT_UNDERSTAND, *LAB.understand_models]
    assert inputs["groups"]["default"] == ""
    listed = re.search(r"for known in ([a-z ]+); do", text)
    assert listed is not None
    assert tuple(listed.group(1).split()) == GROUPS
    run = next(s for s in doc["jobs"]["lab"]["steps"] if "conversation_lab run" in json.dumps(s))
    for flag in (
        '--groups "${LAB_GROUPS}"',
        '--coach-model "${LAB_COACH_MODEL}"',
        '--judge-model "${LAB_JUDGE_MODEL}"',
        '--understand "${LAB_UNDERSTAND}"',
        '--understand-model "${LAB_UNDERSTAND_MODEL}"',
    ):
        assert flag in run["run"]
    # Only the client suite is given them.
    env = doc["jobs"]["lab"]["env"]
    for name in (
        "LAB_GROUPS",
        "LAB_COACH_MODEL",
        "LAB_JUDGE_MODEL",
        "LAB_UNDERSTAND",
        "LAB_UNDERSTAND_MODEL",
    ):
        assert "matrix.suite == 'client'" in env[name]
