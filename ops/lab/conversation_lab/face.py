"""Suite ``face``: the HeyGen LiveAvatar FULL stock face against the vendor's free SANDBOX (plan section E, checks
1 to 11), headless and silent, and the same in-app call arm with the face in LITE mode, for a side-by-side latency
comparison (``--face-mode``: full, lite or both; both by default).

The job starts the app as every suite does, with the face wired as it will be for the presentation, but in the
sandbox: ``MEDIA_FACE_PROVIDER=heygen-liveavatar``, ``MEDIA_FACE_MODE=full``, ``MEDIA_FACE_SANDBOX=true``,
``MEDIA_FACE_AUDIENCE=admins`` and the sandbox's stock avatar (Wayne). The vendor key (the repository secret
``HEYGEN_LIVEAVATAR_API``, handed to the run step as :data:`KEY_ENV`) goes to the local API process only, as
``LOCAL_MEDIA_FACE_API_KEY`` (apps/api runtime/local-face.ts, refused outside development): it is removed from this
process's environment at once, never put in the environment of Playwright, the web server or any script, never
printed, never written to the private folder (so never sealed or uploaded).

The browser spec (apps/web/e2e/lab/face.lab.ts) runs four tests and writes what it measured to the private folder:
the vendor probe (raw sandbox rooms through the dev server's lab probe, :data:`PROBE_TOKEN_ENV`), a call with the
face (as the seeded founder, made a platform admin of the synthetic venture by apps/api lab-face-admin.ts), an
injected ``speak_text`` that the server's transcript check must catch, and the same turns on Polly alone. This
module reads the vendor's credits and the success codes it answered through the probe, and keeps public numbers
only (:func:`public_result`): codes, counts, booleans, milliseconds, vendor end reasons. Words stay private.

LITE (``--face-mode lite`` or ``both``): the avatar lip-syncs the call's own Polly audio, which the browser hands back
to the server (``POST /calls/:id/face/speak``) and the server relays over the face's speak socket: the production
LITE path, unchanged. As in production, the call's vEIR needs a face reference marked ready under likeness consent:
apps/api lab-face-twin.ts records one for the synthetic vEIR in the lab's own database (never the seed). The sandbox
renders its own avatar whatever the reference names. With ``both`` the FULL pass runs first with every check; then
the local API is restarted with ``MEDIA_FACE_MODE=lite`` and only the call arm runs again, with the same founder
turns and the same meters (:func:`comparison`: FULL, LITE and Polly alone side by side).

In the harness's dry run (``--mock``) the development stand-in face takes the vendor's place: no key, no probe, no
vendor; only the in-app path is exercised.
"""

from __future__ import annotations

import json
import math
import re
import secrets
import subprocess
import urllib.error
import urllib.request
from collections.abc import Mapping, MutableMapping, Sequence
from pathlib import Path
from typing import Any

from conversation_lab.config import REPO

