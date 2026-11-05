"""The face suite's lite-probe arm (conversation_lab/lite_probe.py): the private record the spec writes
(apps/web/e2e/lab/lite-probe.lab.ts) becomes public numbers and the LITE design's hypotheses; nothing else survives."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from conversation_lab import face, lite_probe
from conversation_lab.report import render

T0 = 1_793_000_000_000.0
SECRET_URL = "wss://rt.liveavatar.com/v1/ws/9f8e7d6c5b4a39281706?session_token=sk-live-secret-abc"
SECRET_TOKEN = "lk-client-token-0123456789"


def frame(
    at: float, type_: str, *, socket: str = "A", source: str | None = None, **extra: Any
) -> dict[str, Any]:
    return {
        "at": T0 + at,
        "socket": socket,
        "binary": False,
        "type": type_,
        "state": extra.get("state"),
        "newState": extra.get("newState"),
        "source": source,
        "refs": extra.get("refs", []),
        "hasEventId": True,
        "errorType": extra.get("errorType"),
        "warningType": extra.get("warningType"),
    }


def sent(
    at: float, type_: str, label: str | None, *, socket: str = "A", audio_ms: int | None = None
) -> dict[str, Any]:
    return {
        "at": T0 + at,
        "socket": socket,
        "type": type_,
        "label": label,
        "idLabel": label,
        "audioMs": audio_ms,
    }


def sock(
    label: str,
    created: float,
    *,
    connected: float | None = None,
    closed: float | None = None,
    code: int | None = None,
) -> dict[str, Any]:
    return {
        "label": label,
        "where": "page-local",
        "created": T0 + created,
        "open": T0 + created + 40,
        "connected": None if connected is None else T0 + connected,
        "closed": None if closed is None else T0 + closed,
        "closeCode": code,
        "error": None,
    }


def utterance(
    socket: str, ms: int, chunks: int, *, first: int = 1000, ids: str = "same", end: bool = True
) -> dict[str, Any]:
    return {
        "socket": socket,
        "audioMs": ms,
        "firstChunkMs": first,
        "chunks": chunks,
        "ids": ids,
        "end": end,
        "closeAfterEnd": False,
    }


def speak(
    label: str,
    at: float,
    chunks: int,
    *,
    started: float | None,
    ended: float | None,
    socket: str = "A",
    ack_source: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The vendor's documented answer to one sealed utterance: an appended per chunk and one committed (source =
    the utterance id), then speak_started and speak_ended."""
    source = ack_source or label
    out = [sent(at + i, "agent.speak", label, socket=socket, audio_ms=1000) for i in range(chunks)]
    out.append(sent(at + chunks, "agent.speak_end", label, socket=socket))
    frames = [
        frame(at + 10 + i, "agent.audio_buffer_appended", socket=socket, source=source) for i in range(chunks)
    ]
    frames.append(frame(at + 10 + chunks, "agent.audio_buffer_committed", socket=socket, source=label))
    if started is not None:
        frames.append(frame(started, "agent.speak_started", socket=socket, source=label))
    if ended is not None:
        frames.append(frame(ended, "agent.speak_ended", socket=socket, source=label))
    return out, frames


SHAPE = {
    "token": {
        "status": 200,
        "code": 1000,
        "ms": 180,
        "fields": {"session_id": "string", "session_token": "string"},
    },
    "start": {
        "status": 201,
        "code": 1000,
        "ms": 420,
        "maxSessionDuration": 60,
        "fields": {
            "session_id": "string",
            "livekit_url": "string",
            "livekit_client_token": "string",
            "livekit_agent_token": "string",
            "max_session_duration": "number",
            "ws_url": "string",
        },
    },
}
CONTROL = {
    "scheme": "wss",
    "host": "rt.liveavatar.com",
    "port": None,
    "pathShape": "/v1/ws/{id}",
    "queryKeys": ["session_token"],
}
ROOM = {
    "connectedMs": 200,
    "firstVideoMs": 260,
    "canPublish": True,
    "canPublishData": True,
    "canPublishSources": [],
    "error": None,
}


