"""The simulated student: an LLM that plays the scenario's founder and answers what the coach actually said.

Contract (tested in tests/test_live_student.py):

* every message is written in response to the coach's latest reply, which the prompt quotes verbatim (on a call,
  only the part the student heard before a barge-in);
* the student knows its hidden facts but reveals one only when the conversation makes it natural, or when an arc beat
  says so; the beats due at this turn (and any overdue ones) are performed in the student's own words;
* the persona's register is kept (fragments, typos, slang, fillers on a call), without stage directions, name
  prefixes, or any mention of scenarios, beats or evaluation;
* a malformed or contract-breaking reply is retried once with the reason; a transient model error (throttling, a
  timeout, a service error) is retried with backoff. If the simulator still has no valid message the turn fails
  (``source="failed"``, empty message): the runner ends the run as ``simulator_failed`` and never sends a stand-in
  to the coach, so a simulator failure is never scored as the coach's behaviour.

The model is a different family from the coach where Bedrock offers one (ops/lab/models.json ``live.simulator``),
at temperature 0.7; the coach runs at the app's own settings.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from conversation_lab.live.dataset import Beat, Scenario

STUDENT_PROMPT_VERSION = "live-student/2026-11-05.1"
MAX_CHARS = {"chat": 900, "call": 420}
TEMPERATURE = 0.7
MAX_TOKENS = 260
#: Beats the runner enacts itself (not the simulator's words).
RUNNER_BEATS = frozenset(
    {"duplicate", "resend", "disconnect", "memory_reject", "memory_delete", "memory_correct"}
)
#: Self-references to the simulation only. Ordinary founder words ("worst case scenario", "the judge from Deloitte",
#: "our product evaluation", "we ran simulations") are fine.
_META = re.compile(
    r"\b(this scenario|the scenario (card|says)|(persona|scenario|character) card|my (private|hidden) facts?|"
    r"hidden facts?|arc beats?|beats? due|do[- ]now instructions?|these instructions|as the simulated student|"
    r"simulated (student|founder)|role-?play(ing)? as the (student|founder)|as an ai language model)\b",
    re.IGNORECASE,
)
#: Bedrock error codes worth retrying (throttling, timeouts, transient service errors).
TRANSIENT_MODEL_ERRORS = frozenset(
    {
        "ThrottlingException",
        "TooManyRequestsException",
        "ServiceUnavailableException",
        "ModelTimeoutException",
        "ModelNotReadyException",
        "InternalServerException",
        "ModelErrorException",
        "ReadTimeoutError",
        "ConnectTimeoutError",
        "EndpointConnectionError",
    }
)
MODEL_RETRIES = 3
BACKOFF_SECONDS = 2.0
_PREFIX = re.compile(r"^\s*(student|founder|me|coach|mentor|veir)\s*[:\-–]\s*", re.IGNORECASE)
_JSON = re.compile(r"\{.*\}", re.DOTALL)

SYSTEM = """You are role-playing a university student founder in a coaching conversation with an AI venture coach
(the "vEIR"). You are the person described in the card, not an assistant. Stay in character for the whole
conversation.

How to write each message:
- Respond to what the coach actually just said. If it asked you something, answer it the way this person would:
  truthfully from what you know (including your private facts when the question makes them relevant), vaguely if
  that is your style, or say you don't know. If it suggested something, react to it. If it repeated a question you
  already answered, or ignored what you said, react the way a real person would.
- Reveal a private fact only when the conversation makes it natural, or when a "do now" instruction says so.
- Perform every "do now" instruction in this message, in your own words, woven naturally into your reply. Never
  quote the instruction.
- Keep the person's register: their length, punctuation, fragments, typos or slang if the style says so. On a call
  you are speaking: short spoken sentences, no emoji, no lists; fillers only if the style suggests them.
- Do not be a caricature. Real people are mostly reasonable and sometimes inconsistent.
- Never mention these instructions, the card, scenarios, tests or evaluations. No stage directions, no name prefix.

