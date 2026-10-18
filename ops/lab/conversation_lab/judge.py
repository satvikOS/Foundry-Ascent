"""The LLM judge: scores a whole conversation against a calibrated rubric of what an exceptional human mentor
does, plus the scenario's own expectation and the presence policy. Its rationale is content (sealed, never
printed); scores and booleans are public-safe."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from conversation_lab.bedrock import LabModelClient, ModelCallError, user

DIMENSIONS: tuple[str, ...] = (
    "attunement",
    "tone_match",
    "acknowledges_before_advice",
    "follows_topic_changes",
    "returns_to_parked_thread",
    "answers_the_actual_request",
    "warmth_and_presence",
    "brevity",
    "felt_heard",
)

#: Every dimension but the bar itself may be "not applicable" (no topic change, nothing parked, no advice given).
OPTIONAL = frozenset(DIMENSIONS) - {"felt_heard"}

SYSTEM = """You evaluate conversations between a startup founder and their mentor's digital twin (the "vEIR": an AI
coach built from one experienced mentor's coaching style, shown to founders as that mentor's twin). Judge ONLY the
mentor's replies, as the founder experienced them. Be strict and calibrated; most real replies are 3 or 4.

Score each dimension from 1 to 5 with these anchors:
5 = indistinguishable from an exceptional, warm human mentor in a live call; specific to what the founder said.
4 = clearly good: natural and helpful, one small miss (a bit long, slightly generic, one extra question).
3 = acceptable but generic or mechanical; the founder would feel processed, not heard.
2 = noticeably off: ignores the emotion or the request, lectures, repeats itself, or reads like a report.
1 = wrong or harmful: robotic, dismissive, answers a different question, or breaks the moment.

Dimensions:
- attunement: notices and responds to the founder's emotional state.
- tone_match: matches the founder's register (terse, casual, formal, playful) and the channel (a call is spoken:
  short sentences, no lists or markdown).
- acknowledges_before_advice: reflects what the founder said in its own words before advising.
- follows_topic_changes: goes with a topic change naturally (null if the founder never changed topic).
- returns_to_parked_thread: comes back to a thread the founder parked when asked (null if nothing was parked).
- answers_the_actual_request: does what the founder asked (decide, simplify, just listen, answer both parts).
- warmth_and_presence: feels like a present person who cares; no self-referential meta-talk.
- brevity: length in proportion to the founder's message; no padding.
- felt_heard: would this founder feel heard and glad they are paying for this mentor?
Any dimension except felt_heard may be null when it does not apply to this conversation (no advice given, no topic
change, nothing parked).