#: The variable the workflow puts the vendor key in, for this process to hand to the local API only.
KEY_ENV = "LAB_HEYGEN_API_KEY"
#: The local API's own variable for it (apps/api runtime/local-face.ts LOCAL_FACE_KEY).
API_KEY_ENV = "LOCAL_MEDIA_FACE_API_KEY"
#: The lab probe's per-run token (apps/api runtime/local-face.ts LAB_FACE_PROBE_TOKEN): random, not a secret of
#: the platform; the API, the spec and this module share it.
PROBE_TOKEN_ENV = "LAB_FACE_PROBE_TOKEN"  # noqa: S105 - a variable name, not a value
PROBE_HEADER = "x-lab-probe-token"
#: The vendor sandbox's only avatar (docs.liveavatar.com, "Developing in Sandbox Mode").
SANDBOX_AVATAR = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"
#: The LiveKit host the vendor's rooms were documented on (the CSP origins planned for the face).
EXPECTED_LIVEKIT_HOSTS = frozenset({"heygen-feapbkvq.livekit.cloud"})
#: The call heartbeat (packages/core CALL_LIMITS.heartbeatSeconds): the transcript check runs at each.
HEARTBEAT_SECONDS = 15
#: The founder's end of turn to the face's first sound, the plan's target (E5).
FIRST_AUDIO_TARGET_MS = 1200
#: A FULL turn's first spoken unit reaching the page to its hand-over to the face (``avatar.speak_text``), at p50.
#: The server pre-approves each unit as it signs it (docs/architecture/calls.md §4), so the page hands it over on
#: arrival: no ``face/say`` round trip (lab runs 41226018170 and 41226813922 measured about 0.6 s of it) sits there.
HAND_OVER_AFTER_UNIT_TARGET_MS = 250
#: The vendor paths the public summary may name; anything else is counted as ``other``.
VENDOR_PATHS = (
    "/v1/sessions/token",
    "/v1/sessions/start",
    "/v1/sessions/stop",
    "/v1/sessions/keep-alive",
    "/v1/sessions/{id}/transcript",
    "/v1/users/credits",
)
#: The private files the spec writes (numbers and codes; the words are in separate ``*-texts.json`` files).
RESULT_FILES = ("instruments", "probe", "call", "call-lite", "injection", "polly")
#: The side-by-side table of the in-app arms (:func:`comparison`): each row's key and title, and which measurement
#: of each arm fills it (None: that arm has no such moment).
COMPARISON_ROWS: tuple[tuple[str, str, str | None, str | None, str | None], ...] = (
    (
        "first_face_audio_ms",
        "Turn sent → first audio (level onset)",
        "first_face_audio_ms",
        "first_face_audio_ms",
        "first_audio_ms",
    ),
    (
        "first_speak_started_ms",
        "Turn sent → first avatar.speak_started",
        "first_speak_started_ms",
        "first_speak_started_ms",
        None,
    ),
    (
        "first_unit_ms",
        "Turn sent → first spoken unit arrives (turn.speech)",
        "first_unit_ms",
        "first_unit_ms",
        "first_unit_ms",
    ),
    (
        "first_hand_over_ms",
        "Turn sent → first hand-over to the face (FULL speak_text, LITE face/speak)",
        "first_hand_over_ms",
        "first_hand_over_ms",
        None,
    ),
    (
        "unit_to_hand_over_ms",
        "First unit arrives → its hand-over to the face (FULL: pre-approved, no face/say)",
        "unit_to_hand_over_ms",
        "unit_to_hand_over_ms",
        None,
    ),
    (
        "first_hand_over_done_ms",
        "Turn sent → first hand-over relayed (LITE face/speak answered)",
        None,
        "first_hand_over_done_ms",
        None,
    ),
    (
        "unit_to_audio_ms",
        "Each unit: hand-over → first audio",
        "publish_to_audio_ms",
        "hand_over_to_audio_ms",
        None,
    ),
    (
        "unit_to_started_ms",
        "Each unit: hand-over → avatar.speak_started",
        "publish_to_started_ms",
        "hand_over_to_started_ms",
        None,
    ),
)
#: The instruments' self-test (a loopback data channel in the page): each must hold for the measurements to count.
INSTRUMENT_FLAGS = (
    "delivered",
    "sameLength",
    "injectedArrived",
    "admittedGone",
    "injectCleared",
    "livekit",
    # The level meters (the same onset rule on both arms of E5): a loopback WebRTC tone must give the remote-track
    # meter an onset, and a tone the page plays to its speakers must give the app-output meter one.
    "meter",
    "appMeter",
)

_REASON = re.compile(r"^[A-Z][A-Z_]{0,39}$")
_ERROR = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,59}$")
_HOST = re.compile(r"^[a-z0-9][a-z0-9.-]{0,120}$")
_GRANT = re.compile(r"^(granted|already|not_found|skipped \(mock\))$|^failed \(exit -?\d{1,3}\)$")
_TWIN = re.compile(r"^(ready|not_found|not_run)$|^failed \(exit -?\d{1,3}\)$")
_CREDITS = re.compile(r"^[+-]?\d{0,12}(\.\d{0,6})?$")


def take_key(environ: MutableMapping[str, str]) -> str:
    """Removes the vendor key from ``environ`` (this process's own environment) and returns it ('' when unset), so
    no child process but the local API can inherit it."""
    key = environ.pop(KEY_ENV, "").strip()
    # The API's own variable is set only on the API process, never inherited from the job.
    environ.pop(API_KEY_ENV, None)
    return key


def new_probe_token() -> str:
    return secrets.token_urlsafe(32)


def face_env(*, mock: bool, probe_token: str | None, mode: str = "full") -> dict[str, str]:
    """The local API's face configuration (no secret in it): the vendor's sandbox for admins, in FULL mode with the
    sandbox's stock avatar or in LITE mode (the persona's face reference, which the sandbox replaces with its own
    avatar), or the development stand-in in the dry run."""
    if mode not in ("full", "lite"):
        raise ValueError("mode must be full or lite")
    common = {"MEDIA_FACE_MODE": mode, "MEDIA_FACE_AUDIENCE": "admins"}
    if mock:
        return {**common, "EMBODIMENT_PROVIDER": "fake"}
    env = {
        **common,
        "MEDIA_FACE_PROVIDER": "heygen-liveavatar",
        "MEDIA_FACE_SANDBOX": "true",
        **({"MEDIA_FACE_AVATAR_ID": SANDBOX_AVATAR} if mode == "full" else {}),
    }
    if probe_token:
        env[PROBE_TOKEN_ENV] = probe_token
    return env


def with_face_mode(
    env: Mapping[str, str], *, mock: bool, probe_token: str | None, mode: str
) -> dict[str, str]:
    """``env`` with its face configuration replaced by :func:`face_env` in ``mode`` (nothing of the other mode left
    behind, such as FULL's stock avatar)."""
    kept = {k: v for k, v in env.items() if k not in _FACE_KEYS}
    return {**kept, **face_env(mock=mock, probe_token=probe_token, mode=mode)}


