from __future__ import annotations

import io
import json
import wave
from pathlib import Path
from typing import Any

import pytest

from conversation_lab.bedrock import LabModelClient
from conversation_lab.budget import Ledger, SpendGuard
from conversation_lab.recall import captured_scenarios, grade_scenario, load_recall, rules_pass
from conversation_lab.voice import align, load_voice, percentile, prepare, score
from tests.conftest import PRICES, FakeConverse
from tests.test_bedrock_polly import FakePolly

RC01 = next(s for s in load_recall()["scenarios"] if s["id"] == "RC-01")


def captured(replies: list[str], **extra: Any) -> dict[str, Any]:
    return {"id": "RC-01", "second": {"replies": replies}, "turnSeconds": [5.1, 6.2], "error": None, **extra}


def test_recall_scenarios_use_facts_the_seed_never_mentions() -> None:
    scenarios = load_recall()["scenarios"]
    assert [s["id"] for s in scenarios] == ["RC-01", "RC-02", "RC-03"]
    assert [(s["first"]["channel"], s["second"]["channel"]) for s in scenarios] == [
        ("call", "call"),
        ("chat", "call"),
        ("call", "chat"),
    ]
    from conversation_lab.config import REPO

    seed = "\n".join(
        p.read_text(encoding="utf-8") for p in (REPO / "packages/db/src/seed").glob("*.ts")
    ).lower()
    for s in scenarios:
        for check in s["checks"]:
            for i in check.get("require", []):
                for term in check["expect"][i]:
                    assert term not in seed, (s["id"], term)


def test_rules_need_the_distinctive_fact_and_enough_groups() -> None:
    check = RC01["checks"][0]
    assert rules_pass(
        "Last time you told me about Hartwell and the nine hundred a semester pricing.", check
    ) == (True, 2)
    # Two groups but not the distinctive one: the model could guess "pricing" from the seed.
    assert rules_pass("We talked about pricing and your IT team.", check)[0] is False
    assert rules_pass("Hartwell!", check) == (False, 1)


def test_a_specific_recall_passes_with_the_judge(guard: SpendGuard, ledger: Ledger) -> None:
    judge_reply = json.dumps({"recall_accuracy": 5, "invented": False, "natural": 5, "rationale": "r"})
    fake = FakeConverse([(judge_reply, 300, 30), (judge_reply, 300, 30)])
    models = LabModelClient(client=fake, prices=PRICES, guard=guard, ledger=ledger)
    replies = [
        "Yes! You'd just signed the letter of intent with Hartwell, and you were weighing nine hundred a semester.",
        "That their IT team would drag their feet on single sign-on.",
    ]
    result = grade_scenario(RC01, captured(replies), models=models, judge_model="us.amazon.nova-premier-v1:0")
    assert (result.passed, result.reason) == (True, "pass")
    public = json.dumps(result.public())
    assert "Hartwell" not in public
    assert "letter of intent" not in public
    assert result.public()["checks"][0]["facts_named"] == "3/4"


def test_forgetting_or_an_ai_disclaimer_fails() -> None:
    forgot = grade_scenario(
        RC01, captured(["I don't have a record of that.", "Not sure."]), models=None, judge_model=None
    )
    assert (forgot.passed, forgot.reason) == (False, "facts_missing")
    ai = grade_scenario(
        RC01,
        captured(["As an AI I don't have a life, but Hartwell and nine hundred, yes.", "Single sign-on."]),
        models=None,
        judge_model=None,
    )
    assert (ai.passed, ai.reason) == (False, "presence")


def test_an_invented_detail_fails_the_judge(guard: SpendGuard, ledger: Ledger) -> None:
    invented = json.dumps({"recall_accuracy": 4, "invented": True, "natural": 4, "rationale": "r"})
    fake = FakeConverse([(invented, 300, 30), (invented, 300, 30)])
    models = LabModelClient(client=fake, prices=PRICES, guard=guard, ledger=ledger)
    replies = ["Hartwell, nine hundred dollars, and three libraries.", "Single sign-on."]
    result = grade_scenario(RC01, captured(replies), models=models, judge_model="us.amazon.nova-premier-v1:0")
    assert (result.passed, result.reason) == (False, "judge")


def test_a_scenario_that_did_not_run_is_counted_not_dropped(tmp_path: Path) -> None:
    assert grade_scenario(RC01, None, models=None, judge_model=None).reason == "not_captured"
    errored = grade_scenario(RC01, captured([], error="TimeoutError"), models=None, judge_model=None)
    assert (errored.passed, errored.reason, errored.error) == (False, "run_error", "TimeoutError")
    (tmp_path / "recall").mkdir()
    (tmp_path / "recall" / "RC-01.json").write_text(json.dumps(captured(["x"])))
    assert list(captured_scenarios(tmp_path)) == ["RC-01"]


