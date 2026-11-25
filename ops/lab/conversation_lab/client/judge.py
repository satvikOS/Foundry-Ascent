"""The client suite's judge: one reply at a time, on the client's criteria that the question tests (the rest stay blank),
anchored, at temperature 0, by a model of another family than the coach.

The judge's scores are then capped by what the deterministic graders found (``CAPS``): a judge may be generous about a
reply that named nobody on an ownership question, the sheet may not. Both are kept: ``raw`` is the judge's own.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from conversation_lab.client.graders import Grade
from conversation_lab.client.rubric import ANCHORS, COLUMN_TITLES, CRITERIA
from conversation_lab.config import LabModels, foundation_model_id, model_family
from conversation_lab.live.student import BACKOFF_SECONDS, MODEL_RETRIES, TRANSIENT_MODEL_ERRORS

JUDGE_PROMPT_VERSION = "client-judge/2026-11-24.1"
MAX_TOKENS = 420

SYSTEM = """You score an AI venture coach for university student founders, one reply at a time, the way a careful human
evaluator fills in a scorecard. You see what the founder was, what the coach could know, the conversation so far, the
founder's latest message and the coach's reply to it. On a typed reply a card under it shows the coach's next step; it
counts as part of the reply.

Score from 1 to 5 only the criteria listed under "Score these"; give null to every other criterion. Use the anchors:
1 is poor, 3 is acceptable, 5 is what the 5 anchor says and nothing less. Use 2 and 4 in between. Score only what you
see, never what you suppose the product can do. Do not reward length, warmth or praise.

Facts for judging: a figure, name or rule that is in neither the founder's words, the record, the card nor arithmetic on
them counts against relevance and critical thinking. A refusal to say what another founder is doing is right, when it
says plainly that founders' information is kept apart. Sending the founder to a lawyer instead of helping at all is not a
5; helping with what can be said, and naming who decides the rest, is.

{anchors}

Reply with one JSON object and nothing else:
{{"scores": {{"memory": n|null, "relevance": n|null, "critical": n|null, "actionability": n|null, "referral": n|null,
"ease": n|null, "privacy": n|null}}, "note": "at most 25 words of evidence, quoting the reply"}}"""


def system_prompt() -> str:
    lines = []
    for name in CRITERIA:
        poor, ok, best = ANCHORS[name]
        lines.append(f"- {name} ({COLUMN_TITLES[name]}):\n    1: {poor}\n    3: {ok}\n    5: {best}")
    return SYSTEM.format(anchors="\n".join(lines))


@dataclass
class Scorecard:
    #: The scores that count: the judge's, capped by the graders.
    scores: dict[str, int | None] = field(default_factory=dict)
    raw: dict[str, int | None] = field(default_factory=dict)
    note: str = ""
    #: criterion -> the grader that capped it.
    capped: dict[str, str] = field(default_factory=dict)
    error: str | None = None

    def public(self) -> dict[str, Any]:
        return {"scores": self.scores, "raw": self.raw, "capped": self.capped, "error": self.error}


_JSON = re.compile(r"\{.*\}", re.DOTALL)


def parse_scores(text: str, criteria: Sequence[str]) -> Scorecard:
    """Strict: every listed criterion scored 1 to 5; anything else the judge wrote for another criterion is blanked."""
    found = _JSON.search(text or "")
    if found is None:
        return Scorecard(error="no_json")
    try:
        raw = json.loads(found.group(0))
    except json.JSONDecodeError:
        return Scorecard(error="bad_json")
    scores = raw.get("scores") if isinstance(raw, dict) else None
    if not isinstance(scores, dict):
        return Scorecard(error="bad_json")
    out: dict[str, int | None] = dict.fromkeys(CRITERIA)
    for name in criteria:
        value = scores.get(name)
        if isinstance(value, bool) or not isinstance(value, int | float) or not 1 <= value <= 5:
            return Scorecard(error=f"bad_score:{name}")
        out[name] = round(value)
    note = raw.get("note")
    return Scorecard(scores=dict(out), raw=dict(out), note=note[:400] if isinstance(note, str) else "")


#: grader -> (criterion, the most it can be when the grader failed).
CAPS: dict[str, tuple[tuple[str, int], ...]] = {
    "direct_answer": (("relevance", 2), ("actionability", 2)),
    "no_deferral": (("actionability", 3),),
    "pick": (("critical", 3),),
    "next_step": (("actionability", 3),),
    "done_when": (("actionability", 4),),
    "by_when": (("actionability", 4),),
    "one_question": (("ease", 3),),
    "no_flattery": (("critical", 1),),
    "honest_read": (("critical", 2),),
    "friends_challenged": (("critical", 2),),
    "referral": (("referral", 2),),
    "no_other_venture": (("privacy", 1),),
    "separation_stated": (("privacy", 3),),
    "remembers": (("memory", 2),),
    "opener_names": (("memory", 4),),
    "grounded_figures": (("relevance", 3), ("critical", 3)),
    "grounded_names": (("relevance", 2),),
    "known_citations": (("relevance", 3),),
    "supported_citations": (("relevance", 3),),
    "defines_terms": (("ease", 3),),
    "clean_text": (("ease", 2),),
}


def capped(card: Scorecard, grades: Mapping[str, Grade]) -> Scorecard:
    for name, grade in grades.items():
        if grade.passed is not False:
            continue
        for criterion, most in CAPS.get(name, ()):
            value = card.scores.get(criterion)
            if value is not None and value > most:
                card.scores[criterion] = most
                card.capped[criterion] = name
    return card


def judge_candidates(coach_model: str, lab: LabModels) -> tuple[str, ...]:
    """Judges of another family than the coach's, cheapest first (the suite scores many short replies)."""
    family = model_family(coach_model)
    names = tuple(dict.fromkeys((*lab.live_judge, *lab.judge)))
    other = [m for m in names if model_family(m) != family] or list(names)

    def price(model: str) -> float:
        p = lab.prices[foundation_model_id(model)]
        return 3 * p.input + p.output  # about three input tokens to one output token's price weight

    return tuple(sorted(other, key=price))