_FACE_KEYS = frozenset(
    {
        "MEDIA_FACE_MODE",
        "MEDIA_FACE_AUDIENCE",
        "MEDIA_FACE_PROVIDER",
        "MEDIA_FACE_SANDBOX",
        "MEDIA_FACE_AVATAR_ID",
        "EMBODIMENT_PROVIDER",
        PROBE_TOKEN_ENV,
    }
)


def api_process_env(env: Mapping[str, str], key: str) -> dict[str, str]:
    """The environment of the local API process only: ``env`` plus the vendor key."""
    return {**env, API_KEY_ENV: key} if key else dict(env)


def grant_admin(env: Mapping[str, str], log_dir: Path, *, pnpm: str) -> str:
    """Makes the seeded founder a platform admin in the lab's own database (apps/api lab-face-admin.ts, local
    Postgres only). Returns the outcome (granted, already, not_found, or failed)."""
    log_dir.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [pnpm, "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-face-admin.ts"],
        cwd=REPO,
        env=dict(env),
        capture_output=True,
        timeout=120,
        check=False,
    )
    (log_dir / "face-admin.log").write_bytes(done.stdout + done.stderr)
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        found = re.search(r" platform_admin=(granted|already|not_found)$", line)
        if line.startswith("lab-face-admin: ") and found:
            return found.group(1)
    return f"failed (exit {done.returncode})"


def seed_twin(env: Mapping[str, str], log_dir: Path, *, pnpm: str) -> str:
    """Gives the synthetic vEIR the seeded founder calls a face reference marked ready under likeness consent, in the
    lab's own database (apps/api lab-face-twin.ts, local Postgres only): what a LITE face needs, as in production.
    Returns the outcome (ready, not_found, or failed)."""
    log_dir.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [pnpm, "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-face-twin.ts"],
        cwd=REPO,
        env=dict(env),
        capture_output=True,
        timeout=120,
        check=False,
    )
    (log_dir / "face-twin.log").write_bytes(done.stdout + done.stderr)
    return parse_twin_line(done.stdout.decode("utf-8", "replace")) or f"failed (exit {done.returncode})"


def parse_twin_line(stdout: str) -> str | None:
    """The outcome lab-face-twin.ts printed (``ready`` or ``not_found``), or None."""
    for line in stdout.splitlines():
        found = re.fullmatch(r"lab-face-twin: personas=(\d{1,3}) face=(ready|not_found)", line.strip())
        if found:
            return found.group(2)
    return None


def read_audit_ids(private: Path) -> list[int]:
    """The ``call.face_injection`` audit ids the injection test saw (positive integers, in order, once each)."""
    raw = _load(private, "injection") or {}
    ids = raw.get("audit_ids")
    if not isinstance(ids, list):
        return []
    out: list[int] = []
    for value in ids:
        if isinstance(value, int) and not isinstance(value, bool) and value > 0 and value not in out:
            out.append(value)
    return out[:50]


def parse_audits_line(stdout: str) -> dict[str, int] | None:
    """The counts lab-face-audits.ts printed (``heartbeat``, ``at_end``, ``unknown``), or None."""
    for line in stdout.splitlines():
        found = re.fullmatch(
            r"lab-face-audits: heartbeat=(\d{1,6}) at_end=(\d{1,6}) unknown=(\d{1,6})", line.strip()
        )
        if found:
            return {"heartbeat": int(found[1]), "at_end": int(found[2]), "unknown": int(found[3])}
    return None


def injection_audits(
    env: Mapping[str, str], log_dir: Path, ids: Sequence[int], *, pnpm: str
) -> dict[str, int] | None:
    """Which of the injection test's audits came from a heartbeat check (``metadata.atEnd`` false) and which from
    the final check after the face had ended (apps/api lab-face-audits.ts, the lab's local database: the admin audit
    API returns no metadata). None when there are no ids or the script failed: E10 then cannot pass."""
    if not ids:
        return None
    log_dir.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(  # noqa: S603 - fixed argument list; the ids are integers
        [pnpm, "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-face-audits.ts", *map(str, ids)],
        cwd=REPO,
        env=dict(env),
        capture_output=True,
        timeout=120,
        check=False,
    )
    (log_dir / "face-audits.log").write_bytes(done.stdout + done.stderr)
    return parse_audits_line(done.stdout.decode("utf-8", "replace"))