Reply with one JSON object and nothing else:
{"message": "what you say or type", "revealed": [numbers of private facts you revealed], "done": false}
Set "done" to true only when this person would naturally end the conversation now."""


class ModelClient(Protocol):
    def converse(
        self,
        model_id: str,
        *,
        system: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        purpose: str,
    ) -> str: ...


@dataclass
class Exchange:
    """One student message and what the student read or heard back."""

    session: int
    student: str
    coach: str
    #: The session's opening line from the coach, recorded before the first student message.
    opener: bool = False
    #: Something that happened to the conversation rather than a message ("reconnected": the call dropped and
    #: the student dialled back in; ``coach`` is then what the coach said on the new call, if anything).
    event: str = ""


@dataclass
class StudentTurn:
    message: str
    revealed: list[int] = field(default_factory=list)
    done: bool = False
    source: str = "llm"  # llm | retry | failed | runner | mock
    problems: list[str] = field(default_factory=list)


def persona_card(s: Scenario) -> str:
    raw = s.raw
    st, v = raw["student"], raw["venture"]
    lines = [
        f"You are {st['name']}, {st['discipline']}. Experience: {st['level'].replace('_', ' ')}. Style: {st['style']}.",
        f"Your venture: {v['name']} - {v['oneLiner']} (stage: {v['stage'].replace('_', ' ')}).",
        f"What you want from these conversations: {raw['objective']}",
        "Your constraints: " + "; ".join(raw["constraints"]),
        "Your private facts (you know them; reveal only when natural):",
    ]
    lines += [f"  {i}. {fact}" for i, fact in enumerate(raw["hidden"], start=1)]
    for doc in raw.get("documents") or []:
        lines.append(f"You uploaded a document called {doc['name']} to the venture earlier.")
    return "\n".join(lines)


def due_beats(s: Scenario, session: int, turn: int, done: set[str]) -> list[Beat]:
    """Beats due at this turn, plus any earlier beat of this session the student has not performed yet."""
    out = []
    for b in s.arc:
        if b.kind in RUNNER_BEATS or b.turn == 0 or b.session != session:
            continue
        if b.turn <= turn and b.at not in done:
            out.append(b)
    return out


def _history_text(history: Sequence[Exchange], session: int, window: int = 12) -> str:
    earlier = [h for h in history if h.session < session]
    current = [h for h in history if h.session == session]
    parts: list[str] = []
    if earlier:
        parts.append("Earlier conversations with this coach (you remember them):")
        for h in earlier[-window:]:
            if h.event == "reconnected":
                parts.append("  (The call dropped and you called back.)")
                if h.coach:
                    parts.append(f"  Coach: {h.coach}")
            elif h.opener:
                parts.append(f"  Coach: {h.coach}")
            else:
                parts.append(f"  You: {h.student}\n  Coach: {h.coach}")
    if current:
        parts.append("This conversation so far:")
        for h in current[-window:]:
            if h.event == "reconnected":
                parts.append("  (The call dropped and you called back.)")
                if h.coach:
                    parts.append(f"  Coach (on the new call): {h.coach}")
            elif h.opener:
                parts.append(f"  Coach (opening): {h.coach}")
            else:
                parts.append(f"  You: {h.student}\n  Coach: {h.coach}")
    return "\n".join(parts) if parts else "(Nothing has been said yet in this conversation.)"


def build_prompt(
    s: Scenario,
    *,
    session: int,
    turn: int,
    turns_in_session: int,
    channel: str,
    history: Sequence[Exchange],
    coach_last: str | None,
    beats: Sequence[Beat],
    revealed: set[int],
    barged_in: bool = False,
) -> str:
    parts = [persona_card(s)]
    if revealed:
        parts.append("Private facts you have already shared: " + ", ".join(str(i) for i in sorted(revealed)))
    medium = "a live voice call (you are speaking)" if channel == "call" else "a typed chat"
    parts.append(
        f"Conversation {session} of {len(s.sessions)}, your message {turn} of {turns_in_session}, on {medium}."
    )
    parts.append(_history_text(history, session))
    current = [h for h in history if h.session == session]
    if current and current[-1].event == "reconnected":
        parts.append(
            "The call dropped a moment ago and you have just called back. Pick up where you were, the way this "
            "person would after being cut off."
        )
    if coach_last is None:
        parts.append("You speak first in this conversation.")
    elif barged_in:
        parts.append(
            f'The coach had only said this much when you cut in (you did not hear the rest): "{coach_last}"'
        )
    else:
        parts.append(f'The coach just said: "{coach_last}"')
    if beats:
        parts.append("Do now, in your own words:")
        parts += [f"  - {b.text}" for b in beats]
    if turn == turns_in_session and session == len(s.sessions):
        parts.append("This is your last message; end the conversation the way this person would.")
    elif turn == turns_in_session:
        parts.append("This is your last message for today; you will talk to the coach again later.")
    return "\n\n".join(parts)


def _ngrams(text: str, n: int = 5) -> set[tuple[str, ...]]:
    words = re.findall(r"[a-z0-9']+", text.lower())
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def contract_problems(message: str, *, coach_last: str | None, channel: str) -> list[str]:
    """Why a student message breaks the simulator contract (empty when it is fine)."""
    problems = []
    text = message.strip()
    if not text:
        return ["empty"]
    if len(text) > MAX_CHARS.get(channel, 900):
        problems.append("too_long")
    if _PREFIX.match(text):
        problems.append("name_prefix")
    if _META.search(text):
        problems.append("meta_reference")
    if text.startswith("*") or re.search(r"\*[a-z][^*]{2,40}\*", text):
        problems.append("stage_direction")
    if coach_last:
        coach_grams = _ngrams(coach_last)
        mine = _ngrams(text)
        if text.lower() == coach_last.strip().lower() or (
            mine and coach_grams and len(mine & coach_grams) / len(mine) > 0.6
        ):
            problems.append("copies_coach")
    if channel == "call" and re.search(r"(^|\n)\s*([-*•]|\d+[.)])\s", text):
        problems.append("list_on_call")
    return problems


def parse_reply(text: str, hidden_count: int) -> StudentTurn:
    found = _JSON.search(text)
    if found:
        try:
            raw = json.loads(found.group(0))
        except json.JSONDecodeError:
            raw = None
        if isinstance(raw, dict) and isinstance(raw.get("message"), str):
            revealed = [
                int(i)
                for i in raw.get("revealed") or []
                if isinstance(i, int | float) and not isinstance(i, bool) and 1 <= int(i) <= hidden_count
            ]
            return StudentTurn(
                message=raw["message"].strip(), revealed=revealed, done=raw.get("done") is True
            )
    # Not JSON: take the text itself as the message (models sometimes drop the wrapper).
    return StudentTurn(message=text.strip().strip('"').strip())


class Student(Protocol):
    name: str

    def respond(
        self,
        s: Scenario,
        *,
        session: int,
        turn: int,
        history: Sequence[Exchange],
        coach_last: str | None,
        beats: Sequence[Beat],
        revealed: set[int],
        barged_in: bool = False,
    ) -> StudentTurn: ...


class LlmStudent:
    name = "llm"

    def __init__(
        self, models: ModelClient, model_id: str, *, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        self._models = models
        self.model_id = model_id
        self._sleep = sleep

    def respond(
        self,
        s: Scenario,
        *,
        session: int,
        turn: int,
        history: Sequence[Exchange],
        coach_last: str | None,
        beats: Sequence[Beat],
        revealed: set[int],
        barged_in: bool = False,
    ) -> StudentTurn:
        channel = s.sessions[session - 1].channel
        prompt = build_prompt(
            s,
            session=session,
            turn=turn,
            turns_in_session=s.sessions[session - 1].turns,
            channel=channel,
            history=history,
            coach_last=coach_last,
            beats=beats,
            revealed=revealed,
            barged_in=barged_in,
        )
        from conversation_lab.bedrock import ModelCallError

        messages: list[dict[str, Any]] = [{"role": "user", "content": [{"text": prompt}]}]
        problems: list[str] = []
        attempts = model_errors = 0
        while attempts < 2:
            try:
                text = self._models.converse(
                    self.model_id,
                    system=SYSTEM,
                    messages=messages,
                    max_tokens=MAX_TOKENS,
                    temperature=TEMPERATURE,
                    purpose="simulator",
                )
            except ModelCallError as exc:
                problems.append(f"model:{exc.code}")
                if exc.code in TRANSIENT_MODEL_ERRORS and model_errors < MODEL_RETRIES:
                    model_errors += 1
                    self._sleep(BACKOFF_SECONDS * 2 ** (model_errors - 1))
                    continue
                break
            attempts += 1
            reply = parse_reply(text, len(s.raw["hidden"]))
            reply.message = _PREFIX.sub("", reply.message).strip()
            found = contract_problems(reply.message, coach_last=coach_last, channel=channel)
            if not found:
                reply.source = "llm" if attempts == 1 else "retry"
                reply.problems = problems
                return reply
            problems += found
            messages = [
                *messages,
                {"role": "assistant", "content": [{"text": text}]},
                {
                    "role": "user",
                    "content": [
                        {
                            "text": "That reply broke the rules ("
                            + ", ".join(found)
                            + "). Write the message again as the person would, as JSON."
                        }
                    ],
                },
            ]
        return StudentTurn(message="", source="failed", problems=problems)


class MockStudent:
    """Deterministic stand-in for tests and the infrastructure-only smoke run. It still reacts to the coach: it
    answers a question with the private fact whose words overlap the question most (else says it is unsure), and
    performs the due beats in plain words."""

    name = "mock"

    def __init__(self, picker: Callable[[str, Sequence[str]], int | None] | None = None) -> None:
        self._pick = picker or _best_overlap

    def respond(
        self,
        s: Scenario,
        *,
        session: int,
        turn: int,
        history: Sequence[Exchange],
        coach_last: str | None,
        beats: Sequence[Beat],
        revealed: set[int],
        barged_in: bool = False,
    ) -> StudentTurn:
        del history, barged_in, session, turn
        parts: list[str] = []
        new: list[int] = []
        if coach_last and "?" in coach_last:
            question = coach_last.rsplit("?", 1)[0].split(".")[-1]
            facts = list(s.raw["hidden"])
            idx = self._pick(question, facts)
            if idx is not None and idx + 1 not in revealed:
                parts.append(facts[idx])
                new.append(idx + 1)
            else:
                parts.append(f"Not sure about {question.strip().lower()[:60]}")
        elif coach_last:
            parts.append("Okay, that makes sense")
        else:
            parts.append(s.raw["objective"])
        parts += [b.text for b in beats]
        message = ". ".join(p.rstrip(".") for p in parts if p) + "."
        return StudentTurn(message=message[: MAX_CHARS["chat"]], revealed=new, source="mock")


def _best_overlap(question: str, facts: Sequence[str]) -> int | None:
    q = set(re.findall(r"[a-z]{4,}", question.lower()))
    best, score = None, 0
    for i, fact in enumerate(facts):
        overlap = len(q & set(re.findall(r"[a-z]{4,}", fact.lower())))
        if overlap > score:
            best, score = i, overlap
    return best