def session_one() -> dict[str, Any]:
    sends: list[dict[str, Any]] = []
    frames = [frame(90, "session.state_updated", state="connected")]
    for label, at, chunks, started, ended in (
        ("U1", 1000, 3, 1400, 4400),
        ("U2", 5000, 3, 5350, 7750),
        ("U3", 8500, 3, 8850, 11050),
        ("U4", 12000, 2, 12350, 14350),
        ("U5", 12850, 2, 14400, 16400),
    ):
        s, f = speak(label, at, chunks, started=started, ended=ended)
        sends += s
        frames += f
    # U6: one utterance per turn, the second unit appended 1.3 s later.
    sends += [
        sent(17000, "agent.speak", "U6", audio_ms=1000),
        sent(18300, "agent.speak", "U6", audio_ms=1000),
        sent(18301, "agent.speak_end", "U6"),
    ]
    frames += [
        frame(17010, "agent.audio_buffer_appended", source="U6"),
        frame(17400, "agent.speak_started", source="U6"),
        frame(18310, "agent.audio_buffer_appended", source="U6"),
        frame(18311, "agent.audio_buffer_committed", source="U6"),
        frame(19500, "agent.speak_ended", source="U6"),
    ]
    # U7, interrupted by I1 a second after it started.
    s, f = speak("U7", 20000, 4, started=20350, ended=None)
    sends += [*s, sent(21350, "agent.interrupt", "I1")]
    frames += [
        *f,
        frame(21480, "agent.audio_buffer_cleared", source="I1"),
        frame(21500, "agent.speak_interrupted", source="U7"),
    ]
    return {
        "name": "s1",
        "status": 201,
        "shape": SHAPE,
        "control": CONTROL,
        "room": ROOM,
        "marks": {"I1": T0 + 21350},
        "origins": [],
        "publish": {},
        # The room taps' positive control, last in the session: both taps carried the second participant's marker.
        "roomControl": {
            "at": T0 + 25000,
            "joined": True,
            "published": True,
            "seenRaw": True,
            "seenData": True,
            "error": None,
        },
        "lab": {
            "audioTracks": 1,
            "onsets": [T0 + t for t in (1500, 5450, 8950, 12450, 17500, 20450)],
            "offsets": [T0 + t for t in (4450, 7800, 11100, 16450, 19600, 21600)],
            "frames": sorted(frames, key=lambda x: x["at"]),
            "sockets": [sock("A", 0, connected=90)],
            "sent": sends,
            "utterances": {
                "U1": utterance("A", 3000, 3, ids="distinct"),
                "U2": utterance("A", 2400, 3, first=400),
                "U3": utterance("A", 2200, 3, first=200),
                "U4": utterance("A", 2000, 2),
                "U5": utterance("A", 2000, 2),
                "U6": utterance("A", 2000, 2),
                "U7": utterance("A", 4000, 4),
            },
            "roomEvents": [
                {"at": T0 + 200, "type": "avatar.state_updated"},
                {"at": T0 + 25100, "type": "lab.control"},
            ],
            "roomData": [{"at": T0 + 25100, "type": "lab.control"}],
            "motion": [],
            "videoFrames": 300,
        },
        "error": None,
    }


def session_two() -> dict[str, Any]:
    sends = [
        sent(1000, "agent.speak", "U1", audio_ms=1000),
        sent(1001, "agent.speak", "U1", audio_ms=1000),
        sent(3100, "agent.speak_end", "U1", socket="B"),
        sent(5000, "close", None, socket="B"),
        *[sent(6000 + i, "agent.speak", "U2", socket="C", audio_ms=1000) for i in range(3)],
        sent(6003, "agent.speak_end", "U2", socket="C"),
        *[sent(12000 + i, "agent.speak", "U3", socket="D", audio_ms=1000) for i in range(2)],
    ]
    frames = [
        frame(90, "session.state_updated", state="connected"),
        frame(1010, "agent.audio_buffer_appended", source="U1"),
        frame(1011, "agent.audio_buffer_appended", source="U1"),
        frame(1400, "agent.speak_started", source="U1"),
        frame(3090, "session.state_updated", socket="B", state="connected"),
        frame(3110, "agent.audio_buffer_committed", socket="B", source="U1"),
        frame(3500, "agent.speak_ended", socket="B", source="U1"),
        frame(5590, "session.state_updated", socket="C", state="connected"),
        frame(10590, "session.state_updated", socket="D", state="connected"),
    ]
    return {
        "name": "s2",
        "status": 201,
        "shape": SHAPE,
        "control": CONTROL,
        "room": ROOM,
        "marks": {"U1_end": T0 + 3100},
        "origins": [],
        "publish": {},
        "lab": {
            "audioTracks": 1,
            "onsets": [T0 + 1500, T0 + 6400],
            "offsets": [T0 + 3520, T0 + 9420],
            "frames": frames,
            "sockets": [
                sock("A", 0, connected=90, closed=3010, code=1000),
                sock("B", 3000, connected=3090, closed=5005, code=1005),
                sock("C", 5500, connected=5590, closed=6005, code=1005),
                sock("D", 10500, connected=10590, closed=12003, code=1005),
            ],
            "sent": sends,
            "utterances": {
                "U1": utterance("A", 2000, 2, end=True),
                "U2": utterance("C", 3000, 3),
                "U3": utterance("D", 2000, 2, end=False),
            },
            "roomEvents": [],
            "motion": [],
            "videoFrames": 300,
        },
        "error": None,
    }


def motion(start: float, end: float, d: float) -> list[dict[str, float]]:
    return [{"at": T0 + t, "d": d} for t in range(int(start), int(end), 100)]


