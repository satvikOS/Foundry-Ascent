"""The face suite's ``lite-probe`` arm (``--face-mode lite-probe``): raw HeyGen LiveAvatar LITE sessions in the vendor's
free SANDBOX, whose ``ws_url`` the lab's own page drives with synthetic speech (apps/web/e2e/lab/lite-probe.lab.ts),
for the probes L1-L10 of the LITE + ElevenLabs design. No app behaviour is measured or changed.

The spec writes, to the private folder (sealed), each session's frames (types, states, and which of the lab's own ids
a source names, as labels such as ``U1``, ``U1.c2``, ``U1.end`` or ``I1``: never an id), what it sent and when, the
avatar's audio onsets and offsets (the face suite's level meter), video motion samples, room data event types, the
token and start responses' field names and types, and ``ws_url``'s host, path shape and query key names (never the
URL). :func:`public_lite_probe` turns that into public numbers, codes, field and event type names, a host with any
id-like label masked, and the design's hypotheses (:data:`HYPOTHESES`) as confirmed (True), refuted (False) or not
measured (None).

Standard library only, as the rest of the face suite's reduction.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

#: The fields the vendor documents for ``POST /v1/sessions/start`` (openapi ``StartSessionResponseSchema``).
DOCUMENTED_START_FIELDS: tuple[str, ...] = (
    "session_id",
    "livekit_url",
    "livekit_client_token",
    "livekit_agent_token",
    "max_session_duration",
    "ws_url",
)
#: Vendor domains a ``ws_url`` host is expected under (reported, never required).
VENDOR_DOMAINS: tuple[str, ...] = ("liveavatar.com", "heygen.com", "heygen.ai", "heygen.io", "livekit.cloud")
#: Sessions whose ``ws_url`` host must agree before one exact CSP origin is called confirmed: never one session.
MIN_SESSIONS_FOR_HOST = 3
#: The design's targets (lite-elevenlabs-design §6).
FIRST_CHUNK_TO_STARTED_TARGET_MS = 600
QUEUE_GAP_TARGET_MS = 150
CLEARED_TARGET_MS = 500
#: An utterance "played out" when the avatar's track carried at least this share of its length.
PLAYED_OUT_SHARE = 0.8
#: How long after a send the avatar's first sound still counts as that send's.
ONSET_WINDOW_MS = 5000
#: Video motion: a window "moves" when its mean frame difference is this many times the idle baseline's.
MOTION_RATIO = 1.2

#: The design's hypotheses, in probe order: (key, statement).
HYPOTHESES: tuple[tuple[str, str], ...] = (
    (
        "l1_start_fields_as_documented",
        "L1: LITE start returns session_id, livekit_url, livekit_client_token, livekit_agent_token, "
        "max_session_duration and ws_url",
    ),
    (
        "l1_ws_url_one_exact_origin",
        f"L1: ws_url has one exact host in every session (at least {MIN_SESSIONS_FOR_HOST}): one CSP origin",
    ),
    (
        "l2_connected_once_text_frames",
        "L2: session.state_updated connected comes once per socket, as text JSON",
    ),
    (
        "l3_appended_per_chunk_by_utterance_id",
        "L3: one agent.audio_buffer_appended per agent.speak chunk, source = the utterance id",
    ),
    (
        "l3_committed_once_by_utterance_id",
        "L3: one agent.audio_buffer_committed per speak_end, source = the utterance id",
    ),
    (
        "l4_speak_events_on_socket",
        "L4: agent.speak_started and agent.speak_ended for each utterance on the socket, source = the utterance id",
    ),
    (
        "l4_first_chunk_to_started_target",
        f"L4: first chunk sent -> speak_started p50 <= {FIRST_CHUNK_TO_STARTED_TARGET_MS} ms",
    ),
    ("l4_sound_on_avatar_track", "L4: the avatar's returned audio track carries each utterance's sound"),
    ("l4_no_speak_events_in_room", "L4: LITE speak events go to the socket holder only (none in the room)"),
    ("l5_utterances_queue", "L5: a second utterance queues behind the first (no cut, no overlap)"),
    ("l5_queue_gap_target", f"L5: speak_ended -> the next speak_started <= {QUEUE_GAP_TARGET_MS} ms"),
    ("l6_new_socket_replaces_old", "L6: opening a second socket closes the first"),
    (
        "l6_open_utterance_survives_replacement",
        "L6: an open utterance survives the replacement and plays out",
    ),
    ("l6_ws_url_reopens_after_close", "L6: ws_url can be opened again after a close"),
    (
        "l7_committed_audio_survives_close",
        "L7: closing right after speak_end does not drop the buffered audio",
    ),
    (
        "l8_interrupt_events_as_documented",
        "L8: agent.interrupt -> speak_interrupted (utterance id) and audio_buffer_cleared (the interrupt's id), "
        "no speak_ended",
    ),
    ("l8_cleared_target", f"L8: agent.interrupt -> audio_buffer_cleared <= {CLEARED_TARGET_MS} ms"),
    ("l9_room_data_ignored", "L9: LITE ignores agent.speak / avatar.speak_text data the viewer publishes"),
    (
        "l9_room_audio_track_ignored",
        "L9: LITE ignores an audio track published into the room (no sound, no speak events, no lip-sync)",
    ),
    (
        "l10_browser_production_origin_accepted",
        "L10: ws_url accepts a browser socket with the production Origin",
    ),
)

_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,63}$")
_FIELD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_JSON_TYPES = frozenset({"string", "number", "boolean", "null", "array", "object"})
_LABEL = re.compile(r"^(?:U\d{1,2}(?:\.c\d{1,3}|\.end)?|I\d{1,2}|other)$")
_SOCKET = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_HOST = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z0-9-]{1,62}$")
_PATH = re.compile(r"^[A-Za-z0-9_.{}/-]{0,200}$")
_QUERY_KEY = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
_ERROR = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,59}$")
_ORIGIN_ATTEMPTS = (
    "browser-local-origin",
    "browser-local-after",
    "browser-production-origin",
    "node-no-origin",
    "node-production-origin",
    "node-foreign-origin",
)


# ---- validation of the private record ------------------------------------------------------------------------


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _int(value: Any) -> int | None:
    number = _num(value)
    return None if number is None else round(number)


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _match(value: Any, pattern: re.Pattern[str]) -> str | None:
    return value if isinstance(value, str) and pattern.match(value) else None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def percentile_ms(values: Iterable[float | int | None]) -> dict[str, int] | None:
    """Nearest-rank p50 and p95 (and n) of milliseconds; None values are left out."""
    ordered = sorted(round(v) for v in values if v is not None)
    if not ordered:
        return None

    def rank(q: float) -> int:
        return ordered[max(0, math.ceil(q * len(ordered)) - 1)]

    return {"p50": rank(0.5), "p95": rank(0.95), "n": len(ordered)}


def _ms(start: float | None, end: float | None) -> int | None:
    return None if start is None or end is None else round(end - start)


def field_shape(raw: Any) -> dict[str, str]:
    """A response's field names and JSON types, as the probe reported them (anything else left out)."""
    out: dict[str, str] = {}
    for name, kind in _dict(raw).items():
        if _FIELD.match(str(name)) and kind in _JSON_TYPES:
            out[str(name)] = str(kind)
    return dict(sorted(out.items()))


