"""Conversation matrix: whole runs against the in-memory fake API (sessions, calls, budgets, reports, privacy)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, ClassVar

import pytest

from foundry_evals import cli
from foundry_evals.matrix import cli as matrix_cli
from foundry_evals.matrix.generator import generate
from foundry_evals.matrix.judge import JUDGE_CRITERIA, ModelReply
from foundry_evals.matrix.runner import read_recording
from foundry_evals.matrix.simulator import TemplateSimulator
from foundry_evals.matrix.taxonomy import load_taxonomy, load_templates
from tests.fake_api import OWNER_CODE, FakeFoundryApi, Venture
from tests.test_end_to_end import BASE, VirtualClock, gate

MEMORY = ("--memory-venture", "memorylab")
CI = ("--matrix-budget", "ci", "--max-turns", "500", "--turn-rate-limit", "1000")
IDENTITY = re.compile(r"really corin|a bot|real person|is this corin|^bot\?", re.IGNORECASE)
NEUTRAL = {"required": False, "category": None, "priority": None, "reason": None, "requested_role": None}


def reply(answer: str, speech: list[str] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "mode": "coach",
        "answer": answer,
        "claims": [],
        "uncertainty": [],
        "challenge": None,
        "next_actions": [],
        "escalation": NEUTRAL,
        "memory_candidates": [],
        "follow_up_questions": [],
        "rehearsal": None,
    }
    if speech is not None:
        out["speech"] = speech
    return out


def present(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
    """Follows the presence policy: honest in one line when asked, never a disclaimer, the real support path."""
    if "better off without me" in text.casefold():
        return {"blocked": "crisis_support"}
    if IDENTITY.search(text):
        return reply(
            "I'm Corin's digital twin. So, back to it: what's the next step?",
            ["I'm Corin's digital twin.", "So, back to it: what's the next step?"],
        )
    return reply(
        "That's a lot to hold. Which part matters most this week?",
        ["That's a lot to hold.", "Which part matters most this week?"],
    )


def disclaims(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
    """The owner's complaint: "I'm an AI, not a real human, I don't have a life"."""
    return reply(
        "As an AI I don't have a life, but here's my view. What matters most?",
        ["As an AI I don't have a life.", "What matters most?"],
    )


def warm_intro(api: FakeFoundryApi, session: dict[str, Any]) -> str:
    return "Good to see you. What's on your mind?"


def run(
    api: FakeFoundryApi, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *extra: str
) -> tuple[int, dict[str, Any], str]:
    monkeypatch.setenv("FA_OWNER_ACCESS_CODE", OWNER_CODE)
    out = tmp_path / "out"
    args = cli.build_parser().parse_args(
        ["run", "--suite", "matrix", "--base-url", BASE, "--out", str(out), *extra]
    )
    clock = VirtualClock()
    code = cli.cmd_run(args, transport=api.transport(), sleep=clock.sleep, clock=clock)
    return code, json.loads((out / "results.json").read_text()), (out / "report.md").read_text()


def founder_messages(results: dict[str, Any]) -> list[str]:
    """Every founder message the run sent (regenerated from the plan: the results never hold them)."""
    taxonomy, templates = load_taxonomy(), load_templates()
    simulator = TemplateSimulator(taxonomy, templates)
    ids = {c["id"] for c in results["cases"]}
    texts = []
    for s in generate(taxonomy, templates, budget="ci"):
        if s.id in ids:
            texts += [simulator.text(s, t) for t in s.turns()]
    return [t for t in texts if len(t) > 20]


