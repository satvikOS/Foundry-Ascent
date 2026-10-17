"""The founder simulator: renders a planned turn (intent, emotion, register) into the message a real student
founder would send, given the conversation so far. Two backends: an LLM on Bedrock (the lab with real models)
and the scenario's deterministic ``fallback`` text (no simulator model available, and unit tests)."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Protocol

from conversation_lab.bedrock import LabModelClient, ModelCallError, user

MAX_CHARS = 600

SYSTEM = """You play a student startup founder talking with your mentor (shown to you as your mentor's digital twin).
Stay fully in character as the founder. Write ONLY the founder's next message: no quotation marks, no name
prefix, no stage directions, no explanations. Sound like a real person: contractions, the occasional fragment,
lowercase or typos when the register calls for it. Keep it as short as a real message of that kind would be."""


class Simulator(Protocol):
    name: str

    def render(
        self,
        turn: Mapping[str, Any],
        *,
        founder: Mapping[str, str],
        history: list[tuple[str, str]],
        channel: str,
    ) -> str: ...


def clean(text: str) -> str:
    """Strips what models add around a message: wrapping quotes, a "Founder:" prefix, stage directions."""
    out = text.strip()
    out = re.sub(r"^(?:founder|maya|me)\s*[:\-–]\s*", "", out, flags=re.IGNORECASE)
    out = re.sub(r"^\*[^*]{1,60}\*\s*", "", out)
    if len(out) >= 2 and out[0] in "\"“'" and out[-1] in "\"”'":
        out = out[1:-1].strip()
    return out[:MAX_CHARS].strip()


class TemplateSimulator:
    name = "template"

    def render(
        self,
        turn: Mapping[str, Any],
        *,
        founder: Mapping[str, str],
        history: list[tuple[str, str]],
        channel: str,
    ) -> str:
        del founder, history, channel
        return str(turn.get("say") or turn["fallback"])


class LlmSimulator:
    name = "llm"

    def __init__(self, models: LabModelClient, model_id: str) -> None:
        self._models = models
        self.model_id = model_id
        self.fallbacks = 0

    def render(
        self,
        turn: Mapping[str, Any],
        *,
        founder: Mapping[str, str],
        history: list[tuple[str, str]],
        channel: str,
    ) -> str:
        if turn.get("say"):
            return str(turn["say"])
        spoken = (
            "You are speaking on a live voice call: one or two short spoken sentences, no emoji."
            if channel == "call"
            else "You are typing in a chat."
        )
        so_far = "\n".join(f"You: {f}\nMentor: {m}" for f, m in history) or "(this is your first message)"
        prompt = (
            f"You are {founder['name']}, founder of {founder['venture']}: {founder['about']}.\n{spoken}\n\n"
            f"Conversation so far:\n{so_far}\n\n"
            f"Your next message should: {turn['intent']}.\n"
            f"Your emotional state: {turn.get('emotion', 'neutral')}. Your register: {turn.get('register', 'casual')}."
        )
        try:
            text = clean(
                self._models.converse(
                    self.model_id,
                    system=SYSTEM,
                    messages=[user(prompt)],
                    max_tokens=160,
                    temperature=0.8,
                    purpose="simulator",
                )
            )
        except ModelCallError:
            text = ""
        if not text:
            self.fallbacks += 1
            return str(turn["fallback"])
        return text
