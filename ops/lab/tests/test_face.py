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


# ---- face_mode: FULL, LITE, or both side by side ------------------------------------------------------------


def test_face_mode_is_full_lite_or_both_and_both_runs_full_first() -> None:
    assert config.FACE_MODES == ("both", "full", "lite")
    assert config.face_passes("both") == ["full", "lite"]
    assert config.face_passes("full") == ["full"]
    assert config.face_passes("lite") == ["lite"]
    for bad in ("", "FULL", "lite,full", "none"):
        with pytest.raises(ValueError, match="face mode must be one of"):
            config.face_passes(bad)


def test_lite_face_env_is_the_sandbox_for_admins_without_a_stock_avatar() -> None:
    lite = face.face_env(mock=False, probe_token="t" * 43, mode="lite")
    assert lite == {
        "MEDIA_FACE_MODE": "lite",
        "MEDIA_FACE_AUDIENCE": "admins",
        "MEDIA_FACE_PROVIDER": "heygen-liveavatar",
        "MEDIA_FACE_SANDBOX": "true",
        "LAB_FACE_PROBE_TOKEN": "t" * 43,
    }
    assert face.face_env(mock=True, probe_token=None, mode="lite") == {
        "MEDIA_FACE_MODE": "lite",
        "MEDIA_FACE_AUDIENCE": "admins",
        "EMBODIMENT_PROVIDER": "fake",
    }
    with pytest.raises(ValueError, match="mode must be full or lite"):
        face.face_env(mock=False, probe_token=None, mode="both")
    # Switching modes leaves nothing of the other behind (FULL's stock avatar) and keeps everything else.
    full = {"A": "1", **face.face_env(mock=False, probe_token="t" * 43)}
    assert face.with_face_mode(full, mock=False, probe_token="t" * 43, mode="lite") == {"A": "1", **lite}


def test_run_starts_the_api_in_the_first_pass_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    code, _, summary = run_face(monkeypatch, tmp_path, "--face-mode", "lite")
    assert code == 0
    api = FakeStack.seen["env"]
    assert api["MEDIA_FACE_MODE"] == "lite"
    assert "MEDIA_FACE_AVATAR_ID" not in api
    assert api["LOCAL_MEDIA_FACE_API_KEY"] == KEY
    assert summary["face_mode"] == "lite"
    # The default: both, FULL first.
    code, _, summary = run_face(monkeypatch, tmp_path / "default")
    assert code == 0
    assert FakeStack.seen["env"]["MEDIA_FACE_MODE"] == "full"
    assert summary["face_mode"] == "both"
    with pytest.raises(SystemExit):
        cli.main(
            ["run", "--suite", "face", "--budget-usd", "1", "--out", str(tmp_path / "x"), "--face-mode", "x"]
        )


class RestartingStack:
    def __init__(self) -> None:
        self.restarts: list[dict[str, str]] = []

    def restart_api(self, env: dict[str, str]) -> None:
        self.restarts.append(dict(env))


class FakeProbe:
    """Each API process remembers its own calls: one token call per process here, answered with that process's
    code (``codes``, in order: the first API process, then the restarted one), and credits that drop by
    ``spent`` in each process after the first."""

    process = 0
    codes: ClassVar[list[int]] = [1000, 1000]
    spent: ClassVar[list[str]] = ["10.00", "10.00", "10.00"]

    def __init__(self, api_url: str, token: str) -> None:
        self.api_url = api_url
        self.reads = 0

    def credits(self) -> dict[str, Any]:
        left = FakeProbe.spent[min(self.reads, len(FakeProbe.spent) - 1)]
        self.reads += 1
        return {"status": 200, "code": 100, "creditsLeft": left}

    def vendor_calls(self) -> list[dict[str, Any]]:
        code = FakeProbe.codes[min(FakeProbe.process, len(FakeProbe.codes) - 1)]
        FakeProbe.process += 1
        return [{"method": "POST", "path": "/v1/sessions/token", "status": 200, "code": code}]