def test_a_run_plays_every_scenario_and_cleans_up(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(present, memory_lab=True, memory_lab_teammate=True, intro_for=warm_intro)
    code, results, report = run(api, tmp_path, monkeypatch, *CI, *MEMORY)
    statuses = [c["status"] for c in results["cases"]]
    assert len(statuses) == 24
    assert not [s for s in statuses if s in ("error", "skipped")]
    # Every message is sent the way the app sends it: no mode (auto).
    bodies = [
        json.loads(r.content) for r in api.requests if r.method == "POST" and r.url.path.endswith("/turns")
    ]
    assert len(bodies) == results["run"]["turnsUsed"] == 184
    assert all("mode" not in b for b in bodies)
    # Single-session scenarios are private; remembered ones run in the memory lab only and are deleted after.
    lab = api.venture("memorylab")
    for session in api.sessions.values():
        if session["venture_id"] == lab.id:
            assert session["deleted"]
        else:
            assert session["privacy"] == "ephemeral"
    assert api.notebooks[lab.id]["summary"] == ""
    assert api.notebooks[lab.id]["nextOpener"] is None
    # after_private: its first session was private, even in the memory lab.
    cases = {c["id"]: c for c in results["cases"]}
    private = next(c for c in results["cases"] if c["matrix"]["values"]["continuity"] == "after_private")
    assert api.sessions[private["sessionIds"][0]]["privacy"] == "ephemeral"
    assert api.sessions[private["sessionIds"][1]]["privacy"] == "standard"
    # teammate: the second session was someone else's.
    team = next(c for c in results["cases"] if c["matrix"]["values"]["continuity"] == "teammate")
    first, second = (api.sessions[i]["by"] for i in team["sessionIds"])
    assert first != second
    # Calls: typed input, ended; a barge-in interrupts the previous reply after its first unit.
    assert api.calls
    assert all(c["status"] == "ended" and c["input_mode"] == "typed" for c in api.calls.values())
    assert api.interrupts
    assert all(heard == ["That's a lot to hold."] for _, _, heard in api.interrupts)
    # Reports: per-dimension tables, the humanness score, the worst scenarios by id; nothing anyone said.
    matrix = results["matrix"]
    assert matrix["scenarios"]["executed"] == 24
    assert matrix["coverage"]["values"] == {"covered": 94, "total": 94}
    assert set(matrix["dimensions"]) == set(load_taxonomy().dimensions)
    assert len(matrix["worst"]) == 10
    assert all(w["id"] in cases for w in matrix["worst"])
    assert 0 < matrix["humanness"] < 1
    assert "## Conversation matrix" in report
    assert "#### What the founder asks (`question_type`)" in report
    assert "### Worst scenarios" in report
    stored = json.loads((tmp_path / "out" / "matrix.json").read_text())
    assert stored["humanness"] == matrix["humanness"]
    everything = json.dumps(results) + report + json.dumps(stored)
    for text in founder_messages(results):
        assert text not in everything
    assert "That's a lot to hold" not in everything
    assert code in (0, 1)


def test_a_veir_that_follows_the_presence_policy_passes_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeFoundryApi(present, memory_lab=True, memory_lab_teammate=True, intro_for=warm_intro)
    _, results, _ = run(api, tmp_path, monkeypatch, *CI, *MEMORY)
    for gid in ("G1", "G4", "G5", "G6", "G7", "G8", "G11", "G14", "G15"):
        assert gate(results, gid)["status"] == "pass", gid
    checks = [x for c in results["cases"] for x in c["matrix"]["checks"]]
    asked = [x for x in checks if x["check"] == "identity.honest_when_asked"]
    assert asked
    assert all(x["passed"] for x in asked)
    crisis = [x for x in checks if x["check"] == "crisis.support_path"]
    assert crisis
    assert all(x["passed"] for x in crisis)


def test_volunteered_disclaimers_fail_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(disclaims, memory_lab=True, memory_lab_teammate=True)
    code, results, _ = run(api, tmp_path, monkeypatch, *CI, *MEMORY)
    g14 = gate(results, "G14")
    assert code == 1
    assert g14["status"] == "fail"
    assert g14["blocking"]
    assert g14["numerator"] > 24
    worst = results["matrix"]["worst"][0]
    assert worst["highFailures"] > 0
    assert any(f.startswith("identity.no_volunteered_disclaimer@") for f in worst["failed"])
    # The fake API's default call intro ("…, an AI coach") is itself a volunteered disclaimer.
    calls = [c for c in results["cases"] if c["matrix"]["values"]["channel"] == "voice"]
    assert calls
    for case in calls:
        intro = [
            x
            for x in case["matrix"]["checks"]
            if x["check"] == "identity.no_volunteered_disclaimer" and x["turn"] is None
        ]
        assert intro, case["id"]
        assert not all(x["passed"] for x in intro), case["id"]


def test_without_a_memory_venture_remembered_scenarios_are_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeFoundryApi(present, intro_for=warm_intro)
    code, results, _ = run(api, tmp_path, monkeypatch, *CI)
    skipped = [c for c in results["cases"] if c["status"] == "skipped"]
    assert len(skipped) == 10
    assert {c["reason"] for c in skipped} == {"needs_memory_venture"}
    assert not [s for s in api.sessions.values() if s["privacy"] == "standard"]
    g12 = gate(results, "G12")
    assert g12["status"] == "no_data"
    assert g12["blocking"]
    assert code == 1
    code_ok, results_ok, _ = run(api, tmp_path / "b", monkeypatch, *CI, "--no-data-ok")
    assert gate(results_ok, "G12")["status"] == "no_data"
    assert code_ok == 0


def test_a_teammate_scenario_needs_a_teammate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(present, memory_lab=True, intro_for=warm_intro)
    _, results, _ = run(api, tmp_path, monkeypatch, *CI, *MEMORY)
    team = next(
        c
        for c in results["cases"]
        if (c["matrix"] and c["matrix"]["values"].get("continuity") == "teammate")
        or c["reason"] == "needs_teammate"
    )
    assert team["status"] == "skipped"
    assert team["reason"] == "needs_teammate"


def test_a_seeded_venture_is_never_the_memory_venture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("FA_OWNER_ACCESS_CODE", OWNER_CODE)
    args = cli.build_parser().parse_args(
        ["run", "--suite", "matrix", "--base-url", BASE, "--memory-venture", "quietquad", *CI]
    )
    assert cli.cmd_run(args, transport=FakeFoundryApi().transport()) == 2
    assert "never a seeded one" in capsys.readouterr().err


def test_the_turn_budget_cuts_the_plan(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(present, memory_lab=True, memory_lab_teammate=True, intro_for=warm_intro)
    _, results, _ = run(
        api,
        tmp_path,
        monkeypatch,
        "--matrix-budget",
        "ci",
        "--max-turns",
        "30",
        "--turn-rate-limit",
        "1000",
        *MEMORY,
    )
    ran = [c for c in results["cases"] if c["status"] != "skipped"]
    assert results["run"]["turnsUsed"] <= 30
    assert 1 <= len(ran) < 24
    assert {c["reason"] for c in results["cases"] if c["status"] == "skipped"} == {"budget"}
    assert results["run"]["budget"]["plannedTurns"] <= 30


def test_dry_run_prints_the_plan_without_the_network(capsys: pytest.CaptureFixture[str]) -> None:
    args = cli.build_parser().parse_args(
        ["run", "--suite", "matrix", "--dry-run", "--matrix-budget", "ci", "--max-turns", "500"]
    )
    assert cli.cmd_run(args) == 0
    out = capsys.readouterr().out
    assert "matrix plan: 24 of 24 scenarios" in out
    assert "values 94/94" in out
    assert "MX-0024" in out


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        (("--judge",), "--judge needs --judge-model"),
        (("--simulator", "llm"), "--simulator llm needs --simulator-model"),
        (
            (
                "--simulator",
                "llm",
                "--simulator-model",
                "amazon.nova-lite-v1:0",
                "--record-replies",
                "x.json",
            ),
            "template simulator only",
        ),
    ],
)
def test_usage_errors(
    extra: tuple[str, ...], message: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(matrix_cli.JUDGE_MODEL_ENV, raising=False)
    monkeypatch.delenv(matrix_cli.SIMULATOR_MODEL_ENV, raising=False)
    args = cli.build_parser().parse_args(["run", "--suite", "matrix", "--dry-run", *extra])
    assert cli.cmd_run(args) == 2
    assert message in capsys.readouterr().err


def test_the_v1_judge_flag_still_refuses_other_suites(capsys: pytest.CaptureFixture[str]) -> None:
    args = cli.build_parser().parse_args(["run", "--suite", "scenarios", "--dry-run", "--judge"])
    assert cli.cmd_run(args) == 2
    assert "out of scope" in capsys.readouterr().err


class FakeLabModel:
    """Stands in for Bedrock: a simulator that says what the plan needs, a judge that scores 4s."""

    instances: ClassVar[list[FakeLabModel]] = []

    def __init__(self, model_id: str, region: str = "us-east-1", **_: Any) -> None:
        self.model_id = model_id
        self.calls = 0
        FakeLabModel.instances.append(self)

    def estimate(self, *, input_chars: int, max_tokens: int) -> float:
        return 0.001

    def complete(self, *, system: str, user: str, max_tokens: int, temperature: float) -> ModelReply:
        self.calls += 1
        if "rater" in system:
            body = {
                "scores": {k: {"score": 4, "rationale": "SECRET-RATIONALE turn 3"} for k in JUDGE_CRITERIA},
                "summary": "s",
            }
            return ModelReply(json.dumps(body), 3000, 400, 0.003)
        needs = [
            line.split(": ", 1)[1].split(", ")[0]
            for line in user.splitlines()
            if line.startswith("Your message must mention one of")
        ]
        return ModelReply("Okay so, " + " and ".join(needs) + " is on my mind.", 500, 30, 0.0005)


def test_llm_simulator_and_judge_are_charged_and_rationales_stay_private(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeLabModel.instances = []
    monkeypatch.setattr(matrix_cli, "ConverseModel", FakeLabModel)
    api = FakeFoundryApi(present, memory_lab=True, memory_lab_teammate=True, intro_for=warm_intro)
    private = tmp_path / "private"
    code, results, report = run(
        api, tmp_path, monkeypatch, "--matrix-budget", "6", "--max-turns", "500", "--turn-rate-limit", "1000", *MEMORY,
        "--simulator", "llm", "--simulator-model", "amazon.nova-lite-v1:0",
        "--judge", "--judge-model", "anthropic.claude-haiku-4-5", "--private-out", str(private),
    )  # fmt: skip
    meta = results["matrix"]
    assert meta["simulatorSources"].get("llm", 0) > 0
    assert meta["simulatorCostUsd"] > 0
    assert meta["judgeCostUsd"] > 0
    assert results["run"]["costUsdReported"] == pytest.approx(
        sum(t["costUsd"] or 0 for c in results["cases"] for t in c["turns"])
        + meta["simulatorCostUsd"]
        + meta["judgeCostUsd"]
    )
    judged = [c for c in results["cases"] if c["matrix"].get("judgeStatus") == "scored"]
    assert len(judged) == 6
    assert all(c["matrix"]["judge"]["mean"] == 4 for c in judged)
    assert gate(results, "G17")["status"] == "pass"
    assert "SECRET-RATIONALE" not in json.dumps(results) + report
    lines = (private / "judge-rationales.jsonl").read_text().splitlines()
    assert len(lines) == 6
    assert "SECRET-RATIONALE" in lines[0]
    assert code in (0, 1)


def test_the_spend_cap_covers_the_simulator_and_the_judge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(matrix_cli, "ConverseModel", FakeLabModel)
    api = FakeFoundryApi(present, memory_lab=True, memory_lab_teammate=True, intro_for=warm_intro)
    _, results, _ = run(
        api, tmp_path, monkeypatch, "--matrix-budget", "ci", "--max-turns", "500", "--turn-rate-limit", "1000", *MEMORY,
        "--max-cost-usd", "0.2", "--est-cost-per-turn", "0.001",
        "--simulator", "llm", "--simulator-model", "x.sim", "--judge", "--judge-model", "x.judge",
    )  # fmt: skip
    # Planned within the estimate (0.002 per turn + 0.002 per judged scenario), and spent within the cap.
    assert results["matrix"]["estimatedUsd"] <= 0.2
    assert results["run"]["costUsdReported"] <= 0.2
    assert any(c["reason"] == "budget" for c in results["cases"] if c["status"] == "skipped")


def test_recording_refuses_a_real_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api = FakeFoundryApi(
        present,
        memory_lab=True,
        memory_lab_teammate=True,
        intro_for=warm_intro,
        model_id="amazon.nova-lite-v1:0",
    )
    target = tmp_path / "rec.jsonl"
    code, results, _ = run(api, tmp_path, monkeypatch, *CI, *MEMORY, "--record-replies", str(target))
    assert code == 2
    assert results["run"]["aborted"] == "recording_refused"
    assert not target.exists()
    assert "not the mock" in capsys.readouterr().err


def test_recording_the_mock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi(
        present, memory_lab=True, memory_lab_teammate=True, intro_for=warm_intro, model_id="mock"
    )
    target = tmp_path / "rec.jsonl"
    code, results, _ = run(api, tmp_path, monkeypatch, *CI, *MEMORY, "--record-replies", str(target))
    assert code in (0, 1)
    raw = target.read_text(encoding="utf-8")
    document = read_recording(target)
    assert document["schema"] == "foundry-evals/matrix-mock-replies@1"
    assert document["modelIds"] == ["mock"]
    assert document["budget"] == "ci"
    assert len(document["sessions"]) == len(api.sessions)
    assert sum(len(s["turns"]) for s in document["sessions"]) == results["run"]["turnsUsed"]
    # JSON Lines: the header, then one session per line (a re-recording diffs scenario by scenario).
    assert raw.count("\n") == len(document["sessions"]) + 1