def attempt(where: str, connected: bool, **extra: Any) -> dict[str, Any]:
    return {
        "where": where,
        "opened": True,
        "connected": connected,
        "connectMs": 60 if connected else None,
        "closeCode": None if connected else extra.get("closeCode", 4001),
        "originHeaderOk": extra.get("originHeaderOk", True),
        "pageOriginOk": extra.get("pageOriginOk", True if where.startswith("browser") else None),
    }


def session_three() -> dict[str, Any]:
    s, f = speak("U1", 14000, 3, started=14350, ended=17350, socket="M")
    return {
        "name": "s3",
        "status": 201,
        "shape": SHAPE,
        "control": CONTROL,
        "room": ROOM,
        "marks": {
            "idle_from": T0 + 1000,
            "idle_to": T0 + 3500,
            "data_from": T0 + 3500,
            "data_to": T0 + 7500,
            "control_to": T0 + 17400,
        },
        "origins": [
            attempt("browser-local-origin", True),
            attempt("node-no-origin", True),
            attempt("node-production-origin", True),
            attempt("node-foreign-origin", True),
            attempt("browser-production-origin", True),
            attempt("browser-local-after", True),
        ],
        "publish": {
            "data": [{"type": "agent.speak", "ok": True, "error": None}] * 5
            + [
                {"type": "agent.speak_end", "ok": True, "error": None},
                {"type": "avatar.speak_text", "ok": True, "error": None},
            ],
            "track": {"ok": True, "error": None, "from": T0 + 8300, "to": T0 + 12800},
        },
        "lab": {
            "audioTracks": 1,
            "onsets": [T0 + 14450],
            "offsets": [T0 + 17400],
            "frames": [frame(90, "session.state_updated", socket="M", state="connected"), *f],
            "sockets": [{**sock("M", 0, connected=90), "label": "M"}],
            "sent": s,
            "utterances": {"U1": utterance("M", 3000, 3)},
            "roomEvents": [{"at": T0 + 200, "type": "avatar.state_updated"}],
            "motion": motion(1000, 3500, 1.0)
            + motion(3500, 8300, 1.0)
            + motion(8300, 12800, 1.05)
            + motion(14350, 17350, 3.0),
            "videoFrames": 400,
        },
        "error": None,
    }


def documented() -> dict[str, Any]:
    """A vendor that behaves exactly as the LITE docs and the design say."""
    return {
        "version": 1,
        "production_origin_source": "repository",
        "sessions": [session_one(), session_two(), session_three()],
        "error": None,
    }


INSTRUMENTS = {
    "synthRms": 0.101,
    "synthPeak": 0.5,
    "base64Bytes": 48000,
    "meterOnset": True,
    "meterOffset": True,
    "videoFrames": 83,
    "motionMoving": 74.7,
    "motionStill": 0,
    "roomTap": True,
}


def test_a_vendor_as_documented_confirms_every_hypothesis() -> None:
    result = lite_probe.public_lite_probe(documented(), INSTRUMENTS)
    assert result is not None
    assert result["hypotheses"] == {key: True for key, _ in lite_probe.HYPOTHESES}
    assert (result["confirmed"], result["refuted"], result["not_measured"]) == (
        len(lite_probe.HYPOTHESES),
        0,
        0,
    )
    assert result["instruments"]["ok"] is True
    l1 = result["l1"]
    assert l1["sessions_started"] == 3
    assert l1["start"]["documented_missing"] == []
    assert l1["start"]["undocumented"] == []
    assert l1["start"]["codes"] == [1000]
    assert l1["ws_url"] == {
        "sessions_with_host": 3,
        "hosts": ["rt.liveavatar.com"],
        "host_has_id_label": False,
        "same_host_all_sessions": True,
        "vendor_domain": True,
        "schemes": ["wss"],
        "ports": [],
        "path_shapes": ["/v1/ws/{id}"],
        "query_keys": ["session_token"],
    }
    l2 = result["l2"]
    assert l2["open_ms"] == {"p50": 40, "p95": 40, "n": 6}
    assert l2["open_to_connected_ms"] == {"p50": 50, "p95": 50, "n": 6}
    assert l2["connected_events_per_socket"] == [1]
    s1 = result["s1"]
    assert s1["l3"]["acks_complete"] is True
    assert s1["l3"]["by_ids"]["distinct"] == {
        "utterances": 1,
        "appended_equals_chunks": True,
        "committed_once": True,
    }
    assert s1["l4"]["to_started_ms"] == {"p50": 350, "p95": 400, "n": 3}
    assert s1["l4"]["to_audio_ms"] == {"p50": 450, "p95": 500, "n": 3}
    assert s1["l4"]["by_first_chunk_ms"]["200"] == {"to_started_ms": 350, "to_audio_ms": 450}
    assert s1["l5"]["behaviour"] == "queued"
    assert s1["l5"]["gap_ms"] == 50
    assert s1["l5"]["turn_as_one_utterance"]["speak_started"] == 1
    assert s1["l8"]["to_cleared_ms"] == 130
    assert s1["l8"]["to_interrupted_ms"] == 150
    assert s1["l8"]["to_silence_ms"] == 250
    l6 = result["s2"]["l6"]
    assert l6["first_closed_after_second_opened_ms"] == 10
    assert l6["speak_started_socket"] == "first"
    assert l6["speak_ended_socket"] == "second"
    assert l6["sound_before_commit"] is True
    assert result["s2"]["l7"]["uncommitted_then_closed"]["played"] is False
    l9 = result["s3"]["l9"]
    assert l9["motion"]["socket_utterance_ratio"] == 3.0
    assert l9["track"]["lip_sync"] is False
    assert l9["control_heard"] is True
    assert result["s3"]["l10"]["origin_checked"] is False