def run_suite_face(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mode: str,
    *,
    mock: bool = False,
    codes: tuple[int, int] = (1000, 1000),
    credits_left: tuple[str, str, str] = ("10.00", "10.00", "10.00"),
) -> tuple[dict[str, Any], list[dict[str, Any]], list[str], RestartingStack]:
    monkeypatch.setattr(cli, "_FACE_KEY", "" if mock else KEY)
    monkeypatch.setattr(face, "Probe", FakeProbe)
    FakeProbe.process = 0
    monkeypatch.setattr(FakeProbe, "codes", list(codes))
    monkeypatch.setattr(FakeProbe, "spent", list(credits_left))
    passes: list[dict[str, Any]] = []
    order: list[str] = []

    def playwright(ctx: cli.Context, **kwargs: Any) -> int:
        order.append(f"playwright:{kwargs['extra_env']['LAB_FACE_APP_MODE']}")
        passes.append({**kwargs, "ctx_env": dict(ctx.env)})
        return 0

    def twin(env: dict[str, str], log_dir: Path, *, pnpm: str) -> str:
        order.append("twin")
        assert KEY not in json.dumps(env)
        return "ready"

    monkeypatch.setattr(cli, "run_playwright", playwright)
    monkeypatch.setattr(face, "seed_twin", twin)
    monkeypatch.setattr(face, "injection_audits", lambda *a, **k: None)
    ctx = cli.Context(
        suite="face",
        out=tmp_path,
        budget_usd=1.0,
        max_scenarios=1,
        recall_gap_seconds=None,
        env=face.face_env(mock=mock, probe_token=None if mock else "t" * 43, mode=config.face_passes(mode)[0])
        | {"DATABASE_URL": "postgresql://u:p@localhost/foundry"},
        face_probe_token=None if mock else "t" * 43,
        face_admin="granted",
        face_mode=mode,
        mock=mock,
    )
    stack = RestartingStack()
    out = cli.suite_face(ctx, browser={"E2E_API_URL": "http://localhost:8787"}, stack=stack)
    return out, passes, order, stack


def test_both_runs_full_then_restarts_the_api_in_lite_for_the_call_arm_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    out, passes, order, stack = run_suite_face(monkeypatch, tmp_path, "both")
    assert order == ["playwright:full", "twin", "playwright:lite"]
    first, second = passes
    assert first["specs"] == ["--project=face"]
    assert first["report"].name == "playwright.json"
    # The second pass runs the LITE call arm only: the FULL checks ran once, in the first pass.
    assert second["specs"] == ["--project=face", "--grep", cli.FACE_LITE_CALL_GREP]
    assert second["report"].name == "playwright-lite.json"
    assert second["ctx_env"]["MEDIA_FACE_MODE"] == "lite"
    # The vendor key reaches the restarted API process only.
    (restarted,) = stack.restarts
    assert restarted["MEDIA_FACE_MODE"] == "lite"
    assert restarted["LOCAL_MEDIA_FACE_API_KEY"] == KEY
    assert restarted["LAB_FACE_PROBE_TOKEN"] == "t" * 43
    assert "MEDIA_FACE_AVATAR_ID" not in restarted
    for p in passes:
        assert KEY not in json.dumps({k: v for k, v in p.items() if k != "report"}, default=str)
    result = out["face"]
    assert result["face_mode"] == "both"
    assert result["lite_face_reference"] == "ready"
    assert result["playwright_exits"] == {"full": 0, "lite": 0}
    # Each API process's vendor calls are its own pass's: FULL's grade E1, LITE's are reported beside them.
    assert result["vendor_calls"]["/v1/sessions/token"]["code"] == {"1000": 1}
    assert result["call_lite_vendor"]["vendor_calls"]["/v1/sessions/token"]["code"] == {"1000": 1}
    assert result["call_lite_vendor"]["success_codes"] == [1000]


