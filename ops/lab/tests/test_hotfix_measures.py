from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from conversation_lab import cli
from conversation_lab.compare import compare
from conversation_lab.logstats import summarize
from conversation_lab.recall import greeting_result, opener_flags
from conversation_lab.smoke import ScenarioResult, TurnRecord, select_scenarios
from conversation_lab.voice import load_voice, score
from tests.test_recall_voice import captured_voice


def line(**fields: Any) -> str:
    return json.dumps({"level": "info", **fields})


LOG = [
    "not json",
    line(event="ai.model.attempt", purpose="turn", kind="initial", outcome="ok"),
    line(
        event="ai.model.attempt",
        purpose="turn",
        kind="initial",
        outcome="invalid_output",
        issues="answer: too_big,(root): max_tokens",
    ),
    line(event="ai.model.attempt", purpose="turn", kind="retry", outcome="ok"),
    line(event="ai.model.attempt", purpose="turn", kind="initial", outcome="ok"),
    line(
        event="ai.model.attempt",
        purpose="distill",
        kind="initial",
        outcome="invalid_output",
        issues="(root): max_tokens",
    ),
    line(event="ai.model.attempt", purpose="distill", kind="retry", outcome="ok"),
    line(
        event="ai.model.attempt",
        purpose="distill",
        kind="initial",
        outcome="invalid_output",
        issues="Founder said: <text>,mode: invalid_enum_value",
    ),
    line(
        event="turn.timing",
        time="2026-10-18T00:00:10.000Z",
        voice=True,
        retrievalMs=380,
        embedMs=350,
        modelStartMs=400,
        modelFirstTokenMs=700,
        firstDeltaMs=1300,
        totalMs=3000,
        firstSpeechMs=900,
    ),
    line(event="turn.timing", voice=False, totalMs=4000),
    line(event="speech.timing", time="2026-10-18T00:00:07.950Z", firstAudioMs=200),
    line(event="turn.stream_fallback", reason="meta_narration"),
    line(event="http.request", route="/api/v1/turns/:id/interrupt", status=204),
]


def test_logstats_counts_first_attempt_failures_by_purpose_and_groups_issue_codes() -> None:
    out = summarize(LOG)
    turn = out["model_attempts"]["turn"]
    assert (turn["first_attempts"], turn["first_invalid_output"], turn["first_invalid_share_pct"]) == (
        3,
        1,
        33.3,
    )
    assert turn["kind:retry"] == 1
    distill = out["model_attempts"]["distill"]
    assert (
        distill["first_attempts"],
        distill["first_invalid_output"],
        distill["first_invalid_share_pct"],
    ) == (2, 2, 100.0)
    # Codes only: a value that does not look like a code is dropped.
    assert out["invalid_output_issues"] == {
        "(root): max_tokens": 2,
        "answer: too_big": 1,
        "mode: invalid_enum_value": 1,
    }
    assert out["root_max_tokens"] == 2
    assert out["turn_total_ms"]["voice"] == {"p50": 3000.0, "p95": 3000.0, "n": 1}
    assert out["voice_first_speech_ms"]["p50"] == 900.0
    assert out["polly_first_audio_ms"]["p50"] == 200.0
    assert out["stream_fallbacks"] == {"meta_narration": 1}
    assert out["interrupt_requests"] == 1
    voice_turn = next(t for t in out["turns"] if t["voice"])
    # modelFirstTokenMs is the time to first token (a span from model start, turn-timing.ts): the token arrived
    # at 400 + 700 = 1100 ms and the first words were released at 1300 ms, so the gate held 200 ms.
    assert voice_turn["modelFirstTokenAtMs"] == 1100
    assert voice_turn["firstTokenToDeltaMs"] == 200
    assert voice_turn["retrievalMs"] == 380
    # The turn started at 00:00:07.000 and spoke at +900 ms; the speech request after that took 200 ms.
    assert voice_turn["pollyFirstAudioMs"] == 200
    assert next(t for t in out["turns"] if not t["voice"])["pollyFirstAudioMs"] is None


