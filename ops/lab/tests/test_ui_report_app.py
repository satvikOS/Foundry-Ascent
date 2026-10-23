from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from conversation_lab import cli
from conversation_lab.app import AppAdmin, lab_settings
from conversation_lab.config import AppModels
from conversation_lab.report import purpose_delta, render
from conversation_lab.stack import api_env
from conversation_lab.ui import summarize
from foundry_evals.client import FoundryClient

REPORT = {
    "suites": [
        {
            "title": "calls.spec.ts",
            "file": "calls.spec.ts",
            "specs": [],
            "suites": [
                {
                    "title": "vEIR calls",
                    "specs": [
                        {
                            "title": "a second call remembers",
                            "tests": [{"projectName": "desktop", "status": "unexpected"}],
                        },
                        {"title": "mini bar", "tests": [{"projectName": "desktop", "status": "expected"}]},
                    ],
                    "suites": [],
                }
            ],
        },
        {
            "title": "chat.spec.ts",
            "file": "chat.spec.ts",
            "specs": [
                {"title": "composer", "tests": [{"projectName": "desktop", "status": "flaky"}]},
                {"title": "screens", "tests": [{"projectName": "desktop", "status": "skipped"}]},
            ],
        },
    ],
    "stats": {"duration": 125000},
}


def test_ui_summary_counts_and_lists_titles_only() -> None:
    out = summarize(REPORT)
    assert out["totals"] == {"expected": 1, "unexpected": 1, "flaky": 1, "skipped": 1}
    assert out["pass_rate"] == pytest.approx(2 / 3, abs=1e-4)
    assert out["failing"] == [
        {"file": "calls.spec.ts", "project": "desktop", "title": "vEIR calls > a second call remembers"}
    ]
    assert out["flaky"][0]["title"] == "composer"
    assert out["duration_seconds"] == 125.0


def test_purpose_delta_is_the_spend_of_this_run() -> None:
    before = {"byPurpose": [{"purpose": "turn", "usd": 0.5, "calls": 10, "inputTokens": 100}]}
    after = {
        "byPurpose": [
            {"purpose": "turn", "usd": 0.62, "calls": 13, "inputTokens": 160},
            {"purpose": "speech", "usd": 0.03, "calls": 4, "inputTokens": 1800},
            {"purpose": "seed", "usd": 0.0, "calls": 0, "inputTokens": 0},
        ]
    }
    assert purpose_delta(before, after) == [
        {"purpose": "turn", "usd": 0.12, "calls": 3, "input_units": 60},
        {"purpose": "speech", "usd": 0.03, "calls": 4, "input_units": 1800},
    ]


def test_rendered_summary_is_numbers_ids_and_titles() -> None:
    summary: dict[str, Any] = {
        "suite": "ui",
        "budget_usd": 1.66,
        "stopped_by": None,
        "duration_seconds": 300,
        "models": {"app": {"primary": "us.amazon.nova-2-lite-v1:0", "fallback": "g", "embeddings": "t"}},
        "spend": {
            "total_usd": 0.4,
            "app_usd": 0.4,
            "lab_usd": 0,
            "app_budget_usd": 1.66,
            "lab_budget_usd": 0,
        },
        "result": {"passed": 2, "run": 3, "ui": summarize(REPORT)},
    }
    text = render(summary)
    assert "| Passed | 2/3 (67%) |" in text
    assert "Harness error" not in text
    assert "| Harness error | TimeoutError" in render({**summary, "harness_error": "TimeoutError"})
    assert "calls.spec.ts [desktop] vEIR calls > a second call remembers" in text


def test_lab_settings_cap_the_app_at_its_share_within_the_contract() -> None:
    settings = lab_settings(0.91, 0.0)
    assert settings["dailyUsdCapGlobal"] == 0.91
    assert settings["dailyUsdCapPerPrincipal"] == 0.91
    assert settings["aiEnabled"] is True
    assert settings["callsEnabled"] is True
    assert settings["dailyCallMinutesPerPrincipal"] <= 1440
    assert settings["maxTurnsPerSession"] <= 200
    assert lab_settings(99, 5)["dailyUsdCapGlobal"] == 100
    assert lab_settings(60, 0)["dailyUsdCapPerPrincipal"] == 50
    assert lab_settings(1.66, 0.2, ui=True) == {"dailyUsdCapGlobal": 1.86, "dailyUsdCapPerPrincipal": 1.86}