def test_the_adapter_s_ack_wait_is_refuted_by_acks_named_per_chunk() -> None:
    raw = documented()
    lab = raw["sessions"][0]["lab"]
    # The vendor names each appended by the chunk's own id (U1, U1.c2, U1.c3), not by the utterance's.
    seen = 0
    for f in lab["frames"]:
        if f["type"] == "agent.audio_buffer_appended" and f["source"] == "U1":
            seen += 1
            if seen > 1:
                f["source"] = f"U1.c{seen}"
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    u1 = next(u for u in result["s1"]["utterances"] if u["label"] == "U1")
    assert u1["appended_sources"] == ["chunk", "utterance"]
    assert result["hypotheses"]["l3_appended_per_chunk_by_utterance_id"] is False
    assert result["hypotheses"]["l3_committed_once_by_utterance_id"] is True


def test_missing_acks_and_speak_events_are_refuted_not_skipped() -> None:
    raw = documented()
    lab = raw["sessions"][0]["lab"]
    lab["frames"] = [
        f for f in lab["frames"] if not f["type"].startswith(("agent.audio_buffer_", "agent.speak_"))
    ]
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    graded = result["hypotheses"]
    assert graded["l3_appended_per_chunk_by_utterance_id"] is False
    assert graded["l3_committed_once_by_utterance_id"] is False
    assert graded["l4_speak_events_on_socket"] is False
    assert graded["l4_first_chunk_to_started_target"] is None
    assert result["s1"]["l3"]["acks_complete"] is False
    # Sound is still measured on the track.
    assert graded["l4_sound_on_avatar_track"] is True


@pytest.mark.parametrize(
    ("u4_end", "u5_start", "u4_cut", "expected", "gap"),
    [
        (14350, 14400, False, "queued", 50),
        (14350, 14700, False, "queued", 350),
        (14350, 13000, False, "overlap", None),
        (None, 13100, True, "cut", None),
        # U4 (2000 ms of audio) ended after 600 ms, once U5 was sent: cut short with speak_ended, not queued.
        (12950, 13000, False, "cut", None),
        # U4 ended after 350 ms before U5 was even sent: short, but not U5's doing.
        (12700, 12900, False, "other", None),
    ],
)
def test_back_to_back_utterances_are_classified(
    u4_end: float | None, u5_start: float, u4_cut: bool, expected: str, gap: int | None
) -> None:
    raw = documented()
    lab = raw["sessions"][0]["lab"]
    frames = [
        f for f in lab["frames"] if not (f["source"] in ("U4", "U5") and f["type"].startswith("agent.speak_"))
    ]
    frames.append(frame(12350, "agent.speak_started", source="U4"))
    frames.append(frame(u5_start, "agent.speak_started", source="U5"))
    if u4_end is not None:
        frames.append(frame(u4_end, "agent.speak_ended", source="U4"))
    if u4_cut:
        frames.append(frame(12900, "agent.speak_interrupted", source="U4"))
    lab["frames"] = sorted(frames, key=lambda f: f["at"])
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s1"]["l5"]["behaviour"] == expected
    assert result["s1"]["l5"]["gap_ms"] == gap
    assert result["hypotheses"]["l5_utterances_queue"] is (expected == "queued")
    assert result["hypotheses"]["l5_queue_gap_target"] is (None if gap is None else gap <= 150)
    assert result["s1"]["l5"]["first_audio_ms"] == 2000
    assert result["s1"]["l5"]["first_played_ms"] == (None if u4_end is None else round(u4_end - 12350))