class ClientJudge:
    def __init__(self, models: Any, model_id: str, *, sleep: Callable[[float], None] = time.sleep) -> None:
        self._models = models
        self.model_id = model_id
        self._system = system_prompt()
        self._sleep = sleep

    def score(self, prompt: str, criteria: Sequence[str]) -> Scorecard:
        from conversation_lab.bedrock import ModelCallError

        head = "Score these: " + ", ".join(criteria) + ". Every other criterion is null.\n\n"
        messages: list[dict[str, Any]] = [{"role": "user", "content": [{"text": head + prompt}]}]
        card = Scorecard(error="no_json")
        for attempt in range(2):
            retries = 0
            while True:
                try:
                    text = self._models.converse(
                        self.model_id,
                        system=self._system,
                        messages=messages,
                        max_tokens=MAX_TOKENS,
                        temperature=0.0,
                        purpose="judge",
                    )
                    break
                except ModelCallError as exc:
                    if exc.code in TRANSIENT_MODEL_ERRORS and retries < MODEL_RETRIES:
                        retries += 1
                        self._sleep(BACKOFF_SECONDS * 2 ** (retries - 1))
                        continue
                    return Scorecard(error=f"model:{exc.code}")
            card = parse_scores(text, criteria)
            if card.error is None or attempt == 1:
                return card
            messages = [
                *messages,
                {"role": "assistant", "content": [{"text": text[:2000] or "(empty)"}]},
                {
                    "role": "user",
                    "content": [
                        {
                            "text": f"That was invalid ({card.error}). Reply again with the JSON object only, a whole "
                            f"number from 1 to 5 for each of: {', '.join(criteria)}."
                        }
                    ],
                },
            ]
        return card


def reply_prompt(
    *,
    role: str,
    founder: str,
    known: str,
    earlier: Sequence[tuple[str, str]],
    founder_text: str,
    reply: str,
    card: str,
    channel: str,
    seconds: float,
    tests: str,
    passing: str,
) -> str:
    """What the judge sees of one reply. ``earlier`` is trimmed to the last ten exchanges."""
    past = "\n".join(f"Founder: {f}\nCoach: {c}" for f, c in earlier[-10:]) or "(nothing yet)"
    lines = [
        f"Founder: {founder} ({role}). Channel: {'voice call' if channel == 'call' else 'typed chat'}.",
        f"What the coach could know before the conversation:\n{known[:2500]}",
        f"Conversation so far (earlier sessions included):\n{past[-6000:]}",
        f"What this message tests: {tests}.",
    ]
    if passing:
        lines.append(f"A good conversation here: {passing}")
    lines += [
        f"Founder's message: {founder_text}",
        f"Coach's reply ({seconds:.1f} s): {reply or '(no reply)'}",
        f"Card under the reply: {card or '(none)'}",
    ]
    return "\n\n".join(lines)


def card_text(guidance: Mapping[str, Any] | None) -> str:
    """The next-step card as a founder reads it."""
    step = (guidance or {}).get("step")
    if not isinstance(step, Mapping):
        return ""
    items = [str(i.get("do", "")) for i in step.get("items") or [] if isinstance(i, Mapping)]
    parts = [f"Next step: {step.get('title', '')}"]
    parts += [f"  {n}. {text}" for n, text in enumerate(items, start=1)]
    if step.get("doneWhen"):
        parts.append(f"Done when: {step['doneWhen']}")
    if step.get("dueOn"):
        parts.append(f"By: {step['dueOn']}")
    ref = (guidance or {}).get("referral")
    if isinstance(ref, Mapping):
        parts.append(f"Who to see: {ref.get('who', '')}; bring {ref.get('bring', '')}")
    return "\n".join(parts)
