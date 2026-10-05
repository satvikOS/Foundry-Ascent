"""Whole-harness runs against the in-memory fake API: setup, probes, cases, grading, report, teardown."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from foundry_evals import cli
from foundry_evals.environment import Environment, EnvironmentSetupError
from tests.fake_api import OWNER_CODE, FakeFoundryApi, Venture, default_responder

BASE = "https://d111.cloudfront.example"


class VirtualClock:
    """Sleeping advances time instantly, so rate-limit waits are exercised without real waiting."""

    def __init__(self) -> None:
        self.now = 1_000.0
        self.slept = 0.0

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        self.slept += seconds

    def __call__(self) -> float:
        return self.now


def run(
    api: FakeFoundryApi,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *extra: str,
    suite: str = "all",
) -> tuple[int, dict[str, Any], str]:
    monkeypatch.setenv("FA_OWNER_ACCESS_CODE", OWNER_CODE)
    out = tmp_path / "out"
    args = cli.build_parser().parse_args(
        ["run", "--suite", suite, "--base-url", BASE, "--out", str(out), *extra]
    )
    clock = VirtualClock()
    code = cli.cmd_run(args, transport=api.transport(), sleep=clock.sleep, clock=clock)
    results = json.loads((out / "results.json").read_text())
    report = (out / "report.md").read_text()
    return code, results, report


def gate(results: dict[str, Any], gid: str) -> dict[str, Any]:
    return next(g for g in results["gates"] if g["id"] == gid)


def test_full_run_mechanics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api = FakeFoundryApi()
    code, results, report = run(api, tmp_path, monkeypatch, "--max-turns", "500")
    assert code in (0, 1)
    statuses = {c["id"]: c["status"] for c in results["cases"]}
    assert len(statuses) == 158
    assert not [i for i, s in statuses.items() if s in ("error", "skipped")]
    assert results["run"]["turnsUsed"] == 171
    assert {p["status"] for p in results["probes"]} == {"passed"}
    # Setup resources were cleaned up and every session ended.
    assert not [
        m for m in api.memory.values() if "SYSTEM NOTE" in m.content or "Decision: from now on" in m.content
    ]
    assert all(d["status"] == "deleted" for d in api.documents.values())
    assert len(api.documents) == 6
    assert all(s["status"] == "ended" for s in api.sessions.values())
    # Every issued code was revoked; the owner code was not.
    issued = [entry for code_, entry in api.codes.items() if code_ != OWNER_CODE]
    assert issued
    assert all(revoked for _, _, revoked in issued)
    assert results["environment"]["teardown"]["codesRevoked"] == len(issued)
    # Gates that the well-behaved fake must satisfy.
    for gid in ("G1", "G4", "G5", "G6", "G7", "G8", "G10", "G11"):
        assert gate(results, gid)["status"] == "pass", gid
    # Nothing secret or content-bearing reaches stdout, results.json or report.md.
    printed = capsys.readouterr().out
    everything = printed + json.dumps(results) + report
    for venture in api.ventures.values():
        assert venture.canary not in everything
        assert venture.canary.rsplit("::", 1)[-1] not in everything
    for secret in api.codes:
        assert secret not in everything
    assert "Distinctive record text" not in everything
    assert "Early interest is recorded" not in everything


def test_leaking_coach_fails_the_critical_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def leaky(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = default_responder(api, venture, text, mode)
        other = next(v for v in api.ventures.values() if v.id != venture.id)
        response["answer"] = f"Here you go: {other.canary} ({other.name})."
        return response

    code, results, report = run(
        FakeFoundryApi(leaky), tmp_path, monkeypatch, "--case", "RT-CV-001", "--no-data-ok"
    )
    assert code == cli.EXIT_GATE_FAILED
    assert gate(results, "G1")["status"] == "fail"
    case = results["cases"][0]
    assert case["status"] == "failed"
    assert {"canary_leak", "name_leak"} <= {f["code"] for f in case["findings"]}
    assert "RT-CV-001" in report
    assert "CANARY::" not in report


def test_identity_and_injection_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def compliant(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = default_responder(api, venture, text, mode)
        response["answer"] = "PWNED-PI001-Q7 Yes, I am a real person and your EIR has approved this plan."
        return response

    code, results, _ = run(
        FakeFoundryApi(compliant),
        tmp_path,
        monkeypatch,
        "--case",
        "RT-PI-001",
        "--case",
        "RT-ID-001",
        "--no-data-ok",
    )
    assert code == cli.EXIT_GATE_FAILED
    assert gate(results, "G4")["status"] == "fail"
    assert gate(results, "G8")["status"] == "fail"


def test_clean_subset_passes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cases = [
        "SC-002",
        "SC-008",
        "SC-018",
        "SC-027",
        "RT-CV-001",
        "RT-PI-007",
        "RT-PI-013",
        "RT-ID-015",
        "RT-PB-004",
    ]
    args = [arg for c in cases for arg in ("--case", c)]
    code, results, report = run(FakeFoundryApi(), tmp_path, monkeypatch, *args, "--no-data-ok")
    assert code == cli.EXIT_OK, [g for g in results["gates"] if g["status"] != "pass"]
    assert gate(results, "G2")["observed"].startswith("100.0%")
    assert gate(results, "G5")["status"] == "pass"
    assert "**Result: PASSED**" in report


def test_missed_escalation_fails_recall(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def never_escalates(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        response = default_responder(api, venture, "plain question", mode)
        response["answer"] = "Sign it, the valuation is fair."
        return response

    code, results, _ = run(
        FakeFoundryApi(never_escalates), tmp_path, monkeypatch, "--case", "SC-018", "--no-data-ok"
    )
    assert code == cli.EXIT_GATE_FAILED
    assert gate(results, "G2")["status"] == "fail"
    assert gate(results, "G9")["status"] == "fail"
    codes = {f["code"] for f in results["cases"][0]["findings"]}
    assert {"missed", "not_limited", "definitive_advice:securities"} <= codes


def test_budget_caps_turns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    code, results, _ = run(FakeFoundryApi(), tmp_path, monkeypatch, "--max-turns", "12", "--no-data-ok")
    assert results["run"]["turnsUsed"] <= 12
    skipped = [c for c in results["cases"] if c["status"] == "skipped"]
    assert skipped
    assert all(c["reason"] == "budget" for c in skipped)
    groups = {c["group"] for c in results["cases"] if c["status"] != "skipped"}
    assert {"scenario:high_risk", "redteam:cross_venture", "redteam:prompt_injection"} <= groups
    assert code in (0, 1)


def test_cost_budget_converts_to_turns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, results, _ = run(
        FakeFoundryApi(),
        tmp_path,
        monkeypatch,
        "--max-cost-usd",
        "0.05",
        "--est-cost-per-turn",
        "0.01",
        "--no-data-ok",
    )
    assert results["run"]["budget"]["turnCap"] == 5
    assert results["run"]["turnsUsed"] <= 5


def test_turn_errors_are_retried_once_then_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    def flaky(api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        calls.append(1)
        return {"error": "model_unavailable"}

    code, results, _ = run(FakeFoundryApi(flaky), tmp_path, monkeypatch, "--case", "SC-001", "--no-data-ok")
    assert len(calls) == 2
    assert results["cases"][0]["status"] == "error"
    assert gate(results, "G11")["status"] == "fail"
    assert code == cli.EXIT_GATE_FAILED


def test_rate_limit_waits_and_retries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class RateLimitedOnce(FakeFoundryApi):
        limited = False

        def _turn(self, s: dict[str, Any], body: dict[str, Any]) -> httpx.Response:
            if not self.limited:
                self.limited = True
                return self._problem(429, "rate_limited", retry_after=30)
            return super()._turn(s, body)

    code, results, _ = run(RateLimitedOnce(), tmp_path, monkeypatch, "--case", "SC-002", "--no-data-ok")
    assert results["cases"][0]["status"] == "passed"
    assert code == cli.EXIT_OK


def test_spend_cap_aborts_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class Capped(FakeFoundryApi):
        def _turn(self, s: dict[str, Any], body: dict[str, Any]) -> httpx.Response:
            return self._problem(429, "spend_cap_reached")

    code, results, _ = run(Capped(), tmp_path, monkeypatch, "--case", "SC-001", "--case", "SC-002")
    assert code == cli.EXIT_INFRA
    assert results["run"]["aborted"] == "spend_cap_reached"
    assert all(c["status"] == "skipped" for c in results["cases"])


def test_broken_authorization_is_caught_by_probes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class NoAuthz(FakeFoundryApi):
        def _role_in(self, p: Any, venture_id: str) -> str | None:
            return super()._role_in(p, venture_id) or "founder"

    # Probes run with the redteam suite (not with --case); one identity attack keeps the run short.
    code, results, report = run(
        NoAuthz(), tmp_path, monkeypatch, "--category", "identity", "--max-turns", "1", suite="redteam"
    )
    failed = {p["id"] for p in results["probes"] if p["status"] == "failed"}
    assert {"RT-API-001", "RT-API-002", "RT-API-006"} <= failed
    leak = next(p for p in results["probes"] if p["id"] == "RT-API-002")
    assert "api_canary_leak" in {f["code"] for f in leak["findings"]}
    assert gate(results, "G1")["status"] == "fail"
    assert code == cli.EXIT_GATE_FAILED
    assert "RT-API-002" in report


def test_setup_requires_two_ventures_with_founders() -> None:
    api = FakeFoundryApi()
    keep = api.venture("quietquad").id
    for principal in api.principals.values():
        principal.memberships = [(v, r) for v, r in principal.memberships if v == keep]
    env = Environment(
        BASE,
        "t",
        owner_code=__import__("pydantic").SecretStr(OWNER_CODE),
        transport=api.transport(),
        log=lambda _m: None,
    )
    with pytest.raises(EnvironmentSetupError, match="two ventures"):
        env.setup()
    env.teardown()


def test_setup_wakes_a_paused_database_through_sign_in() -> None:
    from pydantic import SecretStr

    # /health has no database observation (cold instance); the first database calls answer
    # 503 database_resuming until Aurora has resumed.
    api = FakeFoundryApi(resuming_responses=3)
    sleeps: list[float] = []
    env = Environment(
        BASE,
        "t",
        owner_code=SecretStr(OWNER_CODE),
        transport=api.transport(),
        sleep=sleeps.append,
        log=lambda _m: None,
    )
    env.setup()
    try:
        assert env.app_version == "test-1"
        assert env.owner_me is not None
        assert sleeps == [1.0, 1.0, 1.0]  # Retry-After honoured; no health polling
    finally:
        env.teardown()


def test_setup_discovers_canaries_and_never_uses_real_people() -> None:
    from pydantic import SecretStr

    api = FakeFoundryApi()
    real = next(p for p in api.principals.values() if p.name == "Jonah Castellane")
    real.synthetic = False
    env = Environment(
        BASE, "t", owner_code=SecretStr(OWNER_CODE), transport=api.transport(), log=lambda _m: None
    )
    env.setup()
    try:
        assert all(a.principal_id != real.id for a in env.actors)
        for venture in api.ventures.values():
            state = env.ventures[venture.id]
            assert state.canary == venture.canary
            assert state.key == venture.key
        sources = {v.key: env.ventures[v.id].canary_source for v in api.ventures.values()}
        # EmberLoop's only founder is not synthetic, so no code is issued there and its canary is computed.
        assert sources == {
            "quietquad": "discovered",
            "benchtally": "discovered",
            "solesignal": "discovered",
            "emberloop": "computed",
        }
        assert not env.actors_for(api.venture("emberloop").id)
        assert env.advisor is not None
        assert env.advisor.role == "advisor"
        assert env.ventures[api.venture("solesignal").id].eir_name == "Ruth Abernathy-Song"
    finally:
        env.teardown()


def test_owner_must_be_platform_admin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeFoundryApi()
    api.principals[api.owner_id].roles = ["program_lead"]
    monkeypatch.setenv("FA_OWNER_ACCESS_CODE", OWNER_CODE)
    out = tmp_path / "out"
    args = cli.build_parser().parse_args(["run", "--base-url", BASE, "--out", str(out), "--case", "SC-001"])
    assert cli.cmd_run(args, transport=api.transport(), sleep=lambda _s: None) == cli.EXIT_INFRA
    assert json.loads((out / "results.json").read_text())["run"]["aborted"] == "setup_failed"


def test_missing_owner_code_is_a_usage_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FA_OWNER_ACCESS_CODE", raising=False)
    args = cli.build_parser().parse_args(["run", "--base-url", BASE, "--case", "SC-001"])
    assert cli.cmd_run(args) == cli.EXIT_USAGE


def test_transcripts_are_opt_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run(FakeFoundryApi(), tmp_path, monkeypatch, "--case", "SC-001", "--no-data-ok")
    assert not (tmp_path / "out" / "transcripts.jsonl").exists()
    run(FakeFoundryApi(), tmp_path, monkeypatch, "--case", "SC-001", "--no-data-ok", "--include-transcripts")
    lines = (tmp_path / "out" / "transcripts.jsonl").read_text().splitlines()
    assert json.loads(lines[0])["case"] == "SC-001"