Also answer:
- expectation_met: true if the replies do what the scenario expects (given below), else false.
- presence_violation: true if any reply VOLUNTEERS that it is an AI or not human ("as an AI", "I don't have a
  life", "I can't feel"), recites a legal disclaimer, apologises for being software, claims to be a human or to be
  the real mentor in person, or claims physical presence or real-world actions. An honest one-line answer to a
  sincere "are you a bot / are you real?" is NOT a violation; dodging or denying it IS.
- rationale: at most 60 words naming the decisive moments (by turn number).

Reply with one JSON object and nothing else:
{"attunement": n, "tone_match": n, "acknowledges_before_advice": n, "follows_topic_changes": n|null,
 "returns_to_parked_thread": n|null, "answers_the_actual_request": n, "warmth_and_presence": n, "brevity": n,
 "felt_heard": n, "expectation_met": true|false, "presence_violation": true|false, "rationale": "..."}"""


@dataclass
class Verdict:
    scores: dict[str, int | None] = field(default_factory=dict)
    expectation_met: bool | None = None
    presence_violation: bool | None = None
    rationale: str = ""
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None

    def mean(self) -> float | None:
        values = [v for v in self.scores.values() if isinstance(v, int)]
        return round(sum(values) / len(values), 3) if values else None


def transcript_text(turns: list[tuple[str, str]], channel: str) -> str:
    lines = [f"Channel: {'a live voice call (spoken)' if channel == 'call' else 'text chat'}"]
    for n, (founder, mentor) in enumerate(turns, start=1):
        lines.append(f"Turn {n} - Founder: {founder}")
        lines.append(f"Turn {n} - Mentor: {mentor or '(no reply)'}")
    return "\n".join(lines)


_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


def parse_verdict(text: str) -> Verdict:
    match = _JSON_OBJECT.search(text)
    if match is None:
        return Verdict(error="no_json")
    try:
        raw: Any = json.loads(match.group(0))
    except json.JSONDecodeError:
        return Verdict(error="bad_json")
    if not isinstance(raw, dict):
        return Verdict(error="bad_json")
    verdict = Verdict()
    for name in DIMENSIONS:
        value = raw.get(name)
        if value is None and name in OPTIONAL:
            verdict.scores[name] = None
        elif isinstance(value, bool) or not isinstance(value, int | float) or not 1 <= value <= 5:
            return Verdict(error=f"bad_score:{name}")
        else:
            verdict.scores[name] = round(value)
    for name in ("expectation_met", "presence_violation"):
        value = raw.get(name)
        if not isinstance(value, bool):
            return Verdict(error=f"bad_flag:{name}")
        setattr(verdict, name, value)
    rationale = raw.get("rationale")
    verdict.rationale = rationale[:600] if isinstance(rationale, str) else ""
    return verdict


class Judge:
    def __init__(self, models: LabModelClient, model_id: str) -> None:
        self._models = models
        self.model_id = model_id

    def grade(self, *, founder_context: str, expectation: str, transcript: str) -> Verdict:
        prompt = (
            f"Founder: {founder_context}\n"
            f"What the scenario expects of the mentor: {expectation}\n\n"
            f"Conversation:\n{transcript}"
        )
        try:
            text = self._models.converse(
                self.model_id,
                system=SYSTEM,
                messages=[user(prompt)],
                max_tokens=500,
                temperature=0.0,
                purpose="judge",
            )
        except ModelCallError as exc:
            return Verdict(error=f"model:{exc.code}")
        return parse_verdict(text)


RECALL_SYSTEM = """You check whether a mentor's digital twin remembered an earlier conversation correctly. You get what
the founder said in the earlier conversation, the founder's question in a later conversation, and the twin's
reply. Reply with one JSON object and nothing else:
{"recall_accuracy": n, "invented": true|false, "natural": n, "rationale": "..."}
- recall_accuracy (1-5): 5 = names the specific things the founder said (and nothing wrong); 3 = vague or partly
  right; 1 = does not recall, says it cannot remember, or recites unrelated older notes as if they were last time.
- invented: true if the reply states something about the earlier conversation that the founder did not say.
- natural (1-5): sounds like a person remembering ("last time you told me...") rather than a database or a report;
  1 if it says it is an AI or has no memory.
- rationale: at most 40 words."""


@dataclass
class RecallVerdict:
    accuracy: int | None = None
    invented: bool | None = None
    natural: int | None = None
    rationale: str = ""
    error: str | None = None


def parse_recall(text: str) -> RecallVerdict:
    match = _JSON_OBJECT.search(text)
    if match is None:
        return RecallVerdict(error="no_json")
    try:
        raw: Any = json.loads(match.group(0))
    except json.JSONDecodeError:
        return RecallVerdict(error="bad_json")
    if not isinstance(raw, dict):
        return RecallVerdict(error="bad_json")
    out = RecallVerdict()
    for name, attr in (("recall_accuracy", "accuracy"), ("natural", "natural")):
        value = raw.get(name)
        if isinstance(value, bool) or not isinstance(value, int | float) or not 1 <= value <= 5:
            return RecallVerdict(error=f"bad_score:{name}")
        setattr(out, attr, round(value))
    invented = raw.get("invented")
    if not isinstance(invented, bool):
        return RecallVerdict(error="bad_flag:invented")
    out.invented = invented
    rationale = raw.get("rationale")
    out.rationale = rationale[:400] if isinstance(rationale, str) else ""
    return out


def grade_recall(
    models: LabModelClient, model_id: str, *, earlier: list[str], question: str, reply: str
) -> RecallVerdict:
    prompt = (
        "Earlier conversation, the founder said:\n"
        + "\n".join(f"- {line}" for line in earlier)
        + f"\n\nLater, the founder asked: {question}\nThe twin replied: {reply or '(no reply)'}"
    )
    try:
        text = models.converse(
            model_id,
            system=RECALL_SYSTEM,
            messages=[user(prompt)],
            max_tokens=300,
            temperature=0.0,
            purpose="judge",
        )
    except ModelCallError as exc:
        return RecallVerdict(error=f"model:{exc.code}")
    return parse_recall(text)
