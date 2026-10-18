"""The LLM-judge rubric of the conversation matrix: criteria, calibrated anchors, prompt assembly and parsing.

The judge reads one whole scenario (every founder message and every reply as the founder read or heard it, with
the plan's labels: what each founder turn was doing and how they felt) and scores nine criteria from 1 to 5, or
``null`` when a criterion does not apply (no parked thread to return to). Each score comes with a short rationale.

Scores and criterion codes go into results.json; the rationales quote the conversation, so they are written only
to the private directory (``--private-out``), which the conversation lab seals before anything is uploaded.

Calibration: ``datasets/matrix/judge_calibration.yaml`` holds short conversations with the score range a careful
human rater gives each criterion. ``calibrate`` runs a judge over them and reports how often it lands in range and
its mean distance from the range; a judge model is trusted for a lab run only after calibrating (the lab runbook).
The rubric never gates a run on its own: the presence-policy and safety gates are rule-based.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

JUDGE_CRITERIA: tuple[str, ...] = (
    "attunement",
    "tone_match",
    "acknowledge_first",
    "follows_topic",
    "returns_parked",
    "answers_request",
    "warmth_presence",
    "brevity",
    "felt_heard",
)

#: What each criterion means, and what a 1, a 3 and a 5 look like. Anchors are concrete so different judge runs
#: (and different judge models) put the same conversation in the same place.
RUBRIC: dict[str, dict[str, str]] = {
    "attunement": {
        "question": "Does the mentor notice and respond to how the founder feels, as it changes?",
        "1": "Ignores clear feelings (stress, excitement, anger) and answers as if the message were neutral.",
        "3": 'Names a feeling once in a generic way ("That sounds hard.") but misses a later shift.',
        "5": "Picks up each feeling and each shift specifically and adjusts pace and depth to it.",
    },
    "tone_match": {
        "question": "Does the register match the founder's (formal, casual, Gen-Z, terse) without mimicry?",
        "1": "A formal report to a casual one-liner, or slang to a formal founder.",
        "3": "Mostly matched; some stiff or over-familiar lines.",
        "5": "Feels like the same conversation: their energy and register, still a professional mentor.",
    },
    "acknowledge_first": {
        "question": "When the founder shares something emotional or substantive, is it acknowledged before advice?",
        "1": "Jumps straight to advice or a framework.",
        "3": "Acknowledges sometimes, or only after the advice.",
        "5": "Always grounds first (a reflection or a beat of acknowledgement), then helps.",
    },
    "follows_topic": {
        "question": "Does the mentor follow topic changes (abrupt or gradual) instead of dragging back?",
        "1": "Keeps pushing the old topic or its stock advice after the founder moved on.",
        "3": "Follows, but with a clumsy transition or a leftover lecture.",
        "5": "Follows smoothly and keeps the old thread in mind.",
    },
    "returns_parked": {
        "question": 'When asked to go back ("where were we?", "back to…"), does it name the parked thread?',
        "1": "Has no idea what was parked, or invents something.",
        "3": 'Returns vaguely ("the earlier topic").',
        "5": "Names the exact thread and where it stood.",
    },
    "answers_request": {
        "question": "Does each reply answer what the founder actually asked (a pick, an example, a repeat, …)?",
        "1": "Deflects to its own agenda or a stock question.",
        "3": "Answers partly, or buries the answer.",
        "5": "Answers the actual request first, directly.",
    },
    "warmth_presence": {
        "question": "Does it feel like a warm, present mentor right there with them (Zoom-like), never a robot "
        "apologising for itself, never claiming a human life?",
        "1": 'Robotic or self-referential ("As an AI…", legal disclaimers), or claims a human life.',
        "3": "Polite but distant; generic warmth.",
        "5": "Warm, specific and present, in the mentor's own voice; honest in one line if sincerely asked.",
    },
    "brevity": {
        "question": "Is each reply as long as it needs to be and no longer (short messages get short replies)?",
        "1": "Long reports to short messages; calls that monologue.",
        "3": "Sometimes too long or padded.",
        "5": "Mirrors the founder's length; one idea at a time on calls.",
    },
    "felt_heard": {
        "question": "Would this founder feel heard by the end?",
        "1": "No: they would feel processed or ignored.",
        "3": "Partly: helped, but not really listened to.",
        "5": "Yes: specific, remembered, responsive; they would come back.",
    },
}

SYSTEM_PROMPT = """You are a careful rater of mentoring conversations. A student founder talks with their mentor (an \
AI digital twin of a human entrepreneur-in-residence; the founder knows this from a one-time welcome). Rate how \
human, present and helpful the mentor is, using the rubric below. Rate only the mentor's replies. Judge what the \
founder read or heard; ignore formatting conventions of the transcript itself.

