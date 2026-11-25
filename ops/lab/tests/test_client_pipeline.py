"""The client suite end to end on an in-process fake app (no network, no model): the runner, the judge and its caps, the
public summary that carries no text, the filled log, and the suite's wiring and hard cap."""

from __future__ import annotations

import csv
import datetime as dt
import json
import os
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import yaml

from conversation_lab import cli, config
from conversation_lab.bedrock import LabModelClient, ModelCallError
from conversation_lab.budget import BudgetExceededError
from conversation_lab.client import report, rubric, suite
from conversation_lab.client.app import founder_intake, parse_seed, run_seed, save_intake, seed_plan
from conversation_lab.client.graders import Grade
from conversation_lab.client.judge import (
    CAPS,
    ClientJudge,
    Scorecard,
    capped,
    judge_candidates,
    parse_scores,
    system_prompt,
)
from conversation_lab.client.report import aggregate, gates_failed, render, safe_cell, write_private
from conversation_lab.client.rubric import CRITERIA
from conversation_lab.client.runner import ClientRunner
from conversation_lab.client.scenarios import choose, load
from conversation_lab.live.fake import FakeApp, FakeClient
from conversation_lab.simulator import TemplateSimulator
from foundry_evals.client import ApiError
from tests.conftest import PRICES, FakeConverse

DAY = dt.date(2026, 11, 24)
STEP = {
    "id": "s1",
    "playId": "ask-strangers",
    "criterionId": "five",
    "title": "Ask five strangers to pay",
    "items": [{"do": "Write one line with a price", "how": "Short.", "minutes": 20}],
    "doneWhen": "Five answers are written down",
    "dueOn": "2026-11-27",
}
GUIDANCE = {
    "intent": "next",
    "playId": "ask-strangers",
    "stage": "idea",
    "stageTitle": "Idea",
    "stageNumber": 1,
    "stageCount": 7,
    "step": STEP,
    "then": [],
    "referral": None,
    "citations": [],
}
REPLY = "Sell one before you build it. Next step: ask five strangers to pay by Friday."


class GuidedClient(FakeClient):
    """The fake founder client, with the stored turn's guidance and usage as the API returns them."""

    def end_session(self, session_id: str) -> None:
        self.app.ended = [*getattr(self.app, "ended", []), session_id]  # type: ignore[attr-defined]

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        found = re.fullmatch(r"/sessions/([\w-]+)", path)
        if method == "GET" and found:
            turns = [
                {
                    "id": o.turn_id,
                    "guidance": self.app.guide(len(self.turns)),  # type: ignore[attr-defined]
                    "evidence": [],
                    "usage": {
                        "modelId": "mock",
                        "costUsd": 0.002,
                        "firstTokenMs": 900,
                        "inputTokens": 4000,
                        "outputTokens": 200,
                    },
                    "response": {"escalation": {"required": False}},
                }
                for o in self.by_key.values()
            ]
            return SimpleNamespace(json=lambda: {"turns": turns})
        if path.endswith("/path"):
            raise ApiError(method=method, path=path, status=404, code="not_found")
        return super().request(method, path, **kwargs)


class GuidedApp(FakeApp):
    guidance: Any = GUIDANCE

    def guide(self, _n: int) -> Any:
        return self.guidance

    def founder_client(self, principal_id: str) -> GuidedClient:
        return GuidedClient(self, principal_id)

    def age_path(self, venture_id: str, days: int) -> str | None:
        self.paths = [*getattr(self, "paths", []), (venture_id, days)]
        return None