def frames_of(lab: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The socket frames the page recorded, validated, in time order."""
    out: list[dict[str, Any]] = []
    for raw in _list(lab.get("frames")):
        frame = _dict(raw)
        at = _num(frame.get("at"))
        socket = _match(frame.get("socket"), _SOCKET)
        if at is None or socket is None:
            continue
        refs = [r for r in _list(frame.get("refs")) if isinstance(r, str) and _LABEL.match(r)]
        out.append(
            {
                "at": at,
                "socket": socket,
                "binary": frame.get("binary") is True,
                "type": _match(frame.get("type"), _TYPE),
                "state": _match(frame.get("state"), _TYPE),
                "new_state": _match(frame.get("newState"), _TYPE),
                "source": _match(frame.get("source"), _LABEL),
                "refs": refs,
                "has_event_id": frame.get("hasEventId") is True,
                "error_type": _match(frame.get("errorType"), _TYPE),
                "warning_type": _match(frame.get("warningType"), _TYPE),
            }
        )
    return sorted(out, key=lambda f: f["at"])


def sockets_of(lab: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for raw in _list(lab.get("sockets")):
        record = _dict(raw)
        label = _match(record.get("label"), _SOCKET)
        created = _num(record.get("created"))
        if label is None or created is None:
            continue
        out[label] = {
            "where": _match(record.get("where"), _SOCKET),
            "created": created,
            "open": _num(record.get("open")),
            "connected": _num(record.get("connected")),
            "closed": _num(record.get("closed")),
            "close_code": _int(record.get("closeCode")),
            "error": _num(record.get("error")),
        }
    return out


def utterances_of(lab: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for label, raw in _dict(lab.get("utterances")).items():
        if not isinstance(label, str) or not re.fullmatch(r"U\d{1,2}", label):
            continue
        record = _dict(raw)
        out[label] = {
            "socket": _match(record.get("socket"), _SOCKET),
            "audio_ms": _int(record.get("audioMs")),
            "first_chunk_ms": _int(record.get("firstChunkMs")),
            "chunks": _int(record.get("chunks")),
            "ids": record.get("ids") if record.get("ids") in ("same", "distinct") else None,
            "end": record.get("end") is True,
            "close_after_end": record.get("closeAfterEnd") is True,
        }
    return out


def times(values: Any) -> list[float]:
    return sorted(v for v in (_num(x) for x in _list(values)) if v is not None)


def first_frame(
    frames: Sequence[Mapping[str, Any]],
    type_: str,
    *,
    source: str | None = None,
    after: float | None = None,
    socket: str | None = None,
) -> Mapping[str, Any] | None:
    for frame in frames:
        if frame["type"] != type_:
            continue
        if source is not None and frame["source"] != source:
            continue
        if after is not None and frame["at"] < after:
            continue
        if socket is not None and frame["socket"] != socket:
            continue
        return frame
    return None


def source_class(source: str | None, utterance: str, interrupt: str | None = None) -> str:
    """Which id a frame's source named, relative to ``utterance``: the utterance id, a later chunk's own id, the
    speak_end's own id, the interrupt's id, another of the lab's ids or the vendor's, or none."""
    if source is None:
        return "none"
    if source == utterance:
        return "utterance"
    if source.startswith(f"{utterance}.c"):
        return "chunk"
    if source == f"{utterance}.end":
        return "end"
    if interrupt is not None and source == interrupt:
        return "interrupt"
    return "other"


def _belongs(source: str | None, utterance: str) -> bool:
    return source is not None and (source == utterance or source.startswith(f"{utterance}."))


def track_audio(
    onsets: Sequence[float],
    offsets: Sequence[float],
    sent_at: float | None,
    *,
    window_ms: int = ONSET_WINDOW_MS,
) -> tuple[int | None, int | None]:
    """(send -> first sound on the avatar's track, that sound's length) for a send at ``sent_at``: the first onset
    within ``window_ms`` of it, and the first offset after that onset (None while it never ended)."""
    if sent_at is None:
        return None, None
    onset = next((t for t in onsets if sent_at <= t <= sent_at + window_ms), None)
    if onset is None:
        return None, None
    offset = next((t for t in offsets if t > onset), None)
    return round(onset - sent_at), (None if offset is None else round(offset - onset))


def _count_in(values: Sequence[float], start: float | None, end: float | None) -> int | None:
    if start is None or end is None:
        return None
    return sum(1 for t in values if start <= t <= end)


def _mean_motion(
    samples: Sequence[tuple[float, float]], start: float | None, end: float | None
) -> float | None:
    if start is None or end is None or end <= start:
        return None
    values = [d for at, d in samples if start <= at < end]
    return None if not values else round(sum(values) / len(values), 3)


def heard(lab: Mapping[str, Any]) -> bool:
    """Whether the page had the avatar's audio track to listen to: without one, no sound measure counts."""
    return (_int(lab.get("audioTracks")) or 0) > 0


def _room_connected(session: Mapping[str, Any]) -> bool:
    return _int(_dict(session.get("room")).get("connectedMs")) is not None


def _session(raw: Mapping[str, Any], name: str) -> dict[str, Any] | None:
    for item in raw.get("sessions") or []:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def _marks(session: Mapping[str, Any]) -> dict[str, float | None]:
    return {str(k): _num(v) for k, v in _dict(session.get("marks")).items() if isinstance(k, str)}


# ---- L1 / L2 -------------------------------------------------------------------------------------------------


def mask_host(host: str) -> str:
    """A host with every id-like label (a digit and 8+ characters, 20+ characters, or 12+ hex) as ``*``."""
    labels = host.split(".")
    masked = [
        "*"
        if (len(label) >= 8 and any(c.isdigit() for c in label))
        or len(label) >= 20
        or re.fullmatch(r"[0-9a-f-]{12,}", label)
        else label
        for label in labels
    ]
    return ".".join(masked)


def public_l1(sessions: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    started = [s for s in sessions if _int(s.get("status")) == 201]
    token_fields: list[dict[str, str]] = []
    start_fields: list[dict[str, str]] = []
    token_ms: list[int | None] = []
    start_ms: list[int | None] = []
    token_status: set[int] = set()
    token_codes: set[int] = set()
    start_status: set[int] = set()
    start_codes: set[int] = set()
    durations: set[int] = set()
    for session in sessions:
        shape = _dict(session.get("shape"))
        token = _dict(shape.get("token"))
        start = _dict(shape.get("start"))
        for cell, statuses, codes, fields, spent in (
            (token, token_status, token_codes, token_fields, token_ms),
            (start, start_status, start_codes, start_fields, start_ms),
        ):
            if not cell:
                continue
            if (status := _int(cell.get("status"))) is not None:
                statuses.add(status)
            if (code := _int(cell.get("code"))) is not None:
                codes.add(code)
            fields.append(field_shape(cell.get("fields")))
            spent.append(_int(cell.get("ms")))
        if (duration := _int(start.get("maxSessionDuration"))) is not None:
            durations.add(duration)
    union: dict[str, str] = {}
    for fields in start_fields:
        for name, kind in fields.items():
            union[name] = kind if union.get(name, kind) == kind else "mixed"
    missing = sorted(
        {name for fields in start_fields if fields for name in DOCUMENTED_START_FIELDS if name not in fields}
    )
    hosts_raw: list[str] = []
    schemes: set[str] = set()
    ports: set[str] = set()
    paths: set[str] = set()
    query_keys: set[str] = set()
    for session in started:
        control = _dict(session.get("control"))
        host = control.get("host")
        if isinstance(host, str) and _HOST.match(host):
            hosts_raw.append(host)
        if isinstance(scheme := control.get("scheme"), str) and scheme in ("ws", "wss"):
            schemes.add(scheme)
        if isinstance(port := control.get("port"), str) and port.isdigit() and len(port) <= 5:
            ports.add(port)
        if isinstance(path := control.get("pathShape"), str) and _PATH.match(path):
            paths.add(path)
        for key in _list(control.get("queryKeys")):
            if isinstance(key, str) and _QUERY_KEY.match(key):
                query_keys.add(key)
    masked = list(dict.fromkeys(mask_host(h) for h in hosts_raw))
    same = None if len(hosts_raw) < 2 else len(set(hosts_raw)) == 1
    return {
        "sessions_requested": len(sessions),
        "sessions_started": len(started),
        "token": {
            "status": sorted(token_status),
            "codes": sorted(token_codes),
            "fields": token_fields[0] if token_fields else {},
            "fields_consistent": (len({tuple(f.items()) for f in token_fields}) == 1)
            if token_fields
            else None,
            "ms": percentile_ms(token_ms),
        },
        "start": {
            "status": sorted(start_status),
            "codes": sorted(start_codes),
            "fields": dict(sorted(union.items())),
            "fields_consistent": (len({tuple(f.items()) for f in start_fields}) == 1)
            if start_fields
            else None,
            "documented_missing": missing,
            "undocumented": sorted(n for n in union if n not in DOCUMENTED_START_FIELDS),
            "max_session_duration": sorted(durations),
            "ms": percentile_ms(start_ms),
        },
        "ws_url": {
            "sessions_with_host": len(hosts_raw),
            # Id-like labels masked: a host that differs per session must never be copied into a CSP from one run.
            "hosts": masked,
            "host_has_id_label": any(mask_host(h) != h for h in hosts_raw) if hosts_raw else None,
            "same_host_all_sessions": same,
            "vendor_domain": (
                all(any(h == d or h.endswith(f".{d}") for d in VENDOR_DOMAINS) for h in hosts_raw)
                if hosts_raw
                else None
            ),
            "schemes": sorted(schemes),
            "ports": sorted(ports),
            "path_shapes": sorted(paths),
            "query_keys": sorted(query_keys),
        },
    }


def public_l2(sessions: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    open_ms: list[int | None] = []
    to_connected: list[int | None] = []
    created_to_connected: list[int | None] = []
    connected_counts: list[int] = []
    first_types: Counter[str] = Counter()
    states: set[str] = set()
    event_types: Counter[str] = Counter()
    text = binary = untyped = 0
    for session in sessions:
        lab = _dict(session.get("lab"))
        frames = frames_of(lab)
        for label, record in sockets_of(lab).items():
            if record["where"] != "page-local":
                continue
            open_ms.append(_ms(record["created"], record["open"]))
            to_connected.append(_ms(record["open"], record["connected"]))
            created_to_connected.append(_ms(record["created"], record["connected"]))
            own = [f for f in frames if f["socket"] == label]
            if record["connected"] is not None:
                connected_counts.append(
                    sum(1 for f in own if f["type"] == "session.state_updated" and f["state"] == "connected")
                )
            if own:
                first_types[own[0]["type"] or ("binary" if own[0]["binary"] else "untyped")] += 1
        for frame in frames:
            if frame["binary"]:
                binary += 1
                continue
            text += 1
            if frame["type"] is None:
                untyped += 1
            else:
                event_types[frame["type"]] += 1
            if frame["type"] == "session.state_updated" and frame["state"] is not None:
                states.add(frame["state"])
    return {
        "open_ms": percentile_ms(open_ms),
        "open_to_connected_ms": percentile_ms(to_connected),
        "created_to_connected_ms": percentile_ms(created_to_connected),
        "sockets_connected": len(connected_counts),
        "connected_events_per_socket": sorted(set(connected_counts)),
        "first_frame_types": dict(sorted(first_types.items())),
        "session_states": sorted(states),
        "text_frames": text,
        "binary_frames": binary,
        "untyped_frames": untyped,
        "event_types": dict(sorted(event_types.items())),
    }


# ---- L3 / L4 / L5 / L8 (session one) -------------------------------------------------------------------------


def _first_send(lab: Mapping[str, Any], label: str, type_: str = "agent.speak") -> float | None:
    for raw in _list(lab.get("sent")):
        sent = _dict(raw)
        if sent.get("label") == label and sent.get("type") == type_:
            return _num(sent.get("at"))
    return None


def utterance_row(
    lab: Mapping[str, Any], frames: Sequence[Mapping[str, Any]], label: str, utterance: Mapping[str, Any]
) -> dict[str, Any]:
    """One utterance's acknowledgements, speak events and sound on the avatar's track."""
    first = _first_send(lab, label)
    end = _first_send(lab, label, "agent.speak_end")
    appended = [
        f for f in frames if f["type"] == "agent.audio_buffer_appended" and _belongs(f["source"], label)
    ]
    committed = [
        f for f in frames if f["type"] == "agent.audio_buffer_committed" and _belongs(f["source"], label)
    ]
    started = first_frame(frames, "agent.speak_started", source=label)
    ended = first_frame(frames, "agent.speak_ended", source=label)
    interrupted = first_frame(frames, "agent.speak_interrupted", source=label)
    to_audio, audio_len = track_audio(times(lab.get("onsets")), times(lab.get("offsets")), first)
    started_any = first_frame(frames, "agent.speak_started", after=first) if first is not None else None
    return {
        "label": label,
        "ids": utterance.get("ids"),
        "end": utterance.get("end"),
        "chunks": utterance.get("chunks"),
        "audio_ms": utterance.get("audio_ms"),
        "first_chunk_ms": utterance.get("first_chunk_ms"),
        "appended": len(appended),
        "appended_sources": sorted({source_class(f["source"], label) for f in appended}),
        "committed": len(committed),
        "committed_sources": sorted({source_class(f["source"], label) for f in committed}),
        "first_chunk_to_appended_ms": _ms(first, appended[0]["at"] if appended else None),
        "end_to_committed_ms": _ms(end, committed[0]["at"] if committed else None),
        "speak_started": started is not None,
        "speak_ended": ended is not None,
        "speak_interrupted": interrupted is not None,
        # A speak_started after the send that names another id (or none): the vendor's own naming.
        "started_source_if_not_ours": (
            None if started is not None or started_any is None else source_class(started_any["source"], label)
        ),
        "to_started_ms": _ms(first, started["at"] if started else None),
        "to_ended_ms": _ms(first, ended["at"] if ended else None),
        "to_audio_ms": to_audio,
        "track_audio_ms": audio_len,
        "started_to_audio_ms": (
            None
            if started is None or to_audio is None or first is None
            else round(first + to_audio - started["at"])
        ),
    }


def _unattributed(frames: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Acknowledgements and speak events whose source names none of the lab's ids (or none at all), by type."""
    counts: Counter[str] = Counter()
    for frame in frames:
        type_ = frame["type"] or ""
        if type_.startswith(("agent.audio_buffer_", "agent.speak_")) and frame["source"] in (
            None,
            "other",
        ):
            counts[type_] += 1
    return dict(sorted(counts.items()))


def public_s1(session: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if session is None:
        return None
    lab = _dict(session.get("lab"))
    frames = frames_of(lab)
    utterances = utterances_of(lab)
    marks = _marks(session)
    can_hear = heard(lab)
    onsets, offsets = times(lab.get("onsets")), times(lab.get("offsets"))
    rows = {label: utterance_row(lab, frames, label, u) for label, u in utterances.items()}
    sealed = [rows[k] for k in ("U1", "U2", "U3", "U4", "U5", "U6") if k in rows and utterances[k]["end"]]
    speakers = [rows[k] for k in ("U1", "U2", "U3") if k in rows]
    room_events = [
        str(e.get("type"))
        for e in (_dict(x) for x in _list(lab.get("roomEvents")))
        if _match(e.get("type"), _TYPE)
    ]

    # L5: U4, then U5 sent while U4 plays.
    u4_start = first_frame(frames, "agent.speak_started", source="U4")
    u4_end = first_frame(frames, "agent.speak_ended", source="U4")
    u4_cut = first_frame(frames, "agent.speak_interrupted", source="U4")
    u5_start = first_frame(frames, "agent.speak_started", source="U5")
    sent5 = _first_send(lab, "U5")
    behaviour: str | None
    gap: int | None = None
    if u4_cut is not None:
        behaviour = "cut"
    elif u4_end is not None and u5_start is not None:
        if u5_start["at"] >= u4_end["at"] - 50:
            behaviour, gap = "queued", round(u5_start["at"] - u4_end["at"])
        else:
            behaviour = "overlap"
    elif u4_start is None and u5_start is None:
        behaviour = None
    else:
        behaviour = "other"
    sent4 = _first_send(lab, "U4")
    u5_done = first_frame(frames, "agent.speak_ended", source="U5")
    # One utterance per turn: U6 opened with 1 s, the next 1 s appended 1.3 s later, then speak_end.
    sent6 = _first_send(lab, "U6")
    u6_done = first_frame(frames, "agent.speak_ended", source="U6")
    u6_until = (u6_done["at"] + 600) if u6_done else (sent6 + 7000 if sent6 is not None else None)
    u6_frames = [
        f for f in frames if sent6 is not None and u6_until is not None and sent6 <= f["at"] <= u6_until
    ]
    u6_onsets = _count_in(onsets, sent6, u6_until)

    # L8: U7 interrupted by I1.
    interrupt_at = marks.get("I1") or _first_send(lab, "I1", "agent.interrupt")
    interrupted = (
        first_frame(frames, "agent.speak_interrupted", after=interrupt_at)
        if interrupt_at is not None
        else None
    )
    cleared = (
        first_frame(frames, "agent.audio_buffer_cleared", after=interrupt_at)
        if interrupt_at is not None
        else None
    )
    u7_start = first_frame(frames, "agent.speak_started", source="U7")
    ended_after = (
        first_frame(frames, "agent.speak_ended", source="U7", after=interrupt_at)
        if interrupt_at is not None
        else None
    )
    silence = next((t for t in offsets if interrupt_at is not None and t >= interrupt_at - 250), None)
    return {
        "utterances": [rows[k] for k in sorted(rows, key=lambda x: int(x[1:]))],
        "l3": {
            "acks_complete": (
                all(r["appended"] == r["chunks"] and r["committed"] == 1 for r in sealed) if sealed else None
            ),
            "appended_sources": sorted({s for r in sealed for s in r["appended_sources"]}),
            "committed_sources": sorted({s for r in sealed for s in r["committed_sources"]}),
            "by_ids": {
                ids: {
                    "utterances": len(group),
                    "appended_equals_chunks": all(r["appended"] == r["chunks"] for r in group),
                    "committed_once": all(r["committed"] == 1 for r in group),
                }
                for ids in ("same", "distinct")
                if (group := [r for r in sealed if r["ids"] == ids])
            },
            "first_chunk_to_appended_ms": percentile_ms(r["first_chunk_to_appended_ms"] for r in sealed),
            "end_to_committed_ms": percentile_ms(r["end_to_committed_ms"] for r in sealed),
            "unattributed": _unattributed(frames),
        },
        "l4": {
            "to_started_ms": percentile_ms(r["to_started_ms"] for r in speakers),
            "to_audio_ms": percentile_ms(r["to_audio_ms"] for r in speakers),
            "started_to_audio_ms": percentile_ms(r["started_to_audio_ms"] for r in speakers),
            "to_ended_ms": percentile_ms(r["to_ended_ms"] for r in speakers),
            "by_first_chunk_ms": {
                str(r["first_chunk_ms"]): {
                    "to_started_ms": r["to_started_ms"],
                    "to_audio_ms": r["to_audio_ms"],
                }
                for r in speakers
            },
            "speak_events_complete": (
                all(r["speak_started"] and r["speak_ended"] for r in speakers) if speakers else None
            ),
            "sound_each_utterance": (
                all(r["to_audio_ms"] is not None for r in speakers) if speakers and can_hear else None
            ),
            "room_event_types": sorted(set(room_events)),
            # Only a room the page was in can show that it carried none.
            "room_speak_events": sum(1 for t in room_events if "speak" in t)
            if _room_connected(session)
            else None,
        },
        "l5": {
            "behaviour": behaviour,
            "gap_ms": gap,
            "second_sent_after_first_started_ms": _ms(u4_start["at"] if u4_start else None, sent5),
            "track_onsets": (
                _count_in(onsets, sent4, (u5_done["at"] + 600) if u5_done else None) if can_hear else None
            ),
            "turn_as_one_utterance": {
                "speak_started": sum(
                    1 for f in u6_frames if f["type"] == "agent.speak_started" and f["source"] == "U6"
                ),
                "speak_ended": sum(
                    1 for f in u6_frames if f["type"] == "agent.speak_ended" and f["source"] == "U6"
                ),
                "starvation": sum(
                    1 for f in u6_frames if "video_starvation" in (f["warning_type"], f["error_type"])
                ),
                "errors": sum(1 for f in u6_frames if f["type"] == "error"),
                "track_sounds": u6_onsets if can_hear else None,
                "committed": rows.get("U6", {}).get("committed"),
            },
        },
        "l8": {
            "started_before": u7_start is not None
            and interrupt_at is not None
            and u7_start["at"] < interrupt_at,
            "interrupted_event": interrupted is not None,
            "interrupted_source": None
            if interrupted is None
            else source_class(interrupted["source"], "U7", "I1"),
            "cleared_event": cleared is not None,
            "cleared_source": None if cleared is None else source_class(cleared["source"], "U7", "I1"),
            "speak_ended_after": ended_after is not None,
            "to_interrupted_ms": _ms(interrupt_at, interrupted["at"] if interrupted else None),
            "to_cleared_ms": _ms(interrupt_at, cleared["at"] if cleared else None),
            "to_silence_ms": None
            if silence is None or interrupt_at is None
            else max(0, round(silence - interrupt_at)),
        },
        "error": _match(session.get("error"), _ERROR),
    }


# ---- L6 / L7 (session two) -----------------------------------------------------------------------------------


def public_s2(session: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if session is None:
        return None
    lab = _dict(session.get("lab"))
    frames = frames_of(lab)
    sockets = sockets_of(lab)
    utterances = utterances_of(lab)
    onsets, offsets = times(lab.get("onsets")), times(lab.get("offsets"))
    a, b, c, d = (sockets.get(k) for k in ("A", "B", "C", "D"))

    def socket_role(frame: Mapping[str, Any] | None) -> str | None:
        if frame is None:
            return None
        return {"A": "first", "B": "second"}.get(frame["socket"], "other")

    sent1 = _first_send(lab, "U1")
    to_audio1, len1 = track_audio(onsets, offsets, sent1)
    audio1 = (utterances.get("U1") or {}).get("audio_ms")
    end1 = _num(_marks(session).get("U1_end"))
    first_onset1 = None if sent1 is None or to_audio1 is None else sent1 + to_audio1
    replaced = (
        None
        if a is None or b is None
        else (a["closed"] is not None and b["created"] - 50 <= a["closed"] <= b["created"] + 5000)
    )
    sent2 = _first_send(lab, "U2")
    to_audio2, len2 = track_audio(onsets, offsets, sent2)
    audio2 = (utterances.get("U2") or {}).get("audio_ms")
    sent3 = _first_send(lab, "U3")
    to_audio3, len3 = track_audio(onsets, offsets, sent3)
    audio3 = (utterances.get("U3") or {}).get("audio_ms")
    late_u2 = [f for f in frames if f["socket"] == "D" and _belongs(f["source"], "U2")]

    can_hear = heard(lab)

    def played(length: int | None, audio: int | None) -> bool | None:
        if audio is None or not can_hear:
            return None
        return length is not None and length >= PLAYED_OUT_SHARE * audio

    return {
        "l6": {
            "first_socket_closed": replaced,
            "first_close_code": None if a is None else a["close_code"],
            "first_closed_after_second_opened_ms": None
            if a is None or b is None
            else _ms(b["created"], a["closed"]),
            "second_connected": None if b is None else b["connected"] is not None,
            "committed_on_second": first_frame(
                frames, "agent.audio_buffer_committed", source="U1", socket="B"
            )
            is not None,
            "speak_started_socket": socket_role(first_frame(frames, "agent.speak_started", source="U1")),
            "speak_ended_socket": socket_role(first_frame(frames, "agent.speak_ended", source="U1")),
            "sound_before_commit": (
                None if not can_hear or end1 is None else (first_onset1 is not None and first_onset1 < end1)
            ),
            "audio_ms": audio1,
            "track_audio_ms": len1,
            "uncommitted_played_out": played(len1, audio1) if sent1 is not None else None,
            "reopened_after_close": None if c is None else c["connected"] is not None,
            "second_close_code": None if b is None else b["close_code"],
            "disconnected_states": sum(
                1 for f in frames if f["type"] == "session.state_updated" and f["state"] == "disconnected"
            ),
        },
        "l7": {
            "committed_then_closed": {
                "audio_ms": audio2,
                "to_audio_ms": to_audio2,
                "track_audio_ms": len2,
                "played_out": played(len2, audio2) if sent2 is not None else None,
                "events_on_next_socket": sorted({f["type"] for f in late_u2 if f["type"]}),
                "close_code": None if c is None else c["close_code"],
            },
            "uncommitted_then_closed": {
                "audio_ms": audio3,
                "to_audio_ms": to_audio3,
                "track_audio_ms": len3,
                "played": (to_audio3 is not None) if sent3 is not None and can_hear else None,
                "close_code": None if d is None else d["close_code"],
            },
        },
        "error": _match(session.get("error"), _ERROR),
    }


# ---- L9 / L10 (session three) --------------------------------------------------------------------------------


def lip_sync(idle: float | None, control: float | None, track: float | None) -> bool | None:
    """Whether the avatar's face moved with the published track: None when motion tells nothing (no idle baseline,
    or the socket utterance itself did not move the face more than idle); else whether the track window moved at
    least :data:`MOTION_RATIO` times idle and half as much as the socket utterance did."""
    if idle is None or control is None or track is None or idle <= 0:
        return None
    control_ratio = control / idle
    if control_ratio < MOTION_RATIO:
        return None
    return track / idle >= max(MOTION_RATIO, 0.5 * control_ratio)


def public_origins(session: Mapping[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in _list(session.get("origins")):
        attempt = _dict(raw)
        where = attempt.get("where")
        if where not in _ORIGIN_ATTEMPTS:
            continue
        out.append(
            {
                "where": where,
                "opened": _bool(attempt.get("opened")),
                "connected": _bool(attempt.get("connected")),
                "connect_ms": _int(attempt.get("connectMs")),
                "close_code": _int(attempt.get("closeCode")),
                "origin_header_ok": _bool(attempt.get("originHeaderOk")),
                "page_origin_ok": _bool(attempt.get("pageOriginOk")),
            }
        )
    return out


def public_s3(session: Mapping[str, Any] | None, production_origin_source: Any) -> dict[str, Any] | None:
    if session is None:
        return None
    lab = _dict(session.get("lab"))
    frames = frames_of(lab)
    marks = _marks(session)
    can_hear = heard(lab)
    onsets = times(lab.get("onsets"))
    room = _dict(session.get("room"))
    publish = _dict(session.get("publish"))
    data = [_dict(x) for x in _list(publish.get("data"))]
    track = _dict(publish.get("track"))
    motion = [
        (at, d)
        for at, d in ((_num(_dict(m).get("at")), _num(_dict(m).get("d"))) for m in _list(lab.get("motion")))
        if at is not None and d is not None
    ]

    def speak_events(start: float | None, end: float | None) -> int | None:
        if start is None or end is None:
            return None
        return sum(
            1 for f in frames if start <= f["at"] <= end and (f["type"] or "").startswith("agent.speak_")
        )

    data_from, data_to = marks.get("data_from"), marks.get("data_to")
    track_ok = track.get("ok") is True
    track_from, track_to = _num(track.get("from")), _num(track.get("to"))
    sent = _first_send(lab, "U1")
    control_start = first_frame(frames, "agent.speak_started", source="U1")
    control_end = first_frame(frames, "agent.speak_ended", source="U1")
    control_from = control_start["at"] if control_start else sent
    control_to = control_end["at"] if control_end else marks.get("control_to")
    idle = _mean_motion(motion, marks.get("idle_from"), marks.get("idle_to"))
    control_motion = _mean_motion(motion, control_from, control_to)
    track_motion = _mean_motion(motion, track_from, track_to)
    published = sum(1 for d in data if d.get("ok") is True)
    data_onsets = _count_in(onsets, data_from, data_to)
    data_events = speak_events(data_from, data_to)
    track_onsets = _count_in(onsets, track_from, track_to)
    track_events = speak_events(track_from, track_to)
    moved = lip_sync(idle, control_motion, track_motion)
    sources = room.get("canPublishSources")
    origins = public_origins(session)
    by_where = {o["where"]: o for o in origins}
    session_alive = (by_where.get("browser-local-after") or {}).get("connected")

    def accepted(where: str) -> bool | None:
        attempt = by_where.get(where)
        if attempt is None or attempt["connected"] is None:
            return None
        # A browser attempt counts only when the page really was at that origin and sent it.
        if where.startswith("browser-") and (
            attempt["origin_header_ok"] is False or attempt["page_origin_ok"] is False
        ):
            return None
        # A refusal counts only while the session still took a socket afterwards (the last one, from localhost).
        if attempt["connected"] is False and session_alive is False:
            return None
        return attempt["connected"]

    production, foreign = accepted("node-production-origin"), accepted("node-foreign-origin")
    browser_production = accepted("browser-production-origin")
    return {
        "room": {
            "connected_ms": _int(room.get("connectedMs")),
            "first_video_ms": _int(room.get("firstVideoMs")),
            "can_publish": _bool(room.get("canPublish")),
            "can_publish_data": _bool(room.get("canPublishData")),
            "can_publish_sources": [s for s in (_int(x) for x in _list(sources)) if s is not None][:10]
            if isinstance(sources, list)
            else None,
            "error": _match(room.get("error"), _ERROR),
        },
        "l9": {
            "data": {
                "published": published,
                "refused": sum(1 for d in data if d.get("ok") is False),
                "refusal_errors": sorted(
                    {e for d in data if (e := _match(d.get("error"), _ERROR)) is not None}
                ),
                "track_sounds": data_onsets,
                "speak_events": data_events,
                "ignored": (data_onsets == 0 and data_events == 0)
                if published and data_onsets is not None and can_hear
                else None,
            },
            "track": {
                "published": track_ok,
                "error": _match(track.get("error"), _ERROR),
                "track_sounds": track_onsets if track_ok else None,
                "speak_events": track_events if track_ok else None,
                "lip_sync": moved if track_ok else None,
                "ignored": (
                    (track_onsets == 0 and track_events == 0 and moved is not True)
                    if track_ok and track_onsets is not None and can_hear
                    else None
                ),
            },
            "motion": {
                "video_frames": _int(lab.get("videoFrames")),
                "samples": len(motion),
                "idle": idle,
                "socket_utterance": control_motion,
                "room_track": track_motion,
                "socket_utterance_ratio": None
                if not idle or control_motion is None
                else round(control_motion / idle, 2),
                "room_track_ratio": None
                if not idle or track_motion is None
                else round(track_motion / idle, 2),
            },
            "control_heard": (
                _count_in(onsets, control_from, control_to) not in (None, 0) if can_hear else None
            ),
        },
        "l10": {
            "production_origin_source": (
                production_origin_source if production_origin_source in ("repository", "stand-in") else None
            ),
            "attempts": origins,
            "browser_local_accepted": accepted("browser-local-origin"),
            "session_alive_after": session_alive,
            "browser_production_accepted": browser_production,
            "node_no_origin_accepted": accepted("node-no-origin"),
            "node_production_accepted": production,
            "node_foreign_accepted": foreign,
            # The vendor checks Origin when a foreign one is refused while the production one is taken.
            "origin_checked": (
                None if production is None or foreign is None else (production and not foreign)
            ),
        },
        "error": _match(session.get("error"), _ERROR),
    }


# ---- the hypotheses and the whole result ---------------------------------------------------------------------


def hypotheses(result: Mapping[str, Any]) -> dict[str, bool | None]:
    l1 = result.get("l1") or {}
    l2 = result.get("l2") or {}
    s1 = result.get("s1") or {}
    s2 = result.get("s2") or {}
    s3 = result.get("s3") or {}
    l4, l5, l8 = (s1.get(k) or {} for k in ("l4", "l5", "l8"))
    l6, l7 = (s2.get(k) or {} for k in ("l6", "l7"))
    l9, l10 = (s3.get(k) or {} for k in ("l9", "l10"))
    rows = [r for r in s1.get("utterances") or [] if r.get("label") in ("U1", "U2", "U3", "U4", "U5", "U6")]
    sealed = [r for r in rows if r.get("end") and (r.get("chunks") or 0) > 0]
    start = l1.get("start") or {}
    ws = l1.get("ws_url") or {}
    to_started = (l4.get("to_started_ms") or {}).get("p50")
    gap = l5.get("gap_ms")
    cleared = l8.get("to_cleared_ms")
    connected_counts = l2.get("connected_events_per_socket") or []

    def all_of(values: Sequence[bool | None]) -> bool | None:
        known = [v for v in values if v is not None]
        return None if not known else all(known)

    return {
        "l1_start_fields_as_documented": (
            not start.get("documented_missing") if start.get("fields") else None
        ),
        "l1_ws_url_one_exact_origin": (
            None
            if (ws.get("sessions_with_host") or 0) < MIN_SESSIONS_FOR_HOST
            else bool(ws.get("same_host_all_sessions")) and ws.get("host_has_id_label") is False
        ),
        "l2_connected_once_text_frames": (
            None
            if not connected_counts
            else connected_counts == [1] and l2.get("binary_frames") == 0 and l2.get("untyped_frames") == 0
        ),
        "l3_appended_per_chunk_by_utterance_id": (
            None
            if not sealed
            else all(r["appended"] == r["chunks"] and r["appended_sources"] == ["utterance"] for r in sealed)
        ),
        "l3_committed_once_by_utterance_id": (
            None
            if not sealed
            else all(r["committed"] == 1 and set(r["committed_sources"]) <= {"utterance"} for r in sealed)
        ),
        "l4_speak_events_on_socket": l4.get("speak_events_complete"),
        "l4_first_chunk_to_started_target": None
        if to_started is None
        else to_started <= FIRST_CHUNK_TO_STARTED_TARGET_MS,
        "l4_sound_on_avatar_track": l4.get("sound_each_utterance"),
        "l4_no_speak_events_in_room": (
            None if l4.get("room_speak_events") is None else l4.get("room_speak_events") == 0
        ),
        "l5_utterances_queue": None if l5.get("behaviour") is None else l5.get("behaviour") == "queued",
        "l5_queue_gap_target": None if gap is None else gap <= QUEUE_GAP_TARGET_MS,
        "l6_new_socket_replaces_old": l6.get("first_socket_closed"),
        "l6_open_utterance_survives_replacement": l6.get("uncommitted_played_out"),
        "l6_ws_url_reopens_after_close": l6.get("reopened_after_close"),
        "l7_committed_audio_survives_close": (l7.get("committed_then_closed") or {}).get("played_out"),
        "l8_interrupt_events_as_documented": (
            None
            if not l8.get("started_before")
            else (
                l8.get("interrupted_source") == "utterance"
                and l8.get("cleared_source") == "interrupt"
                and not l8.get("speak_ended_after")
            )
        ),
        "l8_cleared_target": None if cleared is None else cleared <= CLEARED_TARGET_MS,
        "l9_room_data_ignored": (l9.get("data") or {}).get("ignored"),
        "l9_room_audio_track_ignored": (l9.get("track") or {}).get("ignored"),
        "l10_browser_production_origin_accepted": all_of([l10.get("browser_production_accepted")]),
    }


def public_instruments(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The probe page's self-test: the synthesiser's level, the 1 s chunk size, the meter, the motion sampler."""
    if raw is None:
        return None
    out = {
        "synth_rms": _num(raw.get("synthRms")),
        "chunk_bytes_1s": _int(raw.get("base64Bytes")),
        "meter_onset": _bool(raw.get("meterOnset")),
        "meter_offset": _bool(raw.get("meterOffset")),
        "video_frames": _int(raw.get("videoFrames")),
        "motion_moving": _num(raw.get("motionMoving")),
        "motion_still": _num(raw.get("motionStill")),
        "error": _match(raw.get("error"), _ERROR),
    }
    moving, still = out["motion_moving"], out["motion_still"]
    out["ok"] = (
        out["meter_onset"] is True
        and out["chunk_bytes_1s"] == 48_000
        and (out["synth_rms"] or 0) > 0.05
        and moving is not None
        and moving > (still or 0)
    )
    return out


def public_lite_probe(
    raw: Mapping[str, Any] | None, instruments: Mapping[str, Any] | None = None
) -> dict[str, Any] | None:
    """The lite-probe arm's public result (None when it did not run): L1-L10 as numbers, codes and names, and the
    design's hypotheses with how many were confirmed, refuted and not measured."""
    if raw is None:
        return None
    sessions = [s for s in _list(raw.get("sessions")) if isinstance(s, dict)]
    result: dict[str, Any] = {
        "instruments": public_instruments(instruments),
        "l1": public_l1(sessions),
        "l2": public_l2(sessions),
        "s1": public_s1(_session(raw, "s1")),
        "s2": public_s2(_session(raw, "s2")),
        "s3": public_s3(_session(raw, "s3"), raw.get("production_origin_source")),
        "error": _match(raw.get("error"), _ERROR),
    }
    graded = hypotheses(result)
    result["hypotheses"] = graded
    result["confirmed"] = sum(1 for v in graded.values() if v is True)
    result["refuted"] = sum(1 for v in graded.values() if v is False)
    result["not_measured"] = sum(1 for v in graded.values() if v is None)
    return result