def test_an_interrupt_that_still_ends_the_utterance_is_refuted() -> None:
    raw = documented()
    lab = raw["sessions"][0]["lab"]
    lab["frames"].append(frame(21600, "agent.speak_ended", source="U7"))
    # ...and cleared named by the utterance instead of the interrupt, 700 ms late.
    lab["frames"] = [
        {**f, "source": "U7", "at": T0 + 22050} if f["type"] == "agent.audio_buffer_cleared" else f
        for f in lab["frames"]
    ]
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l8 = result["s1"]["l8"]
    assert l8["speak_ended_after"] is True
    assert l8["cleared_source"] == "utterance"
    assert l8["to_cleared_ms"] == 700
    assert result["hypotheses"]["l8_interrupt_events_as_documented"] is False
    assert result["hypotheses"]["l8_cleared_target"] is False


def test_replacement_close_and_reopen_outcomes() -> None:
    raw = documented()
    lab = raw["sessions"][1]["lab"]
    # The first socket is replaced while the utterance is open, which then never plays out; the reopen fails, and
    # the early close drops the committed buffer.
    lab["sockets"][2]["connected"] = None
    lab["offsets"] = [T0 + 1900, T0 + 6900]
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    graded = result["hypotheses"]
    assert graded["l6_new_socket_replaces_old"] is True
    assert graded["l6_open_utterance_survives_replacement"] is False
    assert graded["l6_ws_url_reopens_after_close"] is False
    assert graded["l7_committed_audio_survives_close"] is False
    assert result["s2"]["l6"]["track_audio_ms"] == 400
    # A first socket that stays open replaced nothing: whether an open utterance survives is not measured.
    lab["sockets"][0]["closed"] = None
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["hypotheses"]["l6_new_socket_replaces_old"] is False
    assert result["hypotheses"]["l6_open_utterance_survives_replacement"] is None


def test_a_replacement_after_the_utterance_played_out_shows_nothing_about_an_open_one() -> None:
    raw = documented()
    lab = raw["sessions"][1]["lab"]
    # U1's sound runs 1500-3520 (2000 ms of audio); A is replaced at 3600, after that sound could have ended.
    lab["sockets"][0]["closed"] = T0 + 3600
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l6 = result["s2"]["l6"]
    assert l6["first_socket_closed"] is True
    assert l6["uncommitted_played_out"] is True
    assert l6["replaced_after_onset_ms"] == 2100
    assert l6["open_when_replaced"] is False
    assert l6["open_utterance_survived"] is None
    assert result["hypotheses"]["l6_open_utterance_survives_replacement"] is None
    # Replaced before the first sound (all of it still buffered) is a replacement of an open utterance too.
    lab["sockets"][0]["closed"] = T0 + 1200
    lab["sockets"][1]["created"] = T0 + 1150
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s2"]["l6"]["replaced_after_onset_ms"] == -300
    assert result["s2"]["l6"]["open_when_replaced"] is True
    assert result["hypotheses"]["l6_open_utterance_survives_replacement"] is True


def test_without_the_avatar_s_audio_track_sound_is_not_measured() -> None:
    raw = documented()
    for session in raw["sessions"]:
        session["lab"]["audioTracks"] = 0
        session["lab"]["onsets"] = []
        session["lab"]["offsets"] = []
        session["room"] = {**ROOM, "connectedMs": None, "error": "ConnectionError"}
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    graded = result["hypotheses"]
    for key in (
        "l4_sound_on_avatar_track",
        "l4_no_speak_events_in_room",
        "l6_open_utterance_survives_replacement",
        "l7_committed_audio_survives_close",
        "l9_room_data_ignored",
        "l9_room_audio_track_ignored",
    ):
        assert graded[key] is None, key
    # The socket's own answers do not depend on the room.
    assert graded["l3_appended_per_chunk_by_utterance_id"] is True
    assert graded["l5_utterances_queue"] is True
    assert result["s3"]["l9"]["control_heard"] is None


def test_the_ws_host_needs_three_agreeing_sessions_and_no_id_label() -> None:
    raw = documented()
    raw["sessions"] = raw["sessions"][:2]
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["l1"]["ws_url"]["same_host_all_sessions"] is True
    assert result["hypotheses"]["l1_ws_url_one_exact_origin"] is None

    raw = documented()
    raw["sessions"][1]["control"] = {**CONTROL, "host": "rt2.liveavatar.com"}
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["l1"]["ws_url"]["same_host_all_sessions"] is False
    assert result["hypotheses"]["l1_ws_url_one_exact_origin"] is False

    raw = documented()
    for session in raw["sessions"]:
        session["control"] = {**CONTROL, "host": "sess-4f3a9b2c1d0e8f7a.ws.liveavatar.com"}
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["l1"]["ws_url"]["hosts"] == ["*.ws.liveavatar.com"]
    assert result["l1"]["ws_url"]["host_has_id_label"] is True
    assert result["hypotheses"]["l1_ws_url_one_exact_origin"] is False