class OneJudge:
    """Scores 5 everywhere it is asked."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def score(self, prompt: str, criteria: Any) -> Scorecard:
        self.prompts.append(prompt)
        scores = {c: (5 if c in criteria else None) for c in CRITERIA}
        return Scorecard(scores=dict(scores), raw=dict(scores), note="=cmd quoted words")


def run(app: Any, *ids: str, judge: Any = None, tmp: Path | None = None, **kwargs: Any) -> list[Any]:
    scenarios = choose(load(DAY).scenarios, ids)
    seeded = {s.id: SimpleNamespace(venture_id=f"v-{s.id}", founder_id=f"f-{s.id}") for s in scenarios}
    runner = ClientRunner(
        app=app,
        simulator=TemplateSimulator(),
        judge=judge,
        today=DAY,
        private_dir=tmp,
        concurrency=1,
        pause=lambda _s: None,
        log=lambda _m: None,
        **kwargs,
    )
    results = runner.run(scenarios, seeded)  # type: ignore[arg-type]
    run.stopped = runner.stopped  # type: ignore[attr-defined]
    return results


# The runner ---------------------------------------------------------------------------------------------------------


def test_every_scenario_plays_to_the_end_on_the_fake_app() -> None:
    app = GuidedApp(replies=lambda _t: REPLY, call_intro="Hi there.")
    chosen = load(DAY)
    results = run(app)
    assert len(results) == len(chosen.scenarios)
    assert {r.status for r in results} == {"completed"}
    assert sum(len(r.turns) for r in results) == chosen.turns
    assert all(t.guidance is not None for r in results for t in r.turns)
    # Repeats are never aged; every gap of the others moved the conversation and the venture's path.
    gaps = sum(len(s.sessions) - 1 for s in chosen.scenarios)
    assert len(app.aged) == len(app.paths) == gaps
    # A conversation is ended when another follows (its recap is what that one starts from); the last one is not.
    followed = sum(len(s.sessions) * s.repeat - 1 for s in chosen.scenarios)
    assert len(app.ended) == followed


def test_the_protocol_is_played_in_order_with_the_next_day() -> None:
    app = GuidedApp(replies=lambda _t: REPLY)
    (result,) = run(app, "CP-01")
    assert [t.plan.q for t in result.turns] == [None, "Q20", "Q4", "Q13", "Q14", "X1", "Q19"]
    assert [t.at for t in result.turns][-1] == "2.1"
    assert [d for _, d in app.aged] == [1]


def test_grades_come_from_the_turns_own_guidance() -> None:
    good = run(GuidedApp(replies=lambda _t: REPLY), "RP-01")[0]
    assert good.grades["same_step"].passed is True
    assert all(t.grades["next_step"].passed for t in good.turns)
    none = GuidedApp(replies=lambda _t: REPLY)
    none.guidance = None
    bad = run(none, "RP-01")[0]
    assert bad.grades["same_step"].passed is False
    assert all(t.grades["next_step"].passed is False for t in bad.turns)

    class Moving(GuidedApp):
        def guide(self, n: int) -> Any:
            return {**GUIDANCE, "step": {**STEP, "title": f"Step number {n}"}}

    moved = run(Moving(replies=lambda _t: REPLY), "RP-01")[0]
    assert moved.grades["same_step"].passed is False


def test_the_paths_step_said_to_every_other_ask_is_nagging() -> None:
    path = {**STEP, "playId": "one-page", "title": "Put the idea on one page", "dueOn": "2026-11-30"}
    app = GuidedApp(
        replies=lambda _t: f"{REPLY} Still open on your path: put the idea on one page, by Monday."
    )
    app.guidance = {**GUIDANCE, "pathStep": path, "offered": True}
    (result,) = run(app, "CP-01")
    grades = [t.grades["no_nagging"].passed for t in result.turns if "no_nagging" in t.grades]
    # Twice is a reminder; the third in a row is not.
    assert grades[:3] == [True, True, False]
    quiet = GuidedApp(replies=lambda _t: REPLY)
    quiet.guidance = app.guidance
    (kept,) = run(quiet, "CP-01")
    assert all(t.grades["no_nagging"].passed for t in kept.turns if "no_nagging" in t.grades)


def test_a_dated_record_may_be_said_with_its_day_as_the_days_pass() -> None:
    scenario = choose(load(DAY).scenarios, ["AR-10"])[0]
    kept = next(r for r in scenario.record)
    gap = scenario.sessions[1].gap_days
    days = [DAY - dt.timedelta(days=kept.days_ago), DAY - dt.timedelta(days=kept.days_ago + gap)]
    for day in days:
        app = GuidedApp(replies=lambda _t, d=day: f"You wrote it down on {d:%B} {d.day}. {REPLY}")
        (result,) = run(app, "AR-10")
        asked = next(t for t in result.turns if t.at == "2.1")
        assert asked.grades["grounded_dates"].passed is True
    other = DAY - dt.timedelta(days=200)
    (wrong,) = run(
        GuidedApp(replies=lambda _t: f"You wrote it down on {other:%B} {other.day}. {REPLY}"), "AR-10"
    )
    assert next(t for t in wrong.turns if t.at == "2.1").grades["grounded_dates"].passed is False


def test_memory_and_leaks_are_caught_across_sessions() -> None:
    forgot = run(GuidedApp(replies=lambda _t: "Your idea is a meal planner for parents."), "CP-01")[0]
    last = forgot.turns[-1]
    assert last.grades["remembers"].passed is False
    leaked = run(
        GuidedApp(replies=lambda _t: "They sell grilled cheese by the science library for 35000 dollars."),
        "CP-01",
    )[0]
    assert leaked.turns[3].grades["no_other_venture"].passed is False


def test_a_result_said_with_its_working_may_be_recalled_days_later() -> None:
    said = iter(
        (
            "12 less 7 less 1.50 leaves 3.50 a box.",
            "At 3.50 a box, 40 boxes is 140 dollars.",
            "Fill in the pains first.",
            "It was 3.50 a box, worked out on November 22.",
            "You were going to earn 99.75 a box.",
        )
    )
    result = run(GuidedApp(replies=lambda _t: next(said), call_intro="Hi."), "CL-01")[0]
    figures = [t.grades["grounded_figures"].passed for t in result.turns]
    assert figures == [True, True, True, True, False]
    # The earlier call was two days ago: its date is known.
    assert result.turns[3].grades["grounded_dates"].passed is True


def test_a_refused_turn_ends_the_scenario_and_counts() -> None:
    app = GuidedApp(replies=lambda _t: REPLY, fail_on="SliceDash")
    app.fail_on = "bike"
    result = run(app, "CQ-01")[0]
    assert (result.status, result.reason) == ("failed", "model_error")
    assert result.turns[0].grades["answered"].passed is False
    summary = aggregate([result], {"evidence": "live", "wording": "equivalent"})
    assert summary["turns"] == {"planned": 2, "run": 1, "coaching": 1, "with_guidance": 0}
    assert next(g for g in summary["gates"] if g["gate"] == "every planned turn answered")["passed"] is False


def test_a_budget_stop_skips_the_rest_and_is_not_a_pass() -> None:
    class Guard:
        calls = 0

        def check_app(self, reserve: float = 0.0) -> float:
            Guard.calls += 1
            if Guard.calls > 1:
                raise BudgetExceededError("app")
            return 0.0

    results = run(GuidedApp(replies=lambda _t: REPLY), "RP-01", "RP-02", "RP-03", guard=Guard())
    assert [r.status for r in results] == ["completed", "skipped", "skipped"]
    assert run.stopped == "budget_app"  # type: ignore[attr-defined]


def test_the_intake_is_saved_or_its_absence_is_noted() -> None:
    result = run(GuidedApp(replies=lambda _t: REPLY), "OR-01")[0]
    assert {"intake:unavailable", "profile:saved"} <= set(result.notes)
    # The client's protocol starts from an empty account.
    assert not [n for n in run(GuidedApp(replies=lambda _t: REPLY), "CP-01")[0].notes if "intake" in n]
    by = load(DAY).by_id()
    assert founder_intake(by["CQ-01"]) == {"studies": "first-year, undeclared", "experience": "first_time"}
    assert founder_intake(by["CP-01"]) is None

    class PathClient:
        def __init__(self) -> None:
            self.sent: list[Any] = []

        def request(self, method: str, path: str, json_body: Any = None, **_: Any) -> Any:
            if json_body is not None:
                self.sent.append((method, path, json_body))
            return SimpleNamespace(json=lambda: {"version": 3})

    client = PathClient()
    assert save_intake(client, "v1", {"idea": "x"}) == "saved"
    assert client.sent == [
        ("PUT", "/ventures/v1/path/intake", {"expectedVersion": 3, "intake": {"idea": "x"}})
    ]


# The judge ----------------------------------------------------------------------------------------------------------


CHECKS = {
    "answered": "yes",
    "invented": [],
    "conflict": False,
    "readable": True,
    "own_facts": True,
    "adapted": None,
    "news_read": None,
}


def verdict(checks: dict[str, Any] | None = None, **scores: float | None) -> str:
    return json.dumps(
        {
            "checks": {**CHECKS, **(checks or {})},
            "scores": {**dict.fromkeys(CRITERIA), **scores},
            "reasons": {k: "said the idea" for k, v in scores.items() if v is not None},
        }
    )


def test_the_judge_scores_only_what_the_question_tests() -> None:
    card = parse_scores(verdict(relevance=4, critical=5, privacy=5), ("relevance", "critical"))
    assert card.scores == {**dict.fromkeys(CRITERIA), "relevance": 4, "critical": 5}
    assert card.error is None
    assert parse_scores(verdict(relevance=4), ("relevance", "critical")).error == "bad_score:critical"
    assert parse_scores(verdict(relevance=6), ("relevance",)).error == "bad_score:relevance"
    assert parse_scores("no", ("relevance",)).error == "no_json"
    assert parse_scores("{bad}", ("relevance",)).error == "bad_json"
    assert parse_scores(verdict(relevance=4.6), ("relevance",)).scores["relevance"] == 4
    assert "Privacy / data separation" in system_prompt()
    assert parse_scores(verdict(relevance=4), ("relevance",)).reasons == {"relevance": "said the idea"}


def test_the_judge_must_answer_every_check_first() -> None:
    for broken in (
        {"answered": "maybe"},
        {"invented": "none"},
        {"conflict": None},
        {"readable": "yes"},
        {"own_facts": 1},
    ):
        assert parse_scores(verdict(broken, relevance=4), ("relevance",)).error == "bad_checks"
    no_checks = json.dumps({"scores": {**dict.fromkeys(CRITERIA), "relevance": 5}})
    assert parse_scores(no_checks, ("relevance",)).error == "bad_checks"
    prompt = system_prompt()
    for name in (*CHECKS, "strict entrepreneurship professor", "never an"):
        assert name in prompt


@pytest.mark.parametrize(
    ("checks", "held"),
    [
        ({"answered": "no"}, {"relevance": 1, "actionability": 2, "critical": 2, "ease": 3}),
        ({"answered": "partly"}, {"relevance": 3, "actionability": 4, "critical": 5, "ease": 5}),
        ({"invented": ["a price"]}, {"relevance": 2, "actionability": 5, "critical": 2, "ease": 5}),
        ({"conflict": True}, {"relevance": 5, "actionability": 2, "critical": 5, "ease": 3}),
        ({"readable": False}, {"relevance": 3, "actionability": 3, "critical": 5, "ease": 2}),
        ({"own_facts": False}, {"relevance": 3, "actionability": 5, "critical": 3, "ease": 5}),
        ({"adapted": False}, {"relevance": 3, "actionability": 5, "critical": 5, "ease": 2}),
        ({"news_read": False}, {"relevance": 3, "actionability": 5, "critical": 2, "ease": 5}),
        ({}, {"relevance": 5, "actionability": 5, "critical": 5, "ease": 5}),
    ],
)
def test_a_lenient_score_is_held_to_the_judges_own_checks(
    checks: dict[str, Any], held: dict[str, int]
) -> None:
    """The first live run's judge called a step line relevant: one that says it did not answer cannot."""
    names = ("relevance", "actionability", "critical", "ease")
    card = parse_scores(verdict(checks, relevance=5, actionability=5, critical=5, ease=5), names)
    assert {k: card.scores[k] for k in names} == held
    assert {k: card.raw[k] for k in names} == dict.fromkeys(names, 5)
    assert bool(card.capped) is bool(checks)
    public = json.dumps(card.public())
    assert "a price" not in public
    assert "said the idea" not in public