def test_a_lite_pass_refused_by_the_vendor_leaves_the_full_checks_as_they_were(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    clean, *_ = run_suite_face(monkeypatch, tmp_path / "clean", "both")
    # The restarted LITE process's token call answers 4000 and that pass spends credits (a misconfigured sandbox):
    # the FULL pass is unchanged, so E1 and E2 (and every other check) read exactly as in the clean run.
    refused, *_ = run_suite_face(
        monkeypatch, tmp_path / "refused", "both", codes=(1000, 4000), credits_left=("10.00", "10.00", "9.50")
    )
    full, lite = clean["face"], refused["face"]
    assert lite["checks"] == full["checks"]
    assert (lite["passed"], lite["run"]) == (full["passed"], full["run"])
    assert lite["checks"]["e1_success_code_recorded"] is True
    assert lite["checks"]["e2_no_credits_used"] is True
    assert lite["success_codes"] == [1000]
    assert lite["vendor_calls"] == full["vendor_calls"]
    assert lite["credits"] == full["credits"]
    # The LITE pass's own numbers are public, beside the checks.
    assert lite["call_lite_vendor"] == {
        "credits": {"before": 10.0, "after": 9.5, "used": 0.5, "status": 200, "code": 100},
        "vendor_calls": {"/v1/sessions/token": {"status": {"200": 1}, "code": {"4000": 1}}},
        "success_codes": [4000],
    }
    rendered = render({"suite": "face", "result": refused, "spend": {}})
    assert "LITE pass, its own API process (reported only" in rendered
    assert "success codes (token, start): [4000]; credits before 10.0, after 9.5, used 0.5" in rendered
    assert "/v1/sessions/token status 200 x1 code 4000 x1" in rendered


def test_a_single_mode_runs_one_pass_without_a_restart(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    out, passes, order, stack = run_suite_face(monkeypatch, tmp_path / "full", "full")
    assert order == ["playwright:full"]
    assert stack.restarts == []
    assert out["face"]["lite_face_reference"] == "not_run"
    assert out["face"]["call_lite_vendor"] is None
    out, passes, order, stack = run_suite_face(monkeypatch, tmp_path / "lite", "lite", mock=True)
    assert order == ["twin", "playwright:lite"]
    assert stack.restarts == []
    assert passes[0]["specs"] == ["--project=face"]
    assert out["face"]["vendor"] == "stand-in"
    # A LITE-only run has one pass: it is the graded one, with no separate LITE vendor block.
    assert out["face"]["call_lite_vendor"] is None


def lite_measured(private: Path) -> None:
    write(
        private,
        "call-lite",
        {
            "vendor": "heygen",
            "mode": "lite",
            "face_shown": True,
            "session": {
                "provider": "heygen",
                "voicing": "audio",
                "stockFace": False,
                "livekitHost": "heygen-feapbkvq.livekit.cloud",
            },
            "turns": [
                {
                    "firstSpeakStartedMs": None,
                    "firstFaceAudioMs": 1900,
                    "firstAppPlaybackMs": None,
                    "firstAppAudioMs": 1910,
                    "firstHandOverMs": 1300,
                    "firstHandOverDoneMs": 1700,
                },
                {
                    "firstSpeakStartedMs": None,
                    "firstFaceAudioMs": 1700,
                    "firstAppPlaybackMs": None,
                    "firstAppAudioMs": 1720,
                    "firstHandOverMs": 1200,
                    "firstHandOverDoneMs": 1500,
                },
            ],
            "units": {
                "handOverToStartedMs": [],
                "handOverToAudioMs": [500, 600, 550],
                "handOverToDoneMs": [300, 320, 310],
            },
            "speak_requests": 3,
            "speak_accepted": 3,
            "speak_text_sent": 0,
            "app_playbacks_after_live": 0,
            "mic_requests_after_live": 0,
            "audio_senders": 0,
        },
    )


def test_the_lite_arm_sits_beside_full_and_polly_without_changing_the_checks(tmp_path: Path) -> None:
    private = tmp_path / "private"
    measured(private)
    full_only = graded(private)
    lite_measured(private)
    result = face.public_result(
        private,
        playwright_exit=0,
        credits_before={"status": 200, "code": 100, "creditsLeft": "10.00"},
        credits_after={"status": 200, "code": 100, "creditsLeft": "10.00"},
        vendor_calls=CALLS,
        vendor="heygen-sandbox",
        admin_grant="granted",
        injection_audits=HEARTBEAT_AUDIT,
        face_mode="both",
        twin="ready",
        # The LITE pass's own process: a refused start and credits spent must not reach E1 or E2.
        lite_vendor_calls=[
            {"method": "POST", "path": "/v1/sessions/token", "status": 200, "code": 1000},
            {"method": "POST", "path": "/v1/sessions/start", "status": 400, "code": 4000},
        ],
        lite_credits_after={"status": 200, "code": 100, "creditsLeft": "9.75"},
    )
    # The checks grade the FULL arm exactly as before.
    assert result["checks"] == full_only["checks"]
    assert result["success_codes"] == full_only["success_codes"] == [1000]
    assert result["credits"] == full_only["credits"]
    assert result["call_lite_vendor"]["success_codes"] == [1000, 4000]
    assert result["call_lite_vendor"]["credits"]["used"] == 0.25
    assert full_only["call_lite_vendor"] is None
    assert (result["passed"], result["run"]) == (full_only["passed"], full_only["run"])
    lite = result["call_lite"]
    assert lite["session"]["voicing"] == "audio"
    assert lite["first_face_audio_ms"] == {"p50": 1700, "p95": 1900, "n": 2}
    assert lite["first_speak_started_ms"] is None
    assert lite["first_hand_over_ms"] == {"p50": 1200, "p95": 1300, "n": 2}
    assert lite["first_hand_over_done_ms"] == {"p50": 1500, "p95": 1700, "n": 2}
    assert lite["hand_over_to_audio_ms"] == {"p50": 550, "p95": 600, "n": 3}
    assert lite["hand_over_to_done_ms"] == {"p50": 310, "p95": 320, "n": 3}
    table = result["comparison"]
    rows = {row["key"]: row for row in table["rows"]}
    assert list(rows) == [
        "first_face_audio_ms",
        "first_speak_started_ms",
        "first_hand_over_ms",
        "first_hand_over_done_ms",
        "unit_to_audio_ms",
        "unit_to_started_ms",
    ]
    assert rows["first_face_audio_ms"]["full"] == {"p50": 1150, "p95": 2180, "n": 2}
    assert rows["first_face_audio_ms"]["lite"] == {"p50": 1700, "p95": 1900, "n": 2}
    assert rows["first_face_audio_ms"]["polly"] == {"p50": 1540, "p95": 1760, "n": 2}
    assert rows["unit_to_audio_ms"]["full"] == {"p50": 680, "p95": 720, "n": 2}
    assert rows["unit_to_audio_ms"]["lite"] == {"p50": 550, "p95": 600, "n": 3}
    assert rows["first_hand_over_done_ms"]["full"] is None
    assert rows["first_speak_started_ms"]["polly"] is None
    assert table["lite_minus_full_first_audio_p50_ms"] == 550
    assert table["faster_first_audio"] == "full"
    assert table["full_minus_polly_first_audio_p50_ms"] == -390
    assert table["lite_minus_polly_first_audio_p50_ms"] == 160
    rendered = render({"suite": "face", "result": {"face": result, "passed": 1, "run": 1}, "spend": {}})
    assert "| Moment | FULL | LITE | Polly only |" in rendered
    assert (
        "| Turn sent → first audio (level onset) | 1150 / 2180 (n=2) | 1700 / 1900 (n=2) | 1540 / 1760 (n=2) |"
        in rendered
    )
    assert "| Turn sent → first avatar.speak_started | 1900 / 2100 (n=3) | - | - |" in rendered
    assert "LITE minus FULL +550 ms (faster: full)" in rendered
    assert "In-app call, LITE" in rendered
    assert "face reference ready" in rendered


def test_a_full_only_run_still_compares_full_with_polly(tmp_path: Path) -> None:
    private = tmp_path / "private"
    measured(private)
    result = graded(private)
    assert result["call_lite"] is None
    assert result["lite_face_reference"] == "not_run"
    table = result["comparison"]
    assert table["rows"][0]["lite"] is None
    assert table["lite_minus_full_first_audio_p50_ms"] is None
    assert table["faster_first_audio"] is None
    assert table["full_minus_polly_first_audio_p50_ms"] == -390
    rendered = render({"suite": "face", "result": {"face": result, "passed": 1, "run": 1}, "spend": {}})
    assert "| Turn sent → first audio (level onset) | 1150 / 2180 (n=2) | - | 1540 / 1760 (n=2) |" in rendered
    assert "LITE minus FULL" not in rendered
    # Nothing measured at all: no table.
    empty = face.public_result(
        tmp_path / "nothing",
        playwright_exit=0,
        credits_before=None,
        credits_after=None,
        vendor_calls=[],
        vendor="stand-in",
        admin_grant="already",
    )
    assert "| Moment |" not in render(
        {"suite": "face", "result": {"face": empty, "passed": 0, "run": 0}, "spend": {}}
    )


def test_nothing_but_numbers_survives_from_the_lite_file(tmp_path: Path) -> None:
    private = tmp_path / "private"
    write(
        private,
        "call-lite",
        {
            "face_shown": "yes",
            "session": {"provider": SAID, "voicing": SAID, "livekitHost": "evil.example.com/x"},
            "turns": [{"firstHandOverMs": "soon", "firstFaceAudioMs": 900}, SAID],
            "units": {"handOverToAudioMs": [1, SAID, False], "handOverToDoneMs": SAID},
            "speak_requests": SAID,
            "error": "Error: " + SAID,
        },
    )
    result = face.public_result(
        private,
        playwright_exit=1,
        credits_before=None,
        credits_after=None,
        vendor_calls=[],
        vendor="heygen-sandbox",
        admin_grant="granted",
        face_mode=SAID,
        twin=SAID,
    )
    assert SAID not in json.dumps(result)
    lite = result["call_lite"]
    assert lite["face_shown"] is None
    assert lite["session"] == {"provider": None, "voicing": None, "stock_face": None, "livekit_host": None}
    assert lite["first_hand_over_ms"] is None
    assert lite["first_face_audio_ms"] == {"p50": 900, "p95": 900, "n": 1}
    assert lite["hand_over_to_audio_ms"] == {"p50": 1, "p95": 1, "n": 1}
    assert lite["hand_over_to_done_ms"] is None
    assert lite["speak_requests"] is None
    assert lite["error"] is None
    assert result["face_mode"] is None
    assert result["lite_face_reference"] is None


def test_the_twin_script_line_is_parsed_strictly() -> None:
    assert face.parse_twin_line("noise\nlab-face-twin: personas=1 face=ready\n") == "ready"
    assert face.parse_twin_line("lab-face-twin: personas=0 face=not_found") == "not_found"
    assert face.parse_twin_line("lab-face-twin: refused (DATABASE_URL is not set)") is None
    assert face.parse_twin_line("lab-face-twin: personas=1 face=ready; " + SAID) is None


def test_the_stack_restarts_its_api_alone_with_the_new_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import subprocess

    import conversation_lab.stack as stack_module

    started: list[tuple[str, dict[str, str]]] = []

    def start(self: stack_module.Stack, name: str, args: list[str], env: dict[str, str]) -> None:
        proc = subprocess.Popen(["sleep", "30"], start_new_session=True)  # noqa: S607 - a stand-in process
        self._procs.append((name, proc, (tmp_path / f"{name}-{len(started)}.log").open("ab")))
        started.append((name, dict(env)))

    monkeypatch.setattr(stack_module.Stack, "_start", start)
    monkeypatch.setattr(stack_module, "wait_for", lambda url, **_: None)
    stack = stack_module.Stack(env={"MEDIA_FACE_MODE": "full"}, log_dir=tmp_path, web=True)
    with stack:
        api, web = (entry[1] for entry in stack._procs)
        stack.restart_api({"MEDIA_FACE_MODE": "lite"})
        assert api.wait(timeout=10) is not None  # the old API process is gone
        assert web.poll() is None  # the web preview keeps running
        assert [name for name, _ in started] == ["api", "web", "api"]
        assert started[-1][1] == {"MEDIA_FACE_MODE": "lite"}
        assert stack.env == {"MEDIA_FACE_MODE": "lite"}
        assert [entry[0] for entry in stack._procs] == ["web", "api"]
    assert stack._procs == []
    assert web.wait(timeout=10) is not None