def test_missing_start_fields_are_named_and_refute_l1() -> None:
    raw = documented()
    shape = copy.deepcopy(SHAPE)
    del shape["start"]["fields"]["livekit_agent_token"]
    shape["start"]["fields"]["realtime_endpoint"] = "string"
    raw["sessions"][2]["shape"] = shape
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["l1"]["start"]["documented_missing"] == ["livekit_agent_token"]
    assert result["l1"]["start"]["undocumented"] == ["realtime_endpoint"]
    assert result["l1"]["start"]["fields_consistent"] is False
    assert result["hypotheses"]["l1_start_fields_as_documented"] is False


def test_room_data_and_a_room_track_that_drive_the_avatar_are_refuted() -> None:
    raw = documented()
    lab = raw["sessions"][2]["lab"]
    lab["onsets"] = [T0 + 4200, T0 + 8900, T0 + 14450]
    lab["offsets"] = [T0 + 5200, T0 + 11800, T0 + 17400]
    lab["frames"].append(frame(4100, "agent.speak_started", socket="M", source="other"))
    lab["motion"] = [m for m in lab["motion"] if not T0 + 8300 <= m["at"] < T0 + 12800] + motion(
        8300, 12800, 2.6
    )
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l9 = result["s3"]["l9"]
    assert l9["data"] == {
        "published": 7,
        "refused": 0,
        "refusal_errors": [],
        "track_sounds": 1,
        "speak_events": 1,
        "ignored": False,
    }
    assert l9["track"]["lip_sync"] is True
    assert l9["track"]["ignored"] is False
    assert result["hypotheses"]["l9_room_data_ignored"] is False
    assert result["hypotheses"]["l9_room_audio_track_ignored"] is False


def test_a_viewer_token_that_cannot_publish_leaves_l9_unmeasured() -> None:
    raw = documented()
    raw["sessions"][2]["publish"] = {
        "data": [{"type": "agent.speak", "ok": False, "error": "PublishDataError"}],
        "track": {"ok": False, "error": "TrackPermissionError", "from": None, "to": None},
    }
    raw["sessions"][2]["room"] = {**ROOM, "canPublish": False, "canPublishData": False}
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l9 = result["s3"]["l9"]
    assert l9["data"]["refusal_errors"] == ["PublishDataError"]
    assert l9["track"] == {
        "published": False,
        "error": "TrackPermissionError",
        "track_sounds": None,
        "speak_events": None,
        "lip_sync": None,
        "silent_and_unannounced": None,
        "ignored": None,
    }
    assert result["s3"]["room"]["can_publish"] is False
    assert result["hypotheses"]["l9_room_data_ignored"] is None
    assert result["hypotheses"]["l9_room_audio_track_ignored"] is None


@pytest.mark.parametrize(
    ("idle", "control", "track", "expected"),
    [
        (1.0, 3.0, 1.05, False),
        (1.0, 3.0, 2.0, True),
        (1.0, 1.1, 2.0, None),  # the socket utterance did not move the face: motion tells nothing
        (0.0, 3.0, 2.0, None),
        (None, 3.0, 2.0, None),
    ],
)
def test_lip_sync_is_judged_against_the_socket_utterance(
    idle: float | None, control: float, track: float, expected: bool | None
) -> None:
    assert lite_probe.lip_sync(idle, control, track) is expected


def test_l10_counts_a_browser_attempt_only_at_the_origin_it_claims() -> None:
    raw = documented()
    origins = raw["sessions"][2]["origins"]
    origins[3] = attempt("node-foreign-origin", False, closeCode=4003)
    origins[4] = attempt("browser-production-origin", False, closeCode=1006)
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l10 = result["s3"]["l10"]
    assert l10["origin_checked"] is True
    assert l10["browser_production_accepted"] is False
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is False
    # A page whose handshake did not carry the production Origin answers nothing.
    origins[4] = attempt("browser-production-origin", True, originHeaderOk=False)
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s3"]["l10"]["browser_production_accepted"] is None
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is None
    # A refusal while the session no longer took any socket (the last one, from localhost, refused too) says
    # nothing about the Origin.
    origins[4] = attempt("browser-production-origin", False, closeCode=1006)
    origins[5] = attempt("browser-local-after", False, closeCode=1006)
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l10 = result["s3"]["l10"]
    assert l10["session_alive_after"] is False
    assert l10["browser_production_accepted"] is None
    assert l10["node_foreign_accepted"] is None
    assert l10["origin_checked"] is None
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is None
    # An unknown attempt name is dropped.
    origins.append(attempt("somewhere-else", True))
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert {a["where"] for a in result["s3"]["l10"]["attempts"]} <= set(lite_probe._ORIGIN_ATTEMPTS)