def test_a_general_answer_is_right_on_a_privacy_or_referral_question() -> None:
    card = parse_scores(verdict({"own_facts": False}, relevance=5, privacy=5), ("relevance", "privacy"))
    assert (card.scores["relevance"], card.scores["privacy"]) == (5, 5)


def test_an_invalid_verdict_is_asked_for_once_more(guard, ledger) -> None:
    converse = FakeConverse([("no json", 100, 10), (verdict(ease=5), 100, 10)])
    models = LabModelClient(client=converse, prices=PRICES, guard=guard, ledger=ledger)
    card = ClientJudge(models, "us.amazon.nova-pro-v1:0").score("reply", ("ease",))
    assert converse.requests[0]["inferenceConfig"]["temperature"] == 0.0
    assert card.scores["ease"] == 5
    assert "was invalid (no_json)" in converse.requests[1]["messages"][-1]["content"][0]["text"]

    class Broken:
        def converse(self, *_a: Any, **_k: Any) -> str:
            raise ModelCallError("AccessDeniedException")

    assert ClientJudge(Broken(), "m").score("reply", ("ease",)).error == "model:AccessDeniedException"

    class Spent:
        def converse(self, *_a: Any, **_k: Any) -> str:
            raise BudgetExceededError("lab")

    # The lab's share spent: the conversation stands, the reply is not scored.
    assert ClientJudge(Spent(), "m").score("reply", ("ease",)).error == "budget"