def test_select_scenarios_filters_and_repeats() -> None:
    scenarios = [{"id": "SM-13"}, {"id": "SM-20"}, {"id": "SM-39"}]
    assert [s["id"] for s in select_scenarios(scenarios)] == ["SM-13", "SM-20", "SM-39"]
    chosen = select_scenarios(scenarios, ("SM-39", "SM-13"), repeat=2)
    assert [s["id"] for s in chosen] == ["SM-13#1", "SM-39#1", "SM-13#2", "SM-39#2"]
    with pytest.raises(ValueError, match="unknown scenario ids: SM-99"):
        select_scenarios(scenarios, ("SM-99",))
    with pytest.raises(ValueError, match="repeat"):
        select_scenarios(scenarios, repeat=11)


def test_matrix_result_counts_validator_notes_and_findings() -> None:
    r = ScenarioResult(
        id="SM-39#1", tags={"channel": "voice"}, channel="call", passed=False, reason="blocking_finding"
    )
    r.high = ["structured_leak"]
    r.turns = [
        TurnRecord(
            founder="hi",
            heard="Okay.",
            kind="completed",
            seconds=3,
            detail={
                "validator": {"notes": ["meta_narration_retried", "stream_meta_narration", "bad note <text>"]}
            },
        ),
        TurnRecord(founder="ok", heard="Sure.", kind="completed", seconds=2, detail={"validator": None}),
    ]
    out = cli.matrix_result([r], None, founder_name="Maya", llm_simulator=True)
    assert out["validator_notes"] == {"meta_narration_retried": 1, "stream_meta_narration": 1}
    assert out["findings"] == {"structured_leak": 1}
    assert out["voice_turns"] == 2


def test_repeated_voice_calls_are_pooled() -> None:
    script = load_voice()
    one = captured_voice()
    two = captured_voice(
        bargeIn={
            "injectedAt": 1000.0,
            "playbackStoppedAt": 1800.0,
            "interruptSent": True,
            "replyWasPlaying": True,
        }
    )
    out = score(script, {"calls": [{**one, "selfInterruptions": 0}, {**two, "selfInterruptions": 1}]})
    public = out.public()
    assert (out.passed, public["calls"], public["self_interruptions"]) == (True, 2, 1)
    assert public["barge_in"]["stops_ms"] == [600, 800]
    assert public["barge_in"]["stop_ms_p50"] == 600
    assert len(public["lines"]) == 8
    assert public["lines"][4]["id"] == "call 2: VC-1"
    single = score(script, {"calls": [{**one, "selfInterruptions": 2}]})
    assert (single.calls, single.self_interruptions, single.barge_in["stops_ms"]) == (1, 2, [600])
    failing = score(script, {"calls": [one, {**two, "inputMode": "typed"}]})
    assert (failing.passed, failing.reason) == (False, "no_voice_input")


def test_greeting_and_opener_checks() -> None:
    assert greeting_result(None) is None
    fast = greeting_result(
        {
            "callStartedAt": 1000,
            "typedAt": 1500,
            "turnPostedAt": 1620,
            "greetingPlaying": True,
            "greetingStopped": True,
        }
    )
    assert fast == {
        "error": None,
        "greeting_playing_when_typed": True,
        "call_to_turn_ms": 620,
        "typed_to_turn_ms": 120,
        "greeting_stopped": True,
        "passed": True,
    }
    slow = greeting_result({"callStartedAt": 0, "typedAt": 100, "turnPostedAt": 11_400})
    assert slow is not None
    assert slow["passed"] is False
    flags = opener_flags(
        {
            "RC-02": {
                "first": {
                    "opening": 'Good to talk again. Last time, you asked "Hey, do you remember what we talked about?"'
                },
                "second": {"opening": "Shall we pick up the facility budget numbers maya will get?"},
            },
            "RC-03": {"second": {"opening": "Welcome back. Maya's pilot was the topic. How did it go?"}},
            "RG-01": {"id": "RG-01"},
        }
    )
    assert [
        (f["id"], f["conversation"], f["quoted_question"], f["lowercase_name"], f["third_person_name"])
        for f in flags
    ] == [
        ("RC-02", "first", True, False, False),
        ("RC-02", "second", False, True, False),
        ("RC-03", "second", False, False, True),
    ]