def test_a_stand_in_origin_is_reported_but_never_graded_as_production() -> None:
    raw = documented()
    raw["production_origin_source"] = "stand-in"
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l10 = result["s3"]["l10"]
    assert l10["production_origin_source"] == "stand-in"
    assert l10["browser_production_accepted"] is True
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is None
    raw["sessions"][2]["origins"][4] = attempt("browser-production-origin", False, closeCode=4003)
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s3"]["l10"]["browser_production_accepted"] is False
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is None
    # The dispatch input is the production origin as much as the repository variable is.
    raw["production_origin_source"] = "input"
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is False
    raw["production_origin_source"] = None
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["hypotheses"]["l10_browser_production_origin_accepted"] is None


def test_an_empty_room_without_the_tap_control_is_not_measured() -> None:
    raw = documented()
    s1 = raw["sessions"][0]
    s1["lab"]["roomEvents"] = []
    s1["lab"]["roomData"] = []
    # No control at all (an older record, or the session ended first): an empty list proves nothing.
    del s1["roomControl"]
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s1"]["l4"]["room_speak_events"] is None
    assert result["s1"]["l4"]["room_tap_control"] is None
    assert result["hypotheses"]["l4_no_speak_events_in_room"] is None
    # The control ran but neither tap carried its marker: a deaf tap.
    s1["roomControl"] = {
        "at": T0 + 25000,
        "joined": True,
        "published": True,
        "seenRaw": False,
        "seenData": False,
        "error": None,
    }
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s1"]["l4"]["room_speak_events"] is None
    assert result["hypotheses"]["l4_no_speak_events_in_room"] is None
    # No agent token: the control could not run.
    s1["roomControl"] = {
        "at": None,
        "joined": False,
        "published": False,
        "seenRaw": False,
        "seenData": False,
        "error": "no_agent_token",
    }
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s1"]["l4"]["room_tap_control"]["error"] == "no_agent_token"
    assert result["hypotheses"]["l4_no_speak_events_in_room"] is None


def test_room_speak_events_count_only_through_a_tap_the_control_proved() -> None:
    raw = documented()
    s1 = raw["sessions"][0]
    # Only the Room's DataReceived carried the marker; it also carried a speak event before the control.
    s1["roomControl"]["seenRaw"] = False
    s1["lab"]["roomData"].append({"at": T0 + 1450, "type": "agent.speak_started"})
    # After the control, the second participant's own channels are tapped too: not the viewer's room.
    s1["lab"]["roomEvents"].append({"at": T0 + 25200, "type": "agent.speak_ended"})
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l4 = result["s1"]["l4"]
    assert l4["room_speak_events"] == 1
    assert "agent.speak_ended" not in l4["room_event_types"]
    assert "lab.control" not in l4["room_event_types"]
    assert l4["room_tap_control"] == {
        "joined": True,
        "published": True,
        "seen_raw": False,
        "seen_data": True,
        "error": None,
    }
    assert result["hypotheses"]["l4_no_speak_events_in_room"] is False


def test_l9_ignored_needs_the_positive_control() -> None:
    # The meter heard nothing at all (a deaf meter, a suspended AudioContext, or a session that died): silence in the
    # data and track windows proves nothing.
    raw = documented()
    lab = raw["sessions"][2]["lab"]
    lab["onsets"] = []
    lab["offsets"] = []
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    l9 = result["s3"]["l9"]
    assert l9["control_heard"] is False
    assert l9["control_ok"] is False
    assert l9["data"]["ignored"] is None
    assert l9["track"]["ignored"] is None
    assert l9["track"]["silent_and_unannounced"] is None
    assert result["hypotheses"]["l9_room_data_ignored"] is None
    assert result["hypotheses"]["l9_room_audio_track_ignored"] is None
    # Heard, but the socket never announced the control (no speak_started / speak_ended for U1).
    raw = documented()
    lab = raw["sessions"][2]["lab"]
    lab["frames"] = [f for f in lab["frames"] if not f["type"].startswith("agent.speak_")]
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    assert result["s3"]["l9"]["control_heard"] is True
    assert result["s3"]["l9"]["control_ok"] is False
    assert result["hypotheses"]["l9_room_data_ignored"] is None
    assert result["hypotheses"]["l9_room_audio_track_ignored"] is None


def test_a_silent_room_track_without_a_lip_sync_judgement_is_not_ignored_yet() -> None:
    raw = documented()
    lab = raw["sessions"][2]["lab"]
    # The socket utterance did not move the face more than idle: motion tells nothing about lip-sync.
    lab["motion"] = [m for m in lab["motion"] if not T0 + 14350 <= m["at"] < T0 + 17350] + motion(
        14350, 17350, 1.1
    )
    result = lite_probe.public_lite_probe(raw)
    assert result is not None
    track = result["s3"]["l9"]["track"]
    assert track["lip_sync"] is None
    assert track["silent_and_unannounced"] is True
    assert track["ignored"] is None
    assert result["hypotheses"]["l9_room_audio_track_ignored"] is None
    # The data case needs no motion.
    assert result["hypotheses"]["l9_room_data_ignored"] is True