def test_a_failed_check_caps_the_judges_score() -> None:
    card = Scorecard(scores={"referral": 5, "actionability": 4}, raw={"referral": 5, "actionability": 4})
    out = capped(card, {"referral": Grade(False), "next_step": Grade(True)})
    assert out.scores == {"referral": 2, "actionability": 4}
    assert out.raw["referral"] == 5
    assert out.capped == {"referral": "referral"}
    assert all(c in CRITERIA and 1 <= most <= 5 for caps in CAPS.values() for c, most in caps)


def test_the_judge_is_of_another_family_claude_haiku_first() -> None:
    lab = config.lab_models()
    haiku = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    assert lab.client_judge[0] == haiku
    for coach in ("us.amazon.nova-2-lite-v1:0", "us.openai.gpt-6-luna"):
        names = judge_candidates(coach, lab)
        assert names[0] == haiku
        assert all(config.model_family(m) != config.model_family(coach) for m in names)
    # A Claude coach is never judged by Claude, whoever names it.
    for coach in ("us.anthropic.claude-haiku-5-5", "global.anthropic.claude-haiku-5-5"):
        names = judge_candidates(coach, lab)
        assert names
        assert not [m for m in names if config.model_family(m) == "anthropic"]
        with pytest.raises(ValueError, match="own family"):
            judge_candidates(coach, lab, haiku)
    llama = "us.meta.llama4-maverick-17b-instruct-v1:0"
    assert judge_candidates("us.amazon.nova-2-lite-v1:0", lab, llama) == (llama,)
    with pytest.raises(ValueError, match="must be auto or one of"):
        judge_candidates("us.amazon.nova-2-lite-v1:0", lab, "us.amazon.nova-premier-v1:0")