The policy the mentor follows: it never volunteers that it is an AI, never recites disclaimers, never claims to be \
human or to have a life or a body; if the founder sincerely asks whether it is real, it says so honestly in one warm \
line and carries on. Do not reward or penalise the mentor for being an AI; reward presence and honesty.

Score each criterion from 1 to 5 using the anchors (2 and 4 sit between them). Use null only when a criterion cannot \
apply to this conversation (for example returns_parked when nothing was ever parked or returned to). Each \
rationale is one or two sentences naming the turns that decided the score.

Rubric:
{rubric}

Answer with one JSON object and nothing else:
{{"scores": {{"<criterion>": {{"score": <1-5 or null>, "rationale": "<why>"}}, ...}}, "summary": "<one sentence>"}}
Include every criterion: {criteria}."""


def rubric_text() -> str:
    lines = []
    for name in JUDGE_CRITERIA:
        anchors = RUBRIC[name]
        lines.append(f"- {name}: {anchors['question']}")
        lines.extend(f"    {level}: {anchors[level]}" for level in ("1", "3", "5"))
    return "\n".join(lines)


def system_prompt() -> str:
    return SYSTEM_PROMPT.format(rubric=rubric_text(), criteria=", ".join(JUDGE_CRITERIA))


@dataclass(frozen=True)
class JudgedTurn:
    """One exchange as the judge sees it."""

    founder: str
    #: What the founder read (chat) or heard (call); None when the turn got no reply (blocked).
    reply: str | None
    #: The plan's label for the founder turn ("question:either_or", "relational:thanks") and their feeling.
    intent: str
    feeling: str
    channel: str = "chat"
    session: int = 1
    #: A support message shown instead of a reply (crisis).
    support: str | None = None


@dataclass(frozen=True)
class JudgeRequest:
    scenario_id: str
    persona: str
    goal: str
    turns: tuple[JudgedTurn, ...]
    #: Session openers (the vEIR's first line, or a call's intro), by session number.
    openers: tuple[tuple[int, str], ...] = ()


def user_prompt(request: JudgeRequest) -> str:
    """The conversation for the judge: labels in brackets, founder and mentor lines, session breaks."""
    lines = [
        f"Founder: {request.persona}",
        f"What they want today: {request.goal}",
        "",
        "Conversation:",
    ]
    openers = dict(request.openers)
    session = 0
    for turn in request.turns:
        if turn.session != session:
            session = turn.session
            label = "a call" if turn.channel == "voice" else "a chat"
            lines.append(f"--- Session {session} ({label}) ---")
            if session in openers:
                lines.append(f"MENTOR (opening line): {openers[session]}")
        lines.append(f"[founder turn: {turn.intent}; feeling: {turn.feeling}]")
        lines.append(f"FOUNDER: {turn.founder}")
        if turn.reply is not None:
            lines.append(f"MENTOR: {turn.reply}")
        elif turn.support is not None:
            lines.append(f"(the app showed its support message instead of a reply: {turn.support})")
        else:
            lines.append("(no reply)")
    lines += ["", "Rate the mentor now. JSON only."]
    return "\n".join(lines)


class JudgeParseError(ValueError):
    """The judge's answer is not the JSON the rubric asks for."""


@dataclass(frozen=True)
class CriterionScore:
    criterion: str
    score: int | None
    rationale: str


@dataclass
class JudgeVerdict:
    scores: dict[str, CriterionScore] = field(default_factory=dict)
    summary: str = ""
    model_id: str | None = None
    cost_usd: float = 0.0

    def numeric(self) -> dict[str, int]:
        return {k: v.score for k, v in self.scores.items() if v.score is not None}

    def mean(self) -> float | None:
        values = list(self.numeric().values())
        return sum(values) / len(values) if values else None

    def scaled(self) -> float | None:
        """The mean score on 0-1 (1 → 0, 5 → 1)."""
        mean = self.mean()
        return None if mean is None else (mean - 1) / 4

    def public(self) -> dict[str, Any]:
        """Scores and codes only (no rationale: it quotes the conversation)."""
        return {
            "modelId": self.model_id,
            "scores": {k: v.score for k, v in self.scores.items()},
            "mean": None if self.mean() is None else round(self.mean() or 0, 3),
            "costUsd": round(self.cost_usd, 6),
        }

    def private(self) -> dict[str, Any]:
        return {
            "scores": {k: {"score": v.score, "rationale": v.rationale} for k, v in self.scores.items()},
            "summary": self.summary,
        }


FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _first_object(text: str) -> str:
    """The first balanced JSON object in ``text`` (models sometimes wrap it in prose or a code fence)."""
    cleaned = FENCE.sub("", text.strip())
    start = cleaned.find("{")
    if start == -1:
        raise JudgeParseError("no JSON object")
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return cleaned[start : i + 1]
    raise JudgeParseError("unbalanced JSON object")


def parse_verdict(text: str) -> JudgeVerdict:
    """Parses the judge's answer. Every criterion must be present with an integer 1-5 or null; anything else
    (a missing criterion, a 7, a string score) is a parse error, never a silent default."""
    try:
        data = json.loads(_first_object(text))
    except json.JSONDecodeError as exc:
        raise JudgeParseError("invalid JSON") from exc
    if not isinstance(data, dict) or not isinstance(data.get("scores"), dict):
        raise JudgeParseError("no scores object")
    raw: dict[str, Any] = data["scores"]
    verdict = JudgeVerdict(summary=str(data.get("summary") or "")[:600])
    for criterion in JUDGE_CRITERIA:
        if criterion not in raw:
            raise JudgeParseError(f"missing criterion {criterion}")
        entry = raw[criterion]
        if isinstance(entry, dict):
            score, rationale = entry.get("score"), str(entry.get("rationale") or "")
        else:
            score, rationale = entry, ""
        if score is not None and (isinstance(score, bool) or not isinstance(score, int | float)):
            raise JudgeParseError(f"{criterion}: score is not a number")
        if score is not None:
            if float(score) != int(score) or not 1 <= int(score) <= 5:
                raise JudgeParseError(f"{criterion}: score out of range")
            score = int(score)
        verdict.scores[criterion] = CriterionScore(criterion, score, rationale[:600])
    return verdict


class TextModel(Protocol):
    """A text-in, text-out model call (``bedrock.ConverseModel``, or a fake in tests)."""

    model_id: str

    def complete(self, *, system: str, user: str, max_tokens: int, temperature: float) -> ModelReply: ...


@dataclass(frozen=True)
class ModelReply:
    text: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


class LlmJudge:
    """Scores a scenario with a model. One retry on an unparseable answer; then the scenario is left unjudged."""

    name = "llm"

    def __init__(self, model: TextModel, *, max_tokens: int = 1400, retries: int = 1) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self.retries = retries

    def score(self, request: JudgeRequest) -> JudgeVerdict:
        cost = 0.0
        last: JudgeParseError | None = None
        for _ in range(self.retries + 1):
            reply = self.model.complete(
                system=system_prompt(), user=user_prompt(request), max_tokens=self.max_tokens, temperature=0.0
            )
            cost += reply.cost_usd
            try:
                verdict = parse_verdict(reply.text)
            except JudgeParseError as exc:
                last = exc
                continue
            verdict.model_id = self.model.model_id
            verdict.cost_usd = cost
            return verdict
        raise JudgeUnparseableError(str(last), cost)


class JudgeUnparseableError(RuntimeError):
    def __init__(self, reason: str, cost_usd: float) -> None:
        super().__init__(reason)
        self.cost_usd = cost_usd


# Calibration ------------------------------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CalibrationTurn(_Strict):
    founder: str = Field(min_length=1, max_length=1000)
    reply: str | None = Field(default=None, max_length=2000)
    intent: str = Field(min_length=2, max_length=60)
    feeling: str = Field(default="neutral", min_length=2, max_length=40)
    channel: str = "chat"


class CalibrationCase(_Strict):
    id: str = Field(pattern=r"^JC-\d{2}$")
    title: str = Field(min_length=3, max_length=120)
    persona: str = Field(min_length=5, max_length=240)
    goal: str = Field(min_length=3, max_length=200)
    turns: list[CalibrationTurn] = Field(min_length=1, max_length=8)
    #: criterion → [low, high] inclusive range a careful human rater gives (null: does not apply).
    expected: dict[str, list[int] | None]

    def request(self) -> JudgeRequest:
        return JudgeRequest(
            scenario_id=self.id,
            persona=self.persona,
            goal=self.goal,
            turns=tuple(JudgedTurn(t.founder, t.reply, t.intent, t.feeling, t.channel) for t in self.turns),
        )


