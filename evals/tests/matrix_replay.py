"""Replays a recording of the mock model (``run --suite matrix --record-replies``) through the fake API.

The recording holds, session by session in run order, the vEIR's opening line, a call's intro and every turn's
reply exactly as the local API on the mock model returned them. Replaying it serves those replies in the same
order and checks that the matrix asks the same thing: each founder message must equal the recorded one, so a change
to the generator, the templates or the runner's venture choice fails loudly (re-record) instead of grading replies
to questions nobody asked.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

from foundry_evals.matrix.runner import read_recording
from tests.fake_api import FakeFoundryApi, Venture

RECORDING = Path(__file__).parent / "fixtures" / "matrix_ci_mock.jsonl"


class ReplayDriftError(AssertionError):
    """The run asked something the recording did not (the plan or the simulator changed since recording)."""


class Replay:
    def __init__(self, path: Path = RECORDING) -> None:
        self.document: dict[str, Any] = read_recording(path)
        sessions = self.document["sessions"]
        self.openers: deque[str | None] = deque(s["opener"] for s in sessions)
        self.intros: deque[str | None] = deque(s["intro"] for s in sessions if s["intro"] is not None)
        self.turns: deque[dict[str, Any]] = deque(t for s in sessions for t in s["turns"])
        self.served = 0

    def opener(self, api: FakeFoundryApi, session: dict[str, Any]) -> str | None:
        if not self.openers:
            raise ReplayDriftError("more sessions than recorded")
        return self.openers.popleft()

    def intro(self, api: FakeFoundryApi, session: dict[str, Any]) -> str:
        if not self.intros:
            raise ReplayDriftError("more calls than recorded")
        return self.intros.popleft() or ""

    def responder(self, api: FakeFoundryApi, venture: Venture, text: str, mode: str) -> dict[str, Any]:
        if not self.turns:
            raise ReplayDriftError("more turns than recorded")
        turn = self.turns.popleft()
        if turn["text"] != text:
            raise ReplayDriftError(f"turn {self.served + 1}: the founder message differs from the recording")
        self.served += 1
        if turn["kind"] == "blocked":
            return {"blocked": turn["blockedReason"] or "crisis_support"}
        if turn["kind"] == "error":
            return {"error": turn["errorCode"] or "model_error"}
        response = dict(turn["response"])
        if turn["speech"]:
            response["speech"] = list(turn["speech"])
        return response

    def api(self) -> FakeFoundryApi:
        return FakeFoundryApi(
            self.responder,
            memory_lab=True,
            memory_lab_teammate=True,
            intro_for=self.intro,
            opener_for=self.opener,
            model_id="mock",
        )

    @property
    def exhausted(self) -> bool:
        return not self.turns and not self.openers and not self.intros