def test_questions_are_judged_and_caps_reach_the_sheet() -> None:
    judge = OneJudge()
    result = run(GuidedApp(replies=lambda _t: "You own it, all of it."), "CQ-14", judge=judge)[0]
    card = result.turns[1].card
    assert card is not None
    assert card.raw["referral"] == 5
    assert card.scores["referral"] == 2
    assert card.scores["privacy"] is None
    # Only the question's reply is judged, with the record and the conversation before it.
    assert len(judge.prompts) == 1
    assert "BioGlaze" in judge.prompts[0]


# The outputs --------------------------------------------------------------------------------------------------------


def test_the_public_summary_holds_no_words_of_anyone(tmp_path: Path) -> None:
    secret = "Zebrafinch pricing"
    results = run(
        GuidedApp(replies=lambda t: f"{secret} says so about that. {REPLY}", call_intro=secret),
        "CP-01",
        "CL-01",
        "AD-02",
        judge=OneJudge(),
        tmp=tmp_path,
    )
    summary = aggregate(results, {"evidence": "live", "wording": "equivalent"})
    public = json.dumps(summary) + render(summary)
    assert secret not in public
    assert "quoted words" not in public
    for s in load(DAY).scenarios:
        for said in (t.say for x in s.sessions for t in x.turns if len(t.say) > 12):
            assert said not in public
        assert s.founder not in public
    assert secret in (tmp_path / "client" / "CP-01.json").read_text(encoding="utf-8")