class FakeAdminApi:
    def __init__(self) -> None:
        self.today = 0.0
        self.patches: list[dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        if path == "/health":
            return httpx.Response(200, json={"status": "ok", "version": "x", "db": "awake"})
        if path == "/auth/sign-in":
            me = {
                "principal": {"id": "p1", "displayName": "Local Owner", "synthetic": False},
                "tenant": {"id": "t1", "slug": "ain", "name": "Ain"},
                "roles": ["platform_admin"],
                "memberships": [],
                "disclosure": "d",
                "aiEnabled": True,
            }
            return httpx.Response(200, json=me, headers={"set-cookie": "fa_session=tok; Path=/; HttpOnly"})
        if path == "/admin/usage":
            assert request.headers.get("cookie") == "fa_session=tok"
            return httpx.Response(200, json={"todayUsd": self.today, "byPurpose": []})
        if path == "/admin/settings" and request.method == "PATCH":
            self.patches.append(json.loads(request.content))
            return httpx.Response(200, json=self.patches[-1])
        return httpx.Response(404, json={"code": "not_found"})


def test_admin_applies_caps_on_top_of_today_and_reads_spend_since() -> None:
    api = FakeAdminApi()
    api.today = 0.25
    client = FoundryClient("http://localhost:8787", transport=httpx.MockTransport(api.handle))
    admin = AppAdmin("http://localhost:8787", SecretStr("FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"), client=client)
    admin.sign_in()
    applied = admin.apply_lab_settings(0.91)
    assert api.patches == [applied]
    assert applied["dailyUsdCapGlobal"] == 1.16
    api.today = 0.4
    assert admin.spent_since_start() == pytest.approx(0.15)


def test_api_env_is_the_production_model_config_with_speech_only_when_asked() -> None:
    models = AppModels(
        "us.amazon.nova-2-lite-v1:0", "global.amazon.nova-2-lite-v1:0", "amazon.titan-embed-text-v2:0"
    )
    env = api_env(
        {"PATH": "/bin", "AWS_SESSION_TOKEN": "x"}, models=models, database_url="postgresql://db", speech=True
    )
    assert env["MODEL_PROVIDER"] == "bedrock"
    assert (env["MODEL_PRIMARY_ID"], env["MODEL_FALLBACK_ID"]) == (models.primary, models.fallback)
    assert env["LOCAL_AWS_SPEECH"] == "true"
    assert env["AWS_SESSION_TOKEN"] == "x"
    assert env["CORE_TURN_RATE_LIMIT"] == "1000"
    assert env["APP_ENV"] == "development"
    # The lab runs the app with the model-based safety screen on (production keeps it off until evaluated).
    assert env["CORE_SAFETY_SCREEN"] == "on"
    assert api_env({}, models=models, database_url="d", speech=False)["LOCAL_AWS_SPEECH"] == "false"
    assert api_env({}, models=models, database_url="d", speech=False, mock=True)["CORE_SAFETY_SCREEN"] == "on"


def test_plan_prints_suites_and_caps(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["plan", "--suite", "all", "--budget-usd", "5"]) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan == {
        "suites": ["recall", "voice", "matrix", "ui"],
        "budgets": {"recall": 0.83, "voice": 0.83, "matrix": 1.66, "ui": 1.66},
    }
    assert cli.main(["plan", "--suite", "recall", "--budget-usd", "500"]) == 2
    assert cli.main(["plan", "--suite", "nope", "--budget-usd", "5"]) == 2


def test_run_refuses_without_the_seeded_database(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("E2E_OWNER_ACCESS_CODE", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert cli.main(["run", "--suite", "recall", "--budget-usd", "1", "--out", str(tmp_path)]) == 2
    assert cli.main(["run", "--suite", "bogus", "--budget-usd", "1", "--out", str(tmp_path)]) == 2


def test_the_ui_suite_leaves_out_mock_only_tests_and_keeps_failures_private(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: dict[str, Any] = {}

    def fake_run(ctx: cli.Context, **kwargs: Any) -> int:
        seen.update(kwargs)
        return 0

    monkeypatch.setattr(cli, "run_playwright", fake_run)
    ctx = cli.Context(suite="ui", out=tmp_path, budget_usd=1, max_scenarios=1, recall_gap_seconds=None)
    result = cli.suite_ui(ctx, browser={"E2E_BASE_URL": "http://localhost:4173"})
    assert "--grep-invert=@mock-only" in seen["specs"]
    assert "--retries=1" in seen["specs"]
    assert seen["config"] is None
    assert seen["report"] == tmp_path / "private" / "ui" / "report.json"
    assert any(str(tmp_path / "private") in arg for arg in seen["specs"] if arg.startswith("--output="))
    assert result == {"playwright_exit": 0, "passed": 0, "run": 0, "ui": None}