class Probe:
    """The local API's lab probe (vendor credits and the calls it made), with the run's token."""

    def __init__(self, api_url: str, token: str, *, timeout: float = 20.0) -> None:
        self.api_url = api_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def _get(self, route: str) -> Any:
        request = urllib.request.Request(  # noqa: S310 - the local API only
            f"{self.api_url}/api/v1/_lab/face/{route}", headers={PROBE_HEADER: self._token}
        )
        with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310 - localhost
            return json.loads(response.read().decode("utf-8"))

    def credits(self) -> dict[str, Any]:
        try:
            return dict(self._get("credits"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            return {"error": type(exc).__name__}

    def vendor_calls(self) -> list[dict[str, Any]]:
        try:
            items = self._get("vendor-calls").get("items", [])
        except (urllib.error.URLError, TimeoutError, ValueError, OSError, AttributeError):
            return []
        return [i for i in items if isinstance(i, dict)]


# ---- public numbers -------------------------------------------------------------------------------------------


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if value == value else None  # NaN is not a number here


def _int(value: Any) -> int | None:
    number = _num(value)
    return None if number is None else round(number)


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _reason(value: Any) -> str | None:
    return value if isinstance(value, str) and _REASON.match(value) else None


def _error(value: Any) -> str | None:
    return value if isinstance(value, str) and _ERROR.match(value) else None


def _ints(values: Any) -> list[int]:
    return [v for v in (_int(x) for x in values) if v is not None] if isinstance(values, list) else []


def credits_left(read: Mapping[str, Any] | None) -> float | None:
    raw = (read or {}).get("creditsLeft")
    if not isinstance(raw, str) or not raw or not _CREDITS.match(raw):
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def summarize_vendor_calls(calls: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, dict[str, int]]]:
    """Per vendor path: how often each HTTP status and each envelope code came back (codes only)."""
    out: dict[str, dict[str, dict[str, int]]] = {}
    for call in calls:
        path = call.get("path")
        key = path if path in VENDOR_PATHS else "other"
        row = out.setdefault(key, {"status": {}, "code": {}})
        status = _int(call.get("status"))
        code = _int(call.get("code"))
        row["status"][str(status) if status is not None else "none"] = (
            row["status"].get(str(status) if status is not None else "none", 0) + 1
        )
        if code is not None:
            row["code"][str(code)] = row["code"].get(str(code), 0) + 1
    return dict(sorted(out.items()))


def success_codes(summary: Mapping[str, Mapping[str, Mapping[str, int]]]) -> list[int]:
    """The envelope codes the token and start calls answered with (the plan's E1: 100 or 1000)."""
    codes: set[int] = set()
    for path in ("/v1/sessions/token", "/v1/sessions/start"):
        for code in (summary.get(path) or {}).get("code", {}):
            if code.lstrip("-").isdigit():
                codes.add(int(code))
    return sorted(codes)


def percentile_ms(values: Sequence[int]) -> dict[str, int] | None:
    """Nearest-rank p50 and p95 (and n) of a list of milliseconds."""
    ordered = sorted(values)
    if not ordered:
        return None

    def rank(q: float) -> int:
        return ordered[max(0, math.ceil(q * len(ordered)) - 1)]

    return {"p50": rank(0.5), "p95": rank(0.95), "n": len(ordered)}


def _load(private: Path, name: str) -> dict[str, Any] | None:
    path = private / "face" / f"{name}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _room(room: Any) -> dict[str, Any] | None:
    if not isinstance(room, dict):
        return None
    return {
        "connected_ms": _int(room.get("connectedMs")),
        "first_video_ms": _int(room.get("firstVideoMs")),
        "can_publish_data": _bool(room.get("canPublishData")),
        "error": _error(room.get("error")),
    }


def _ended(cell: Any) -> dict[str, Any] | None:
    if not isinstance(cell, dict):
        return None
    out = {
        "stopped": _bool(cell.get("stopped")),
        "end_reason": _reason(cell.get("end_reason")),
        "seconds": _num(cell.get("seconds")),
    }
    if "requested_seconds" in cell:
        out["requested_seconds"] = _int(cell.get("requested_seconds"))
    return out


def public_instruments(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The page instruments' self-test: whether the tap read and rewrote a loopback packet, and livekit-client loaded."""
    if raw is None:
        return None
    out: dict[str, Any] = {flag: _bool(raw.get(flag)) for flag in INSTRUMENT_FLAGS}
    out["events_out"] = _int(raw.get("out"))
    out["events_in"] = _int(raw.get("in"))
    out["error"] = _error(raw.get("error"))
    out["ok"] = (
        all(out[flag] is True for flag in INSTRUMENT_FLAGS)
        and out["events_out"] == 1
        and out["events_in"] == 1
    )
    return out


def public_probe(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    exact = raw.get("exact") if isinstance(raw.get("exact"), dict) else {}
    queue = raw.get("queue") if isinstance(raw.get("queue"), dict) else {}
    transcript = raw.get("transcript_endpoint") if isinstance(raw.get("transcript_endpoint"), dict) else {}
    interrupt = raw.get("interrupt") if isinstance(raw.get("interrupt"), dict) else {}
    response = raw.get("speak_response") if isinstance(raw.get("speak_response"), dict) else {}
    behaviour = queue.get("behaviour")
    return {
        "full_room": _room(raw.get("full_room")),
        "full_room_b": _room(raw.get("full_room_b")),
        "lite_room": _room(raw.get("lite_room")),
        "exact": {
            "speak_started": _bool(exact.get("speak_started")),
            "speak_ended": _bool(exact.get("speak_ended")),
            "transcriptions": _int(exact.get("transcriptions")),
            "matches": _bool(exact.get("matches")),
            "publish_to_started_ms": _int(exact.get("publish_to_started_ms")),
            "publish_to_audio_ms": _int(exact.get("publish_to_audio_ms")),
            "publish_to_transcription_ms": _int(exact.get("publish_to_transcription_ms")),
        },
        "queue": {
            "behaviour": behaviour if behaviour in ("queued", "cut", "other") else None,
            "starts": _int(queue.get("starts")),
            "ends": _int(queue.get("ends")),
            "transcriptions": _int(queue.get("transcriptions")),
            "in_order": _bool(queue.get("in_order")),
            "gaps_ms": _ints(queue.get("gaps_ms")),
        },
        "transcript_endpoint": {
            "status": _int(transcript.get("status")),
            "ms": _int(transcript.get("ms")),
            "complete": _bool(transcript.get("complete")),
            "avatar_lines": _int(transcript.get("avatar_lines")),
            "user_lines": _int(transcript.get("user_lines")),
            "has_exact": _bool(transcript.get("has_exact")),
            "has_all_queue": _bool(transcript.get("has_all_queue")),
        },
        "interrupt": {
            "started_before": _bool(interrupt.get("started_before")),
            "to_speak_ended_ms": _int(interrupt.get("to_speak_ended_ms")),
            "to_silence_ms": _int(interrupt.get("to_silence_ms")),
            "queued_started_after": _int(interrupt.get("queued_started_after")),
            "queued_transcribed": _bool(interrupt.get("queued_transcribed")),
            "queue_cleared": _bool(interrupt.get("queue_cleared")),
        },
        "speak_response": {
            "speak_started": _int(response.get("speak_started")),
            "avatar_transcriptions": _int(response.get("avatar_transcriptions")),
            "ignored": _bool(response.get("ignored")),
        },
        "idle_end": _ended(raw.get("idle_end")),
        "max_duration": _ended(raw.get("max_duration")),
        "user_transcriptions": _int(raw.get("full_user_transcriptions")),
        "mic_requests": _int(raw.get("probe_mic_requests")),
        "audio_senders": _int(raw.get("probe_audio_senders")),
        "error": _error(raw.get("error")),
    }


def _turns(raw: Any) -> list[dict[str, int | None]]:
    if not isinstance(raw, list):
        return []
    return [
        {
            "first_speak_started_ms": _int(t.get("firstSpeakStartedMs")),
            "first_face_audio_ms": _int(t.get("firstFaceAudioMs")),
            "first_app_playback_ms": _int(t.get("firstAppPlaybackMs")),
            "first_app_audio_ms": _int(t.get("firstAppAudioMs")),
            # The first hand-over of the turn's words to the face: FULL's speak_text on the room, LITE's audio
            # POSTed to the server (and when the server answered it, having relayed it over the speak socket).
            "first_hand_over_ms": _int(t.get("firstHandOverMs")),
            "first_hand_over_done_ms": _int(t.get("firstHandOverDoneMs")),
            # The turn's first spoken unit reaching the page, and from there to that hand-over.
            "first_unit_ms": _int(t.get("firstUnitMs")),
            "unit_to_hand_over_ms": _int(t.get("unitToHandOverMs")),
        }
        for t in raw
        if isinstance(t, dict)
    ]


def _host(value: Any) -> str | None:
    if not isinstance(value, str) or not _HOST.match(value):
        return None
    return value if value.endswith(".livekit.cloud") else "other"


def public_call(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    session = raw.get("session") if isinstance(raw.get("session"), dict) else {}
    units = raw.get("units") if isinstance(raw.get("units"), dict) else {}
    fallback = raw.get("fallback") if isinstance(raw.get("fallback"), dict) else {}
    provider = session.get("provider")
    voicing = session.get("voicing")
    turns = _turns(raw.get("turns"))
    return {
        "session": {
            "provider": provider if provider in ("heygen", "fake", "builtin") else None,
            "voicing": voicing if voicing in ("text", "audio", "engine") else None,
            "stock_face": _bool(session.get("stockFace")),
            "livekit_host": _host(session.get("livekitHost")),
        },
        "label_visible": _bool(raw.get("label_visible")),
        "label_text_ok": _bool(raw.get("label_text_ok")),
        "turns": turns,
        # Two distributions, never mixed: the vendor's speak_started event, and the first sound the page's level
        # meter heard on the avatar's track (the one E5 compares, with Polly measured by the same meter).
        "first_speak_started_ms": percentile_ms(
            [t["first_speak_started_ms"] for t in turns if t["first_speak_started_ms"] is not None]
        ),
        "first_face_audio_ms": percentile_ms(
            [t["first_face_audio_ms"] for t in turns if t["first_face_audio_ms"] is not None]
        ),
        "publish_to_started_ms": percentile_ms(_ints(units.get("publishToStartedMs"))),
        "publish_to_audio_ms": percentile_ms(_ints(units.get("publishToAudioMs"))),
        "first_hand_over_ms": _turn_percentile(turns, "first_hand_over_ms"),
        "first_unit_ms": _turn_percentile(turns, "first_unit_ms"),
        "unit_to_hand_over_ms": _turn_percentile(turns, "unit_to_hand_over_ms"),
        "speak_text_sent": _int(raw.get("speak_text_sent")),
        "say_requests": _int(raw.get("say_requests")),
        "units_streamed": _int(raw.get("units_streamed")),
        "units_preapproved": _int(raw.get("units_preapproved")),
        "app_playbacks_after_live": _int(raw.get("app_playbacks_after_live")),
        "mic_requests_after_live": _int(raw.get("mic_requests_after_live")),
        "audio_senders": _int(raw.get("audio_senders")),
        "user_transcriptions": _int(raw.get("user_transcriptions")),
        "fallback": {
            "presence_back": _bool(fallback.get("presence_back")),
            "seconds_live": _num(fallback.get("seconds_live")),
            "session_stopped_event": _bool(fallback.get("session_stopped_event")),
            "end_reason": _reason(fallback.get("end_reason")),
            "typed_line_editable": _bool(fallback.get("typed_line_editable")),
        },
        "error": _error(raw.get("error")),
    }


def _turn_percentile(turns: Sequence[Mapping[str, int | None]], key: str) -> dict[str, int] | None:
    return percentile_ms([v for v in (t.get(key) for t in turns) if v is not None])


def public_call_lite(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The call arm with the face in LITE mode: the same turns and meters as :func:`public_call`. The LITE moments
    in place of FULL's speak_text: each unit's audio hand-over (``POST /calls/:id/face/speak``, its first part) and
    the server's answer once it relayed it over the speak socket; ``avatar.speak_started`` when the room carries it."""
    if raw is None:
        return None
    session = raw.get("session") if isinstance(raw.get("session"), dict) else {}
    units = raw.get("units") if isinstance(raw.get("units"), dict) else {}
    provider = session.get("provider")
    voicing = session.get("voicing")
    turns = _turns(raw.get("turns"))
    return {
        "session": {
            "provider": provider if provider in ("heygen", "fake", "builtin") else None,
            "voicing": voicing if voicing in ("text", "audio", "engine") else None,
            "stock_face": _bool(session.get("stockFace")),
            "livekit_host": _host(session.get("livekitHost")),
        },
        "face_shown": _bool(raw.get("face_shown")),
        "turns": turns,
        "first_face_audio_ms": _turn_percentile(turns, "first_face_audio_ms"),
        "first_speak_started_ms": _turn_percentile(turns, "first_speak_started_ms"),
        "first_hand_over_ms": _turn_percentile(turns, "first_hand_over_ms"),
        "first_hand_over_done_ms": _turn_percentile(turns, "first_hand_over_done_ms"),
        "first_unit_ms": _turn_percentile(turns, "first_unit_ms"),
        "unit_to_hand_over_ms": _turn_percentile(turns, "unit_to_hand_over_ms"),
        "hand_over_to_audio_ms": percentile_ms(_ints(units.get("handOverToAudioMs"))),
        "hand_over_to_started_ms": percentile_ms(_ints(units.get("handOverToStartedMs"))),
        "hand_over_to_done_ms": percentile_ms(_ints(units.get("handOverToDoneMs"))),
        "speak_requests": _int(raw.get("speak_requests")),
        "speak_accepted": _int(raw.get("speak_accepted")),
        "speak_text_sent": _int(raw.get("speak_text_sent")),
        "app_playbacks_after_live": _int(raw.get("app_playbacks_after_live")),
        "mic_requests_after_live": _int(raw.get("mic_requests_after_live")),
        "audio_senders": _int(raw.get("audio_senders")),
        "error": _error(raw.get("error")),
    }


def comparison(result: Mapping[str, Any]) -> dict[str, Any]:
    """The in-app arms side by side (:data:`COMPARISON_ROWS`): FULL, LITE and Polly alone, each a {p50, p95, n} cell
    or None, with which face arm reached first audio sooner at p50 and by how much (LITE minus FULL; negative: LITE
    is faster)."""
    arms = {
        "full": result.get("call") or {},
        "lite": result.get("call_lite") or {},
        "polly": result.get("polly") or {},
    }
    rows: list[dict[str, Any]] = []
    for key, title, full_key, lite_key, polly_key in COMPARISON_ROWS:
        cells = {}
        for arm, field in (("full", full_key), ("lite", lite_key), ("polly", polly_key)):
            cell = arms[arm].get(field) if field else None
            cells[arm] = cell if isinstance(cell, dict) else None
        rows.append({"key": key, "title": title, **cells})
    first = rows[0]
    full_p50 = (first["full"] or {}).get("p50")
    lite_p50 = (first["lite"] or {}).get("p50")
    polly_p50 = (first["polly"] or {}).get("p50")
    delta = None if full_p50 is None or lite_p50 is None else lite_p50 - full_p50
    return {
        "rows": rows,
        "lite_minus_full_first_audio_p50_ms": delta,
        "faster_first_audio": None
        if delta is None
        else ("lite" if delta < 0 else "full" if delta > 0 else "same"),
        "full_minus_polly_first_audio_p50_ms": (
            None if full_p50 is None or polly_p50 is None else full_p50 - polly_p50
        ),
        "lite_minus_polly_first_audio_p50_ms": (
            None if lite_p50 is None or polly_p50 is None else lite_p50 - polly_p50
        ),
    }


def public_injection(
    raw: Mapping[str, Any] | None, audits: Mapping[str, Any] | None = None
) -> dict[str, Any] | None:
    """The injection test's numbers, with its audits split by where the server's check ran (``audits``, from
    :func:`injection_audits`): a heartbeat (the face still live) or the final check after the face had ended."""
    if raw is None:
        return None
    audits = audits or {}
    return {
        "injected": _bool(raw.get("injected")),
        "face_ended": _bool(raw.get("face_ended")),
        "seconds_to_end": _num(raw.get("seconds_to_end")),
        "seconds_into_session": _num(raw.get("seconds_into_session")),
        "heartbeat_seconds": _int(raw.get("heartbeat_seconds")),
        "audit_injection_events": _int(raw.get("audit_injection_events")),
        "audit_heartbeat_events": _int(audits.get("heartbeat")),
        "audit_at_end_events": _int(audits.get("at_end")),
        "audit_unknown_events": _int(audits.get("unknown")),
        "end_reason": _reason(raw.get("end_reason")),
        "error": _error(raw.get("error")),
    }


def public_polly(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    turns = _turns(raw.get("turns"))
    return {
        "turns": turns,
        # The first sound on the app's output, by the same level meter as the face's track (E5's Polly arm).
        "first_audio_ms": percentile_ms(
            [t["first_app_audio_ms"] for t in turns if t["first_app_audio_ms"] is not None]
        ),
        # When the app scheduled its first Polly buffer (AudioBufferSourceNode.start): before any sound.
        "first_scheduled_ms": percentile_ms(
            [t["first_app_playback_ms"] for t in turns if t["first_app_playback_ms"] is not None]
        ),
        "first_unit_ms": _turn_percentile(turns, "first_unit_ms"),
        "error": _error(raw.get("error")),
    }


def checks(result: Mapping[str, Any]) -> dict[str, bool | None]:
    """The plan's sandbox checks as pass (True), fail (False) or not measured (None)."""
    instruments = result.get("instruments")
    probe = result.get("probe") or {}
    call = result.get("call") or {}
    injection = result.get("injection") or {}
    credits = result.get("credits") or {}
    codes = result.get("success_codes") or []
    exact = probe.get("exact") or {}
    queue = probe.get("queue") or {}
    interrupt = probe.get("interrupt") or {}
    transcript = probe.get("transcript_endpoint") or {}
    max_duration = probe.get("max_duration") or {}
    idle = probe.get("idle_end") or {}
    fallback = call.get("fallback") or {}
    first = call.get("first_face_audio_ms") or {}
    hand_over = call.get("unit_to_hand_over_ms") or {}
    full_room = probe.get("full_room") or {}
    lite_room = probe.get("lite_room") or {}

    def present(value: Any) -> bool:
        return value is not None

    seconds = injection.get("seconds_to_end")
    requested = max_duration.get("requested_seconds")
    stopped_after = max_duration.get("seconds")
    return {
        "instruments_ok": instruments.get("ok") if isinstance(instruments, dict) else None,
        "e1_success_code_recorded": bool(codes) and all(c in (100, 1000) for c in codes) if codes else None,
        "e1_livekit_host_expected": (
            call.get("session", {}).get("livekit_host") in EXPECTED_LIVEKIT_HOSTS
            if present((call.get("session") or {}).get("livekit_host"))
            else None
        ),
        "e2_no_credits_used": credits.get("used") == 0 if present(credits.get("used")) else None,
        "e3_speak_text_exact": exact.get("matches"),
        "e4_queue_measured": (
            queue.get("behaviour") in ("queued", "cut") if present(queue.get("behaviour")) else None
        ),
        "e5_first_audio_under_target": (
            first.get("p50") is not None and first["p50"] <= FIRST_AUDIO_TARGET_MS if first else None
        ),
        # Face pre-approval: the page hands each turn's first unit to the face as it arrives (no face/say first).
        "e5_hand_over_at_unit_arrival": (
            hand_over.get("p50") is not None and hand_over["p50"] <= HAND_OVER_AFTER_UNIT_TARGET_MS
            if hand_over
            else None
        ),
        "e6_interrupt_clears_queue": interrupt.get("queue_cleared"),
        "e7_no_microphone": (
            call.get("mic_requests_after_live") == 0 and call.get("audio_senders") == 0
            if present(call.get("mic_requests_after_live"))
            else None
        ),
        "e7_no_user_transcription": (
            (call.get("user_transcriptions") or 0) == 0 and (probe.get("user_transcriptions") or 0) == 0
            if present(call.get("user_transcriptions")) or present(probe.get("user_transcriptions"))
            else None
        ),
        "e8_speak_response_ignored": (probe.get("speak_response") or {}).get("ignored"),
        "e9_full_token_publishes": full_room.get("can_publish_data"),
        "e9_lite_token_cannot_publish": (
            lite_room.get("can_publish_data") is False if present(lite_room.get("can_publish_data")) else None
        ),
        "e10_transcript_endpoint_live": (
            transcript.get("status") == 200 and bool(transcript.get("has_exact"))
            if present(transcript.get("status"))
            else None
        ),
        # The heartbeat must be what caught it: an audit whose check ran while the face was live (atEnd false),
        # and not a session the vendor ended at its maximum (whose final check writes the same audit, atEnd true).
        "e10_injection_ends_face_in_a_heartbeat": (
            bool(injection.get("face_ended"))
            and (injection.get("audit_heartbeat_events") or 0) >= 1
            and injection.get("end_reason") != "MAX_DURATION_REACHED"
            and seconds is not None
            and seconds <= HEARTBEAT_SECONDS + 5
            if present(injection.get("injected"))
            else None
        ),
        "e11_idle_end_recorded": present(idle.get("end_reason")) if idle else None,
        "e11_max_duration_enforced": (
            max_duration.get("end_reason") == "MAX_DURATION_REACHED"
            and stopped_after is not None
            and requested is not None
            and stopped_after <= requested + 10
            if max_duration.get("stopped")
            else (False if max_duration else None)
        ),
        "label_ai_avatar_visible": call.get("label_visible"),
        "falls_back_to_presence": fallback.get("presence_back"),
    }


def public_credits(
    read_before: Mapping[str, Any] | None, read_after: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Credits left before and after (as read through the probe), the difference, and the first read's codes."""
    before, after = credits_left(read_before), credits_left(read_after)
    return {
        "before": before,
        "after": after,
        "used": None if before is None or after is None else round(before - after, 4),
        "status": _int((read_before or {}).get("status")),
        "code": _int((read_before or {}).get("code")),
    }


def public_pass_vendor(
    read_before: Mapping[str, Any] | None,
    read_after: Mapping[str, Any] | None,
    vendor_calls: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """One later pass's own vendor numbers (the LITE pass after FULL): credits across it, the calls its API process
    made and the token and start codes. Reported only: the checks grade the first pass."""
    calls = summarize_vendor_calls(vendor_calls)
    return {
        "credits": public_credits(read_before, read_after),
        "vendor_calls": calls,
        "success_codes": success_codes(calls),
    }


def public_result(
    private: Path,
    *,
    playwright_exit: int,
    credits_before: Mapping[str, Any] | None,
    credits_after: Mapping[str, Any] | None,
    vendor_calls: Sequence[Mapping[str, Any]],
    vendor: str,
    admin_grant: str,
    injection_audits: Mapping[str, Any] | None = None,
    face_mode: str = "full",
    twin: str = "not_run",
    lite_vendor_calls: Sequence[Mapping[str, Any]] | None = None,
    lite_credits_after: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The suite's public result: numbers, codes, booleans and vendor end reasons only. ``injection_audits`` is
    :func:`injection_audits` for the ids the injection test saw (None: not looked up, so E10 cannot pass).
    ``face_mode`` is the run's choice (full, lite, both) and ``twin`` the LITE face reference's outcome
    (:func:`seed_twin`; ``not_run`` without a LITE pass). The checks grade the FULL arm only, as before; the LITE
    arm is reported beside it (:func:`public_call_lite`, :func:`comparison`).

    ``credits_after`` and ``vendor_calls`` are the first pass's alone (the one that runs every test), so E1 and E2
    grade it whatever a later pass does. ``lite_vendor_calls`` and ``lite_credits_after`` are the separate LITE
    pass's (its own API process; None without one), reported as ``call_lite_vendor``: its credits from the end of
    the first pass to its own end, its vendor calls and its success codes, which no check reads."""
    calls = summarize_vendor_calls(vendor_calls)
    result: dict[str, Any] = {
        "vendor": vendor if vendor in ("heygen-sandbox", "stand-in") else None,
        "face_mode": face_mode if face_mode in ("full", "lite", "both") else None,
        "admin_grant": admin_grant if _GRANT.match(admin_grant) else None,
        "lite_face_reference": twin if _TWIN.match(twin) else None,
        "playwright_exit": playwright_exit,
        "credits": public_credits(credits_before, credits_after),
        "vendor_calls": calls,
        "success_codes": success_codes(calls),
        "call_lite_vendor": (
            None
            if lite_vendor_calls is None
            else public_pass_vendor(credits_after, lite_credits_after, lite_vendor_calls)
        ),
        "instruments": public_instruments(_load(private, "instruments")),
        "probe": public_probe(_load(private, "probe")),
        "call": public_call(_load(private, "call")),
        "injection": public_injection(_load(private, "injection"), injection_audits),
        "polly": public_polly(_load(private, "polly")),
        "call_lite": public_call_lite(_load(private, "call-lite")),
    }
    result["comparison"] = comparison(result)
    graded = checks(result)
    result["checks"] = graded
    result["passed"] = sum(1 for v in graded.values() if v is True)
    result["run"] = sum(1 for v in graded.values() if v is not None)
    return result