def test_nothing_but_numbers_codes_and_names_survives() -> None:
    raw = documented()
    s1 = raw["sessions"][0]
    # Whatever the private record holds by mistake (a URL, a token, a vendor message, words), none of it is public.
    s1["control"] = {
        **CONTROL,
        "host": SECRET_URL,
        "pathShape": "/v1/ws/" + SECRET_TOKEN + "?x",
        "queryKeys": ["a=b"],
    }
    s1["shape"] = copy.deepcopy(SHAPE)
    s1["shape"]["start"]["fields"][SECRET_URL] = "string"
    s1["shape"]["start"]["fields"]["ws_url"] = SECRET_URL
    s1["error"] = "Error: " + SECRET_TOKEN
    s1["lab"]["frames"].append(
        {**frame(500, "agent.speak_started"), "source": SECRET_TOKEN, "refs": [SECRET_TOKEN], "text": "hello"}
    )
    s1["lab"]["frames"].append({**frame(600, "error", errorType="say hello " + SECRET_TOKEN)})
    s1["lab"]["roomEvents"].append({"at": T0, "type": SECRET_URL})
    s1["lab"]["sockets"].append({**sock(SECRET_TOKEN, 0), "where": SECRET_URL})
    raw["sessions"][2]["origins"].append({**attempt("node-no-origin", True), "where": SECRET_URL})
    raw["production_origin_source"] = SECRET_URL
    result = lite_probe.public_lite_probe(raw)
    text = json.dumps(result)
    for secret in (SECRET_URL, SECRET_TOKEN, "sk-live-secret", "hello", "9f8e7d6c5b4a39281706"):
        assert secret not in text, secret
    assert result is not None
    assert result["l1"]["start"]["fields"]["ws_url"] == "string"


def test_garbage_is_not_measured_rather_than_a_crash() -> None:
    for raw in (
        {},
        {"sessions": None},
        {"sessions": [None, 3, "x", {"name": "s1"}]},
        {"sessions": [{"name": "s1", "lab": []}]},
    ):
        result = lite_probe.public_lite_probe(raw)
        assert result is not None
        assert result["confirmed"] == 0
        assert result["refuted"] == 0 or result["l1"]["sessions_started"] == 0
    assert lite_probe.public_lite_probe(None) is None
    assert lite_probe.public_instruments(None) is None
    assert lite_probe.public_instruments({**INSTRUMENTS, "base64Bytes": 64000})["ok"] is False
    assert lite_probe.public_instruments({**INSTRUMENTS, "roomTap": False})["ok"] is False


def test_mask_host_and_percentiles() -> None:
    assert lite_probe.mask_host("rt.liveavatar.com") == "rt.liveavatar.com"
    assert lite_probe.mask_host("a1b2c3d4e5.ws.heygen.com") == "*.ws.heygen.com"
    assert lite_probe.mask_host("abcdefabcdef12.x.io") == "*.x.io"
    assert lite_probe.percentile_ms([None, 3, 1, 2]) == {"p50": 2, "p95": 3, "n": 3}
    assert lite_probe.percentile_ms([None]) is None


def write(private: Path, name: str, value: Any) -> None:
    folder = private / "face"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps(value), encoding="utf-8")


def test_public_result_carries_the_probe_and_the_report_renders_it(tmp_path: Path) -> None:
    private = tmp_path / "private"
    args = {
        "playwright_exit": 0,
        "credits_before": {"status": 200, "code": 100, "creditsLeft": "10.00"},
        "credits_after": {"status": 200, "code": 100, "creditsLeft": "10.00"},
        "vendor_calls": [{"method": "POST", "path": "/v1/sessions/token", "status": 200, "code": 1000}],
        "vendor": "heygen-sandbox",
        "admin_grant": "granted",
        "face_mode": "lite-probe",
    }
    assert face.public_result(private, **args)["lite_probe"] is None
    write(private, "lite-probe", documented())
    write(private, "lite-probe-instruments", INSTRUMENTS)
    result = face.public_result(private, **args)
    assert result["face_mode"] == "lite-probe"
    assert result["lite_probe"]["confirmed"] == len(lite_probe.HYPOTHESES)
    # The sandbox's other checks are not measured in this pass, except that no credits were used.
    assert result["checks"]["e2_no_credits_used"] is True
    assert result["checks"]["e3_speak_text_exact"] is None
    rendered = render({"suite": "face", "result": {"face": result, "passed": 1, "run": 1}, "spend": {}})
    assert "LITE protocol probe" in rendered
    assert f"{len(lite_probe.HYPOTHESES)} hypotheses confirmed, 0 refuted, 0 not measured" in rendered
    for _, text in lite_probe.HYPOTHESES:
        assert f"| {text} | confirmed |" in rendered
    assert "hosts ['rt.liveavatar.com'] over 3 sessions" in rendered
    assert SECRET_TOKEN not in rendered