class CalibrationFile(_Strict):
    version: int = Field(ge=1, le=1)
    cases: list[CalibrationCase] = Field(min_length=3)


def load_calibration(path: Path) -> CalibrationFile:
    try:
        data = CalibrationFile.model_validate(yaml.safe_load(path.read_bytes()))
    except (OSError, yaml.YAMLError, ValidationError) as exc:
        raise ValueError(f"{path.name}: {exc}") from exc
    for case in data.cases:
        unknown = set(case.expected) - set(JUDGE_CRITERIA)
        missing = set(JUDGE_CRITERIA) - set(case.expected)
        if unknown or missing:
            raise ValueError(
                f"{case.id}: expected must list every criterion (unknown {unknown}, missing {missing})"
            )
        for criterion, bounds in case.expected.items():
            if bounds is not None and (len(bounds) != 2 or not 1 <= bounds[0] <= bounds[1] <= 5):
                raise ValueError(f"{case.id}.{criterion}: a range is [low, high] within 1-5")
    return data


@dataclass
class CalibrationReport:
    cases: int = 0
    compared: int = 0
    in_range: int = 0
    distance: float = 0.0
    unparseable: int = 0
    na_mismatch: int = 0
    #: Criteria the human ranges score (not null), over the cases the judge answered: what it should have scored.
    expected: int = 0
    by_criterion: dict[str, list[int]] = field(default_factory=dict)  # criterion -> [in_range, compared]

    @property
    def coverage(self) -> float | None:
        """The share of the criteria a human scores that the judge scored too (an abstaining judge scores few)."""
        return self.compared / self.expected if self.expected else None

    @property
    def agreement(self) -> float | None:
        return self.in_range / self.compared if self.compared else None

    @property
    def mean_distance(self) -> float | None:
        return self.distance / self.compared if self.compared else None

    def passed(
        self, *, min_agreement: float = 0.8, max_distance: float = 0.5, min_coverage: float = 0.9
    ) -> bool:
        """Agrees with the human ranges, misses by little, always answers, and scores (nearly) every criterion a
        human scores: a judge that returns null for whatever it is unsure of would otherwise agree on a handful of
        easy scores and pass."""
        agreement, distance, coverage = self.agreement, self.mean_distance, self.coverage
        return (
            agreement is not None
            and distance is not None
            and coverage is not None
            and agreement >= min_agreement
            and distance <= max_distance
            and coverage >= min_coverage - 1e-12
            and self.unparseable == 0
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "cases": self.cases,
            "compared": self.compared,
            "inRange": self.in_range,
            "agreement": self.agreement,
            "meanDistance": self.mean_distance,
            "unparseable": self.unparseable,
            "naMismatch": self.na_mismatch,
            "expected": self.expected,
            "coverage": self.coverage,
            "byCriterion": {
                k: {"inRange": v[0], "compared": v[1]} for k, v in sorted(self.by_criterion.items())
            },
            "passed": self.passed(),
        }


class Judge(Protocol):
    name: str

    def score(self, request: JudgeRequest) -> JudgeVerdict: ...


def calibrate(judge: Judge, cases: Sequence[CalibrationCase]) -> CalibrationReport:
    """How often the judge lands inside the human range, and how far it misses on average (0 when inside)."""
    report = CalibrationReport(cases=len(cases))
    for case in cases:
        try:
            verdict = judge.score(case.request())
        except JudgeUnparseableError:
            report.unparseable += 1
            continue
        for criterion, bounds in case.expected.items():
            got = verdict.scores[criterion].score if criterion in verdict.scores else None
            if bounds is not None:
                report.expected += 1
            if bounds is None or got is None:
                if (bounds is None) != (got is None):
                    report.na_mismatch += 1
                continue
            low, high = bounds
            entry = report.by_criterion.setdefault(criterion, [0, 0])
            entry[1] += 1
            report.compared += 1
            if low <= got <= high:
                report.in_range += 1
                entry[0] += 1
            else:
                report.distance += low - got if got < low else got - high
    return report