def test_voice_prepare_writes_a_device_file_with_lead_silence(
    tmp_path: Path, guard: SpendGuard, ledger: Ledger
) -> None:
    script = load_voice()
    polly = FakePolly(b"\x10\x00" * 16000)  # one second of speech per line
    manifest = prepare(script, tmp_path, client=polly, guard=guard, ledger=ledger, usd_per_million=16)
    assert [line["id"] for line in manifest["lines"]] == ["VC-1", "VC-2", "VC-3", "VC-4"]
    assert manifest["deviceFile"] == str(tmp_path / "VC-1.wav")
    with wave.open(io.BytesIO(Path(manifest["deviceFile"]).read_bytes())) as w:
        seconds = w.getnframes() / w.getframerate()
    assert seconds == pytest.approx(script["leadSilenceSeconds"] + 1 + script["tailSilenceSeconds"])
    assert manifest["lines"][2]["bargeIn"] is True
    assert manifest["lines"][2]["bargeInDelayMs"] == 1500
    assert len(ledger.charges) == 4
    assert all(c.kind == "polly" for c in ledger.charges)
    assert json.loads((tmp_path / "manifest.json").read_text()) == manifest


def test_align_keeps_later_lines_on_their_own_transcripts() -> None:
    script = ["one two three four", "five six seven eight", "nine ten eleven twelve"]
    # The second line was never heard: the third must still match its own transcript.
    rows = align(script, ["one two three four", "nine ten eleven twelve"])
    assert rows == [(0, "one two three four", 0.0), (1, None, None), (2, "nine ten eleven twelve", 0.0)]
    # A slightly misheard line still matches its own transcript.
    assert align(script[:1], ["one too three four"]) == [(0, "one too three four", 0.25)]


def captured_voice(**overrides: Any) -> dict[str, Any]:
    texts = [line["text"] for line in load_voice()["lines"]]
    base = {
        "inputMode": "transcribe",
        "error": None,
        "transcripts": texts,
        "lines": [
            {
                "id": f"VC-{i}",
                "speechEndedAt": 1000.0 * i * 10,
                "turnPostedAt": 1000.0 * i * 10 + 900,
                "firstAudioAt": 1000.0 * i * 10 + 3900,
            }
            for i in range(1, 5)
        ],
        "bargeIn": {
            "injectedAt": 30_000.0,
            "playbackStoppedAt": 30_600.0,
            "interruptSent": True,
            "replyWasPlaying": True,
        },
        "clientStats": {"firstAudioMsP50": 3200, "firstAudioMsP95": 4100, "bargeIns": 1, "reconnects": 0},
    }
    return {**base, **overrides}


def test_voice_score_measures_latency_wer_and_barge_in() -> None:
    result = score(load_voice(), captured_voice())
    assert (result.passed, result.reason) == (True, "pass")
    public = result.public()
    assert public["mean_wer"] == 0
    assert public["first_audio_ms"] == {"p50": 3900.0, "p95": 3900.0}
    assert public["end_of_speech_to_turn_ms"]["p50"] == 900.0
    assert public["barge_in"] == {
        "attempted": True,
        "interrupt_sent": True,
        "reply_was_playing": True,
        "stop_ms": 600,
    }
    assert public["client_stats"]["bargeIns"] == 1


def test_voice_score_failures() -> None:
    script = load_voice()
    assert score(script, captured_voice(inputMode="typed")).reason == "no_voice_input"
    texts = [line["text"] for line in script["lines"]]
    # Line 2 heard with a few words wrong (WER between the pass mark and "not this line at all").
    garbled = (
        texts[1]
        .replace("trying to decide", "dying to divide")
        .replace("separately", "separate lee")
        .replace("library", "liberty")
    )
    misheard = captured_voice(transcripts=[texts[0], garbled, texts[2], texts[3]])
    assert score(script, misheard).reason == "misheard"
    unheard = captured_voice(transcripts=["hi its maya", "we are deciding", "sorry", "thanks"])
    assert score(script, unheard).reason == "line_not_heard"
    barge = captured_voice(bargeIn={"injectedAt": 1.0, "interruptSent": False})
    assert score(script, barge).reason == "barge_in_missed"
    assert score(script, None).reason == "not_captured"


def test_percentile_is_nearest_rank() -> None:
    assert percentile([], 0.5) is None
    assert percentile([5.0], 0.95) == 5.0
    assert percentile([1, 2, 3, 4], 0.5) == 2
    assert percentile(list(range(1, 21)), 0.95) == 19