def test_comparison_includes_the_app_log_numbers() -> None:
    def run(share: float, maxed: int, leaks: int) -> dict[str, Any]:
        return {
            "suite": "matrix",
            "result": {"passed": 1, "run": 1, "findings": {"structured_leak": leaks}},
            "app_logs": {
                "model_attempts": {"turn": {"first_invalid_share_pct": share}},
                "root_max_tokens": maxed,
                "turn_total_ms": {"voice": {"p50": 4000}},
                "interrupt_requests": 1,
            },
        }

    rows = {r["metric"]: r for r in compare(run(5.0, 0, 0), run(25.0, 7, 2))["headline"]}
    assert rows["turn: first attempts invalid_output (%)"]["change"] == -20.0
    assert rows["(root): max_tokens issues"]["change"] == -7
    assert rows["finding structured_leak"] == {
        "metric": "finding structured_leak",
        "baseline": 2,
        "now": 0,
        "change": -2,
    }


def test_run_arguments_carry_scenarios_and_repeats(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(cli, "cmd_run", lambda args: seen.update(vars(args)) or 0)
    assert (
        cli.main(
            [
                "run",
                "--suite",
                "matrix",
                "--budget-usd",
                "1",
                "--out",
                "x",
                "--scenarios",
                "SM-13,SM-39",
                "--repeat",
                "5",
            ]
        )
        == 0
    )
    assert (seen["scenarios"], seen["repeat"]) == ("SM-13,SM-39", 5)


def test_comparison_sets_the_voice_turn_stages_side_by_side() -> None:
    def run(embed: float, gate: float) -> dict[str, Any]:
        turn = {
            "voice": True,
            "retrievalMs": 150,
            "embedMs": embed,
            "modelStartMs": 200,
            "modelFirstTokenMs": 320,
        }
        return {
            "suite": "voice",
            "result": {"passed": 1, "run": 1},
            "app_logs": {
                "turns": [{**turn, "firstDeltaMs": 520 + gate}, {**turn, "voice": False, "embedMs": 999}]
            },
        }

    rows = {r["metric"]: r for r in compare(run(441, 526), run(177, 423))["headline"]}
    assert rows["voice turn median Titan embed (all calls) (ms)"] == {
        "metric": "voice turn median Titan embed (all calls) (ms)",
        "baseline": 177.0,
        "now": 441.0,
        "change": 264,
    }
    assert rows["voice turn median gate hold (first token → first delta) (ms)"]["change"] == 103
    assert rows["voice turn median time to first token (ms)"]["now"] == 320.0


def test_recall_comparison_and_report_show_the_greeting_and_openers() -> None:
    from conversation_lab.report import render

    flags = [
        {
            "id": "RC-02",
            "conversation": "first",
            "quoted_question": True,
            "lowercase_name": False,
            "third_person_name": False,
        }
    ]
    base = {
        "suite": "recall",
        "result": {"passed": 3, "run": 3, "greeting": {"call_to_turn_ms": 11867}, "openers": flags},
    }
    clean = [{**flags[0], "quoted_question": False}]
    greeting = {
        "call_to_turn_ms": 124,
        "typed_to_turn_ms": 13,
        "greeting_playing_when_typed": True,
        "greeting_stopped": True,
        "passed": True,
        "error": None,
    }
    now = {"suite": "recall", "result": {"passed": 2, "run": 3, "greeting": greeting, "openers": clean}}
    rows = {r["metric"]: r for r in compare(now, base)["headline"]}
    assert rows["greeting: call opened → turn sent (ms)"]["change"] == -11743
    assert rows["openers flagged"] == {"metric": "openers flagged", "baseline": 1, "now": 0, "change": -1}
    text = render({**now, "spend": {}, "models": {}})
    assert "call opened → turn sent 124 ms; typed → turn sent 13 ms; greeting stopped True; pass." in text
    assert "Openers: 1 checked, 0 flagged" in text


def test_the_evals_matrix_runs_with_the_probed_models_and_keeps_content_private(tmp_path: Path) -> None:
    cmd = cli.evals_matrix_command(
        base_url="http://localhost:8787",
        scenarios=40,
        max_cost_usd=2.5,
        simulator_model="us.amazon.nova-pro-v1:0",
        judge_model="us.amazon.nova-pro-v1:0",
        private=tmp_path,
    )
    assert cmd[1:6] == ["-m", "foundry_evals", "run", "--suite", "matrix"]
    joined = " ".join(cmd)
    assert "--matrix-budget 40" in joined
    assert "--max-cost-usd 2.50" in joined
    assert f"--est-cost-per-turn {cli.EVALS_EST_TURN_USD}" in joined
    assert "--turn-rate-limit 1000 --actors-per-venture 3" in joined
    assert "--matrix-priority" in cmd
    assert "--memory-venture" not in joined
    remembered = cli.evals_matrix_command(
        base_url="x",
        scenarios=4,
        max_cost_usd=1,
        simulator_model=None,
        judge_model=None,
        private=tmp_path,
        memory_venture="lanternwise",
    )
    assert remembered[-4:-2] == ["--memory-venture", "lanternwise"]
    assert remembered[-2] == "--between-sessions-cmd"
    assert remembered[-1].endswith("--filter @foundry/api exec tsx src/scripts/lab-age-conversation.ts")
    assert "--simulator llm --simulator-model us.amazon.nova-pro-v1:0" in joined
    assert "--judge --judge-model us.amazon.nova-pro-v1:0" in joined
    assert f"--private-out {tmp_path / 'evals-matrix' / 'private'}" in joined
    template = cli.evals_matrix_command(
        base_url="x", scenarios=4, max_cost_usd=1, simulator_model=None, judge_model=None, private=tmp_path
    )
    assert "--simulator" not in template
    assert "--judge" not in template


def test_the_summary_counts_the_aged_gaps(tmp_path: Path) -> None:
    log = tmp_path / "aging.log"
    assert cli.aged_gaps(log) is None
    log.write_text(
        "lab-age: days=3 sessions=1 turns=8 memory=2 notebooks=1 digests=1 distilled=yes\n"
        "lab-age: days=14 sessions=1 turns=6 memory=0 notebooks=1 digests=0 distilled=no\n"
        "something else\n"
    )
    assert cli.aged_gaps(log) == {"aged": 2, "after_distillation": 1}


def test_evals_simulator_and_judge_costs_join_the_lab_ledger() -> None:
    from conversation_lab.budget import Ledger, SpendGuard

    guard = SpendGuard(app_budget=1.0, lab_budget=0.5, ledger=Ledger())
    cli.record_evals_model_costs(
        guard, {"simulatorCostUsd": 0.0238021, "judgeCostUsd": 0.035399, "simulator": "llm"}, "sim", "judge"
    )
    assert guard.ledger.by_purpose()["simulator"]["usd"] == 0.023803
    assert guard.ledger.by_purpose()["judge"]["usd"] == 0.035399
    cli.record_evals_model_costs(guard, {"simulatorCostUsd": 0.0, "judgeCostUsd": None}, None, None)
    assert len(guard.ledger.charges) == 2


def test_the_summary_lists_what_evals_skipped() -> None:
    from conversation_lab.report import render

    result = {
        "passed": 1,
        "run": 1,
        "skipped": [{"id": "MX-0040", "reason": "budget"}, {"id": "MX-0039", "reason": "budget"}],
    }
    text = render({"suite": "matrix", "result": result, "spend": {}, "models": {}})
    assert "Skipped: 2 (budget: MX-0040, MX-0039)." in text


def test_chosen_evals_cases_are_passed_on(tmp_path: Path) -> None:
    cmd = cli.evals_matrix_command(
        base_url="x",
        scenarios=40,
        max_cost_usd=1,
        simulator_model=None,
        judge_model=None,
        private=tmp_path,
        case_ids=("MX-0004", "MX-P01"),
    )
    assert " ".join(cmd).count("--case") == 2
    assert "--case MX-0004 --case MX-P01" in " ".join(cmd)