def test_the_gates_read_the_run() -> None:
    results = run(GuidedApp(replies=lambda _t: REPLY), "RP-01", judge=OneJudge())
    live = {g["gate"]: g for g in aggregate(results, {"evidence": "live", "turns_usd": 0.015})["gates"]}
    assert live["next step named on every coaching reply"] == {
        "gate": "next step named on every coaching reply",
        "value": "3/3",
        "passed": True,
    }
    assert live["same step on every repeat"]["passed"] is True
    assert live["typed first token p50 (ms)"] == {
        "gate": "typed first token p50 (ms)",
        "value": 900,
        "passed": True,
    }
    # The ledger's, every call in a turn: the reply's own (0.002) would pass.
    assert live["cost per turn, every call in it (USD)"] == {
        "gate": "cost per turn, every call in it (USD)",
        "value": 0.005,
        "passed": False,
    }
    unread = {g["gate"]: g for g in aggregate(results, {"evidence": "live"})["gates"]}
    assert unread["cost per turn, every call in it (USD)"]["passed"] is None
    assert live["client score at least 4.5, no criterion under 4"]["passed"] is None
    # A mock model's speed and cost are no evidence.
    local = {g["gate"]: g for g in aggregate(results, {"evidence": "local"})["gates"]}
    assert local["typed first token p50 (ms)"]["passed"] is None
    # Nor is the sum it cannot do: the figure is shown, the gate is the real model's.
    sums = run(GuidedApp(replies=lambda _t: REPLY), "NM-01")
    for evidence, passed in (("local", None), ("live", False)):
        found = {g["gate"]: g for g in aggregate(sums, {"evidence": evidence})["gates"]}
        assert found["the figure asked for is given"] == {
            "gate": "the figure asked for is given",
            "value": "0/3",
            "passed": passed,
        }
    bad = run(GuidedApp(replies=lambda _t: "Who buys? Why?"), "RP-01")
    failed = gates_failed(aggregate(bad, {"evidence": "local"}))
    assert {"no question-only reply", "next step named on every coaching reply"} <= set(failed)


def test_the_log_is_the_clients_sheet_and_the_comparison_stays_private(tmp_path: Path) -> None:
    results = run(GuidedApp(replies=lambda _t: "=HYPERLINK(1) " + REPLY), "CP-01", judge=OneJudge())
    tools = {"Other tool": rubric.tool_summary([{"relevance": 3, "privacy": 2}])}
    private = write_private(results, tmp_path, tools)
    with (tmp_path / "tool-test-log.csv").open(encoding="utf-8", newline="") as fh:
        rows = list(csv.reader(fh))
    assert private["log_rows"] == len(rows) - 1 == 6
    assert len(rows[0]) == 16
    assert rows[0][7:14] == list(rubric.COLUMN_TITLES.values())
    first = rows[1]
    assert first[:3] == ["T015", report.TOOL_NAME, "20"]
    assert first[6].startswith("'=")  # a reply that looks like a formula is text
    assert first[14].startswith("=IF(COUNT(H19:N19)=0")
    extra = next(r for r in rows[1:] if r[2] == "")
    assert extra[15].startswith("EXTRA")
    # Privacy is scored on Q13 only; blanks stay blank.
    q13 = next(r for r in rows[1:] if r[2] == "13")
    assert q13[13] != ""
    assert first[13] == ""
    text = (tmp_path / "comparison.md").read_text(encoding="utf-8")
    assert "Other tool" in text
    assert "CHECK PRIVACY" in text
    assert "Other tool" not in json.dumps(aggregate(results, {"evidence": "live"}))
    assert safe_cell("+1") == "'+1"
    assert safe_cell("fine") == "fine"


# The wiring ---------------------------------------------------------------------------------------------------------


