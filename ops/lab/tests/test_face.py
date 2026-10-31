"""Suite face: the HeyGen LiveAvatar sandbox face. The vendor key reaches the local API process only; the public
summary carries numbers, codes and vendor end reasons, never words."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, ClassVar

import pytest

from conversation_lab import cli, config, face
from conversation_lab.report import render

KEY = "hg-test-key-0123456789abcdef"
SAID = "This is the first lab check, said exactly as written."


def test_face_runs_on_its_own_with_the_whole_budget_for_the_app() -> None:
    assert "face" in config.EXTRA_SUITES
    assert "face" not in config.suites_for("all")
    assert config.suites_for("face") == ["face"]
    assert config.budget_parts("face", 2.0) == (2.0, 0.0)
    assert config.split_budget(3.0, ["face"]) == {"face": 3.0}


def test_the_key_leaves_this_process_and_goes_to_the_api_only() -> None:
    environ = {"LAB_HEYGEN_API_KEY": f"  {KEY}\n", "LOCAL_MEDIA_FACE_API_KEY": "stale", "PATH": "/bin"}
    assert face.take_key(environ) == KEY
    assert environ == {"PATH": "/bin"}
    assert face.take_key({}) == ""
    configured = face.face_env(mock=False, probe_token="t" * 43)
    assert configured == {
        "MEDIA_FACE_MODE": "full",
        "MEDIA_FACE_AUDIENCE": "admins",
        "MEDIA_FACE_PROVIDER": "heygen-liveavatar",
        "MEDIA_FACE_SANDBOX": "true",
        "MEDIA_FACE_AVATAR_ID": face.SANDBOX_AVATAR,
        "LAB_FACE_PROBE_TOKEN": "t" * 43,
    }
    assert KEY not in json.dumps(configured)
    assert face.face_env(mock=True, probe_token=None) == {
        "MEDIA_FACE_MODE": "full",
        "MEDIA_FACE_AUDIENCE": "admins",
        "EMBODIMENT_PROVIDER": "fake",
    }
    assert face.api_process_env({"A": "1"}, KEY) == {"A": "1", "LOCAL_MEDIA_FACE_API_KEY": KEY}
    assert face.api_process_env({"A": "1"}, "") == {"A": "1"}
    assert len(face.new_probe_token()) >= 40


class FakeSession:
    def __init__(self, **_: Any) -> None:
        return None

    def client(self, *_: Any, **__: Any) -> object:
        return object()


def cli_boto3() -> Any:
    import boto3

    return boto3


class FakeStack:
    seen: ClassVar[dict[str, Any]] = {}

    def __init__(
        self, *, env: dict[str, str], log_dir: Path, web: bool, api_port: int, web_port: int
    ) -> None:
        FakeStack.seen = {"env": dict(env), "web": web}
        self.api_url = f"http://localhost:{api_port}"
        self.web_url = f"http://localhost:{web_port}"

    def __enter__(self) -> FakeStack:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeAdmin:
    def __init__(self, base_url: str, owner_code: Any) -> None:
        self.base_url = base_url
        self.baseline_usd = 0.0

    def sign_in(self) -> None:
        return None

    def usage(self) -> dict[str, Any]:
        return {"todayUsd": 0.0, "byPurpose": []}

    def apply_lab_settings(self, app_budget_usd: float, *, ui: bool = False) -> dict[str, Any]:
        return {}

    def spent_since_start(self) -> float:
        return 0.0

    def close(self) -> None:
        return None


def run_face(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *extra: str, key: str | None = KEY
) -> tuple[int, dict[str, Any], dict[str, Any]]:
    import conversation_lab.app as app_module
    import conversation_lab.stack as stack_module

    if key is not None:
        monkeypatch.setenv("LAB_HEYGEN_API_KEY", key)
    monkeypatch.setenv("E2E_OWNER_ACCESS_CODE", "FA-AAAAA-BBBBB-CCCCC-DDDDD")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/foundry")
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    # No AWS: the session and clients are stand-ins (the face suite calls no lab model).
    monkeypatch.setattr(cli_boto3(), "Session", FakeSession)
    monkeypatch.setattr(stack_module, "Stack", FakeStack)
    monkeypatch.setattr(stack_module, "run_backfill", lambda env, log_dir: "skipped (test)")
    monkeypatch.setattr(app_module, "AppAdmin", FakeAdmin)
    granted: dict[str, Any] = {}

    def grant(env: dict[str, str], log_dir: Path, *, pnpm: str) -> str:
        granted["env"] = dict(env)
        return "granted"

    monkeypatch.setattr(face, "grant_admin", grant)
    seen: ClassVar[dict[str, Any]] = {}

    def runner(ctx: cli.Context, *, browser: dict[str, str], **_: Any) -> dict[str, Any]:
        seen.update(
            ctx_env=dict(ctx.env), browser=dict(browser), token=ctx.face_probe_token, admin=ctx.face_admin
        )
        return {"passed": 1, "run": 1}

    monkeypatch.setitem(cli.SUITE_RUNNERS, "face", runner)
    out = tmp_path / "out"
    code = cli.main(["run", "--suite", "face", "--budget-usd", "1", "--out", str(out), *extra])
    seen["granted_env"] = granted.get("env", {})
    summary = json.loads((out / "public" / "summary.json").read_text(encoding="utf-8")) if code == 0 else {}
    return code, seen, summary


def test_run_hands_the_key_to_the_api_process_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    import os

    code, seen, summary = run_face(monkeypatch, tmp_path)
    assert code == 0
    api = FakeStack.seen["env"]
    assert api["LOCAL_MEDIA_FACE_API_KEY"] == KEY
    assert api["MEDIA_FACE_PROVIDER"] == "heygen-liveavatar"
    assert api["MEDIA_FACE_SANDBOX"] == "true"
    assert api["MEDIA_FACE_MODE"] == "full"
    assert api["MEDIA_FACE_AUDIENCE"] == "admins"
    assert api["LOCAL_AWS_SPEECH"] == "true"
    assert FakeStack.seen["web"] is True
    assert api["LAB_FACE_PROBE_TOKEN"] == seen["token"]
    # Playwright, the scripts and this process never hold it.
    for env in (seen["ctx_env"], seen["browser"], seen["granted_env"], dict(os.environ)):
        assert KEY not in json.dumps(env)
        assert "LAB_HEYGEN_API_KEY" not in env
        assert "LOCAL_MEDIA_FACE_API_KEY" not in env
    assert seen["admin"] == "granted"
    printed = capsys.readouterr()
    assert KEY not in printed.out + printed.err
    assert KEY not in json.dumps(summary)
    assert summary["face_admin"] == "granted"


def test_run_refuses_without_the_key_and_runs_the_stand_in_in_the_dry_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("LAB_HEYGEN_API_KEY", raising=False)
    code, _, _ = run_face(monkeypatch, tmp_path, key=None)
    assert code == 2
    assert "LAB_HEYGEN_API_KEY" in capsys.readouterr().err
    code, seen, _ = run_face(monkeypatch, tmp_path / "mock", "--mock")
    assert code == 0
    api = FakeStack.seen["env"]
    assert "LOCAL_MEDIA_FACE_API_KEY" not in api
    assert api["EMBODIMENT_PROVIDER"] == "fake"
    assert "MEDIA_FACE_PROVIDER" not in api
    assert seen["token"] is None


def write(private: Path, name: str, data: dict[str, Any]) -> None:
    (private / "face").mkdir(parents=True, exist_ok=True)
    (private / "face" / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")


def measured(private: Path) -> None:
    write(
        private,
        "instruments",
        {
            "delivered": True,
            "sameLength": True,
            "injectedArrived": True,
            "admittedGone": True,
            "out": 1,
            "in": 1,
            "injected": 1,
            "injectCleared": True,
            "livekit": True,
            "meter": True,
            "appMeter": True,
        },
    )
    write(
        private,
        "probe",
        {
            "full_room": {"connectedMs": 812, "firstVideoMs": 1904, "canPublishData": True, "error": None},
            "full_room_b": {"connectedMs": 700, "firstVideoMs": 1500, "canPublishData": True, "error": None},
            "lite_room": {"connectedMs": 650, "firstVideoMs": 1400, "canPublishData": False, "error": None},
            "exact": {
                "speak_started": True,
                "speak_ended": True,
                "transcriptions": 1,
                "matches": True,
                "publish_to_started_ms": 640,
                "publish_to_audio_ms": 702,
                "publish_to_transcription_ms": 12,
                "said": SAID,
            },
            "queue": {
                "starts": 3,
                "ends": 3,
                "transcriptions": 3,
                "in_order": True,
                "behaviour": "queued",
                "gaps_ms": [310, 290],
            },
            "transcript_endpoint": {
                "status": 200,
                "ms": 180,
                "complete": True,
                "avatar_lines": 4,
                "user_lines": 0,
                "has_exact": True,
                "has_all_queue": True,
            },
            "interrupt": {
                "started_before": True,
                "to_speak_ended_ms": 210,
                "to_silence_ms": 260,
                "queued_started_after": 0,
                "queued_transcribed": False,
                "queue_cleared": True,
            },
            "speak_response": {"speak_started": 0, "avatar_transcriptions": 0, "ignored": True},
            "idle_end": {"stopped": True, "end_reason": "MAX_DURATION_REACHED", "seconds": 61.2},
            "max_duration": {
                "requested_seconds": 30,
                "stopped": True,
                "end_reason": "MAX_DURATION_REACHED",
                "seconds": 31.4,
            },
            "full_user_transcriptions": 0,
            "probe_mic_requests": 0,
            "probe_audio_senders": 0,
        },
    )
    write(
        private,
        "call",
        {
            "vendor": "heygen",
            "input_mode": "typed",
            "label_visible": True,
            "label_text_ok": True,
            "session": {
                "provider": "heygen",
                "voicing": "text",
                "stockFace": True,
                "livekitHost": "heygen-feapbkvq.livekit.cloud",
            },
            "turns": [
                {"firstSpeakStartedMs": 2100, "firstFaceAudioMs": 2180, "firstAppPlaybackMs": None},
                {"firstSpeakStartedMs": 1900, "firstFaceAudioMs": None, "firstAppPlaybackMs": None},
                {"firstSpeakStartedMs": 1000, "firstFaceAudioMs": 1150, "firstAppPlaybackMs": None},
            ],
            "units": {"publishToStartedMs": [600, 650, 700], "publishToAudioMs": [680, 720]},
            "speak_text_sent": 5,
            "say_requests": 5,
            "app_playbacks_after_live": 0,
            "mic_requests_after_live": 0,
            "audio_senders": 0,
            "user_transcriptions": 0,
            "fallback": {
                "presence_back": True,
                "seconds_live": 58.7,
                "session_stopped_event": True,
                "end_reason": "MAX_DURATION_REACHED",
                "typed_line_editable": True,
            },
        },
    )
    write(
        private,
        "injection",
        {
            "injected": True,
            "face_ended": True,
            "seconds_to_end": 11.5,
            "heartbeat_seconds": 15,
            "audit_injection_events": 1,
            "audit_ids": [41],
            "seconds_into_session": 8.2,
            "end_reason": "USER_CLOSED",
        },
    )
    write(
        private,
        "polly",
        {
            "turns": [
                {
                    "firstSpeakStartedMs": None,
                    "firstFaceAudioMs": None,
                    "firstAppPlaybackMs": 1500,
                    "firstAppAudioMs": 1540,
                },
                {
                    "firstSpeakStartedMs": None,
                    "firstFaceAudioMs": None,
                    "firstAppPlaybackMs": 1700,
                    "firstAppAudioMs": 1760,
                },
            ]
        },
    )


CALLS = [
    {"method": "GET", "path": "/v1/users/credits", "status": 200, "code": 100},
    {"method": "POST", "path": "/v1/sessions/token", "status": 200, "code": 1000},
    {"method": "POST", "path": "/v1/sessions/start", "status": 201, "code": 1000},
    {"method": "GET", "path": "/v1/sessions/{id}/transcript", "status": 200, "code": 100},
    {"method": "POST", "path": "/v1/sessions/stop", "status": 200, "code": 1000},
    {"method": "GET", "path": "/v1/secret/abc", "status": 404, "code": None},
]


HEARTBEAT_AUDIT = {"heartbeat": 1, "at_end": 0, "unknown": 0}


def graded(private: Path, *, injection_audits: dict[str, int] | None = None) -> dict[str, Any]:
    return face.public_result(
        private,
        playwright_exit=0,
        credits_before={"status": 200, "code": 100, "creditsLeft": "10.00"},
        credits_after={"status": 200, "code": 100, "creditsLeft": "10.00"},
        vendor_calls=CALLS,
        vendor="heygen-sandbox",
        admin_grant="granted",
        injection_audits=HEARTBEAT_AUDIT if injection_audits is None else injection_audits,
    )


def test_public_result_grades_every_sandbox_check_with_numbers_only(tmp_path: Path) -> None:
    private = tmp_path / "private"
    measured(private)
    result = graded(private)
    assert result["success_codes"] == [1000]
    assert result["credits"]["used"] == 0
    assert result["vendor_calls"]["other"] == {"status": {"404": 1}, "code": {}}
    # Two distributions, never mixed: the vendor's event and the sound the page heard.
    assert result["call"]["first_speak_started_ms"] == {"p50": 1900, "p95": 2100, "n": 3}
    assert result["call"]["first_face_audio_ms"] == {"p50": 1150, "p95": 2180, "n": 2}
    # Polly measured the way the face is (a level onset on the app's output), the scheduling time apart.
    assert result["polly"]["first_audio_ms"] == {"p50": 1540, "p95": 1760, "n": 2}
    assert result["polly"]["first_scheduled_ms"] == {"p50": 1500, "p95": 1700, "n": 2}
    assert result["injection"]["audit_heartbeat_events"] == 1
    assert result["injection"]["seconds_into_session"] == 8.2
    assert "audit_ids" not in result["injection"]
    assert result["probe"]["queue"]["behaviour"] == "queued"
    checks = result["checks"]
    assert checks["e1_success_code_recorded"] is True
    assert checks["e1_livekit_host_expected"] is True
    assert checks["e2_no_credits_used"] is True
    assert checks["e3_speak_text_exact"] is True
    assert checks["e5_first_audio_under_target"] is True
    assert checks["e9_lite_token_cannot_publish"] is True
    assert checks["e10_injection_ends_face_in_a_heartbeat"] is True
    assert checks["e11_max_duration_enforced"] is True
    assert checks["instruments_ok"] is True
    assert result["run"] == len(checks)
    assert result["passed"] == len(checks)
    text = json.dumps(result)
    assert SAID not in text
    assert "/v1/secret/abc" not in text
    summary = {"suite": "face", "result": {"face": result, "passed": 1, "run": 1}, "spend": {}}
    rendered = render(summary)
    assert "e10_injection_ends_face_in_a_heartbeat | pass" in rendered
    assert "e5_first_audio_under_target | pass" in rendered
    assert SAID not in rendered


def test_nothing_but_numbers_and_codes_survives_from_the_private_files(tmp_path: Path) -> None:
    private = tmp_path / "private"
    write(
        private,
        "call",
        {
            "label_visible": "yes",
            "session": {"provider": SAID, "voicing": "text", "livekitHost": "evil.example.com/x?a=b"},
            "fallback": {"end_reason": SAID, "seconds_live": "58"},
            "error": "Error: " + SAID,
            "turns": [{"firstFaceAudioMs": "fast"}, "nope"],
        },
    )
    write(
        private,
        "probe",
        {"queue": {"behaviour": SAID, "gaps_ms": [1, "x", True]}, "idle_end": {"end_reason": 7}},
    )
    result = face.public_result(
        private,
        playwright_exit=1,
        credits_before={"creditsLeft": "ten"},
        credits_after=None,
        vendor_calls=[],
        vendor=SAID,
        admin_grant=SAID,
    )
    text = json.dumps(result)
    assert SAID not in text
    assert result["vendor"] is None
    assert result["admin_grant"] is None
    assert result["call"]["session"] == {
        "provider": None,
        "voicing": "text",
        "stock_face": None,
        "livekit_host": None,
    }
    assert result["call"]["error"] is None
    assert result["probe"]["queue"]["gaps_ms"] == [1]
    assert result["credits"]["used"] is None
    assert result["checks"]["e2_no_credits_used"] is None
    assert result["injection"] is None


def test_missing_measurements_are_not_measured_not_failed(tmp_path: Path) -> None:
    result = face.public_result(
        tmp_path,
        playwright_exit=0,
        credits_before=None,
        credits_after=None,
        vendor_calls=[],
        vendor="stand-in",
        admin_grant="already",
    )
    assert result["run"] == 0
    assert set(result["checks"].values()) == {None}


def test_vendor_calls_are_summarized_by_known_path() -> None:
    summary = face.summarize_vendor_calls(CALLS)
    assert summary["/v1/sessions/token"] == {"status": {"200": 1}, "code": {"1000": 1}}
    assert face.success_codes(summary) == [1000]
    assert face.success_codes(face.summarize_vendor_calls([])) == []
    assert face.percentile_ms([]) is None
    assert face.percentile_ms([5, 1, 3]) == {"p50": 3, "p95": 5, "n": 3}


def test_e10_counts_only_a_heartbeat_catching_the_injection(tmp_path: Path) -> None:
    private = tmp_path / "private"
    measured(private)
    assert graded(private)["checks"]["e10_injection_ends_face_in_a_heartbeat"] is True
    # The sandbox's minute ended the face and the final check wrote the audit (atEnd): not the heartbeat.
    at_end = graded(private, injection_audits={"heartbeat": 0, "at_end": 1, "unknown": 0})
    assert at_end["checks"]["e10_injection_ends_face_in_a_heartbeat"] is False
    assert at_end["injection"]["audit_at_end_events"] == 1
    # No audit lookup (the script failed): never a pass.
    lookup_failed = face.public_result(
        private,
        playwright_exit=0,
        credits_before=None,
        credits_after=None,
        vendor_calls=[],
        vendor="heygen-sandbox",
        admin_grant="granted",
        injection_audits=None,
    )
    assert lookup_failed["checks"]["e10_injection_ends_face_in_a_heartbeat"] is False
    # A heartbeat audit, but the vendor says the session ran out: the minute, not our stop, ended the face.
    raw = json.loads((private / "face" / "injection.json").read_text(encoding="utf-8"))
    write(private, "injection", {**raw, "end_reason": "MAX_DURATION_REACHED"})
    assert graded(private)["checks"]["e10_injection_ends_face_in_a_heartbeat"] is False


def test_e5_never_substitutes_the_vendor_event_for_the_sound(tmp_path: Path) -> None:
    private = tmp_path / "private"
    measured(private)
    raw = json.loads((private / "face" / "call.json").read_text(encoding="utf-8"))
    raw["turns"] = [
        {"firstSpeakStartedMs": 900, "firstFaceAudioMs": None, "firstAppPlaybackMs": None},
        {"firstSpeakStartedMs": 1000, "firstFaceAudioMs": None, "firstAppPlaybackMs": None},
    ]
    write(private, "call", raw)
    result = graded(private)
    assert result["call"]["first_face_audio_ms"] is None
    assert result["call"]["first_speak_started_ms"] == {"p50": 900, "p95": 1000, "n": 2}
    assert result["checks"]["e5_first_audio_under_target"] is None


def test_the_instruments_include_both_level_meters(tmp_path: Path) -> None:
    private = tmp_path / "private"
    measured(private)
    assert graded(private)["instruments"]["ok"] is True
    for flag in ("meter", "appMeter"):
        raw = json.loads((private / "face" / "instruments.json").read_text(encoding="utf-8"))
        write(private, "instruments", {**raw, flag: False})
        assert graded(private)["checks"]["instruments_ok"] is False
        write(private, "instruments", raw)


def test_injection_audits_reads_ids_and_parses_the_script_line(tmp_path: Path) -> None:
    private = tmp_path / "private"
    write(private, "injection", {"audit_ids": [41, "42", -1, True, 7.5, 43, 41]})
    assert face.read_audit_ids(private) == [41, 43]
    assert face.read_audit_ids(tmp_path / "nowhere") == []
    assert face.parse_audits_line("lab-face-audits: heartbeat=1 at_end=2 unknown=0\n") == {
        "heartbeat": 1,
        "at_end": 2,
        "unknown": 0,
    }
    assert face.parse_audits_line("lab-face-audits: refused (DATABASE_URL is not set)") is None