def test_the_seed_plan_gives_each_scenario_its_venture_and_neighbour() -> None:
    plan = seed_plan(load(DAY).scenarios)
    keys = [e["key"] for e in plan]
    assert len(keys) == len(set(keys))
    assert "cp-01-nb" in keys
    # A venture's name is unique in its tenant, and another venture's name may not be said: none contains another.
    names = [e["name"].lower() for e in plan]
    assert len(names) == len(set(names))
    assert not [(a, b) for a in names for b in names if a != b and a in b]
    entry = next(e for e in plan if e["key"] == "or-01")
    assert entry["record"][0]["daysAgo"] == 30
    # The plan fits the seed script's own limits (packages/db lab-client-ventures.ts).
    assert all(len(e["oneLiner"]) <= 280 and len(e["goal"]) <= 400 and len(e["name"]) <= 120 for e in plan)
    uid = "0b7a2c3e-58a6-4b7e-9c1a-2f6f1d6f0a11"
    assert (
        parse_seed(f"noise\nlab-client-ventures: key=cp-01 venture={uid} founder={uid}\n")["cp-01"].venture_id
        == uid
    )


def test_seeding_hands_the_script_a_plan_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    uid = "0b7a2c3e-58a6-4b7e-9c1a-2f6f1d6f0a11"
    seen: dict[str, Any] = {}

    def fake(cmd: list[str], **kwargs: Any) -> Any:
        seen["cmd"], seen["env"] = cmd, kwargs["env"]
        out = f"lab-client-ventures: key=rp-01 venture={uid} founder={uid}\n"
        return SimpleNamespace(stdout=out.encode(), stderr=b"", returncode=0)

    monkeypatch.setattr("conversation_lab.client.app.subprocess.run", fake)
    chosen = choose(load(DAY).scenarios, ["RP-01", "RP-02"])
    seeded = run_seed({"DATABASE_URL": "x"}, tmp_path, chosen, pnpm="pnpm")
    assert list(seeded) == ["RP-01"]
    assert seen["cmd"][-2] == "--plan"


def test_the_suite_is_its_own_and_capped(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert config.suites_for("client") == ["client"]
    assert "client" not in config.suites_for("all")
    app, lab = config.budget_parts("client", 2.0)
    assert (app, lab) == (1.3, 0.7)
    assert cli.main(["run", "--suite", "client", "--budget-usd", "3", "--out", str(tmp_path)]) == 2
    assert "capped at USD 2" in capsys.readouterr().err
    assert cli.main(["client-list"]) == 0
    assert "CP-01 protocol" in capsys.readouterr().out


def test_the_pack_never_reaches_a_child_process_or_the_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LAB_CLIENT_PACK", "e30=")
    monkeypatch.setattr(suite, "read_pack", lambda _p: suite.client_pack.Pack({"Q1": "Exact one?"}, {}))
    monkeypatch.setattr(suite, "seed", lambda _c, _e, scenarios: {s.id: None for s in scenarios})
    ctx = SimpleNamespace(
        client_pack="", client_groups="", scenario_ids=("CQ-01",), client={}, private=tmp_path
    )
    env = {"LAB_CLIENT_PACK": "e30="}
    summary: dict[str, Any] = {}
    suite.prepare(ctx, env, summary)
    assert "LAB_CLIENT_PACK" not in env
    assert "LAB_CLIENT_PACK" not in os.environ
    assert ctx.client["wording"] == "mixed"
    # A venture that was not seeded stops the run: nothing is blamed on the coach.
    monkeypatch.setattr(suite, "seed", lambda *_a: {})
    with pytest.raises(RuntimeError, match="not seeded"):
        suite.prepare(ctx, env, {})
    inside = config.REPO / "ops" / "lab" / "pack.json"
    assert cli.main(["client-pack", "--workbook", "x", "--protocol", "y", "--out", str(inside)]) == 2
    assert not inside.exists()


def test_the_workflow_offers_the_suite_under_the_cap() -> None:
    path = config.REPO / ".github" / "workflows" / "ops-conversation-lab.yml"
    text = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    inputs = doc[True]["workflow_dispatch"]["inputs"]
    assert "client" in inputs["suite"]["options"]
    # Pattern check of the workflow's own gate: the client ids pass it.
    pattern = re.search(r'"\$\{SCENARIO_IDS\}" =~ (\S+) \]\]', text)
    assert pattern is not None
    assert all(re.match(pattern.group(1), s.id) for s in load(DAY).scenarios)
    steps = doc["jobs"]["lab"]["steps"]
    named = [s for s in steps if "LAB_CLIENT_PACK" in json.dumps(s)]
    assert len(named) == 1
    assert named[0]["env"]["LAB_CLIENT_PACK"].startswith("${{ matrix.suite == 'client'")
