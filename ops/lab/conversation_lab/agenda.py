"""Suite ``agenda``: does the vEIR help with what the founder asks, or steer every conversation back to the one
open commitment in its notebook? (The owner's production calls, 2026-10-16…20: the notebook held one past-dated
commitment, "book the regulatory and reimbursement advisor session and prepare three questions", and every call
came back to it; "I don't know. You tell me." got the same question again; spoken replies were one-sentence
fragments starting "So the …"; a commitment from a week before was "still open".)

Synthetic only: two lab ventures with that notebook (packages/db lab-agenda-ventures.ts), one talked to in typed
conversations and one on calls, three remembered conversations each with fixed founder lines
(``scenarios/agenda.json``). Every reply is checked deterministically; each conversation is also judged.
Public output: counts, rates and codes. The conversations themselves go to the sealed private folder.
"""

from __future__ import annotations

import contextlib
import json
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCENARIOS = Path(__file__).resolve().parent.parent / "scenarios" / "agenda.json"

#: The commitment itself (the advisor session, its three questions, booking it): a reply naming it on a turn about
#: something else steers back to it. Regulation or reimbursement as content is not the commitment.
AGENDA_TERMS = re.compile(
    r"\b(?:advisor|adviser) (?:session|meeting|call)\b|\bthree questions\b|"
    r"\bbook (?:the|that|your|an?) (?:advisor |adviser )?session\b",
    re.IGNORECASE,
)
#: The commitment described as still pending although it was due days ago (or the founder already did it).
STALE = re.compile(
    r"\bstill (?:open|outstanding|pending|on your (?:list|plate))\b|\bhaven'?t (?:yet )?booked\b|"
    r"\bstill need to book\b|\bnot (?:yet )?booked\b|\bis (?:now )?overdue\b",
    re.IGNORECASE,
)
#: Following up on something the founder did ("I met the advisor last week").
FOLLOW_UP = re.compile(
    r"\bhow (?:did|was) (?:it|that|the (?:session|meeting|call))\b|\bhow did (?:it|that) go\b|"
    r"\bwhat did (?:they|the advisor|she|he|you) (?:say|tell|suggest|recommend|learn)\b|\bwhat came out of\b|"
    r"\bwhat did you (?:take away|find out|learn)\b|\bhow'?d (?:it|that) go\b",
    re.IGNORECASE,
)
#: Sending the founder to book the session again after they said it happened.
BOOK_AGAIN = re.compile(
    r"\bbook (?:the|that|your|an?) (?:advisor |adviser )?(?:session|meeting|call)\b", re.IGNORECASE
)
_SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")
_LIST_ITEM = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+\S", re.MULTILINE)
_WORD = re.compile(r"[a-z0-9']+")
_STOP = frozenset(
    [
        "a",
        "an",
        "the",
        "and",
        "or",
        "but",
        "to",
        "of",
        "in",
        "on",
        "for",
        "with",
        "at",
        "by",
        "from",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "it",
        "its",
        "this",
        "that",
        "these",
        "those",
        "you",
        "your",
        "i",
        "we",
        "our",
        "me",
        "my",
        "do",
        "does",
        "did",
        "what",
        "which",
        "who",
        "how",
        "when",
        "why",
        "can",
        "could",
        "would",
        "should",
        "will",
        "just",
        "so",
    ]
)


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text or "") if len(_WORD.findall(s.lower())) >= 4]


def _content(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 2}


def _similar(a: str, b: str) -> bool:
    """The same question in other words: most of the shorter question's content words are in the other."""
    x, y = _content(a), _content(b)
    if len(x) < 3 or len(y) < 3:
        return False
    return len(x & y) / min(len(x), len(y)) >= 0.6


@dataclass
class ReplyCheck:
    """What one reply did, as booleans and counts (no text)."""

    turn: int
    topic: str
    help: bool
    raises: bool
    sentences: int
    statements: int
    questions: int
    list_items: int
    substance: bool
    question_back_only: bool
    steer_back: bool
    reask: bool
    stale: bool
    follows_up: bool
    opening: str
    so_opening: bool

    def public(self) -> dict[str, Any]:
        return dict(self.__dict__)


def check_reply(
    reply: str, turn: Mapping[str, Any], index: int, earlier_questions: Sequence[str]
) -> tuple[ReplyCheck, list[str]]:
    """One reply's checks, and the questions it asked (for the re-ask check of later replies)."""
    said = sentences(reply)
    asked = [s for s in said if s.endswith("?")]
    statements = [s for s in said if not s.endswith("?")]
    items = len(_LIST_ITEM.findall(reply or ""))
    marks = (reply or "").count("?")
    substance = len(statements) >= 2 or items >= 2 or marks >= 3
    words = _WORD.findall((reply or "").lower())
    opening = " ".join(words[:2])
    return (
        ReplyCheck(
            turn=index,
            topic=str(turn.get("topic", "other")),
            help=bool(turn.get("help")),
            raises=bool(turn.get("raises")),
            sentences=len(said),
            statements=len(statements),
            questions=len(asked),
            list_items=items,
            substance=substance,
            question_back_only=bool(said) and not statements and items < 2 and marks <= 2,
            steer_back=turn.get("topic") == "other" and bool(AGENDA_TERMS.search(reply or "")),
            reask=any(_similar(q, e) for q in asked for e in earlier_questions),
            stale=bool(STALE.search(reply or "")),
            follows_up=bool(FOLLOW_UP.search(reply or "")),
            opening=opening,
            so_opening=bool(re.match(r"\s*so\b", reply or "", re.IGNORECASE)),
        ),
        asked,
    )


@dataclass
class ConversationResult:
    id: str
    channel: str
    opener: str = ""
    turns: list[tuple[str, str]] = field(default_factory=list)
    checks: list[ReplyCheck] = field(default_factory=list)
    #: Per turn: the structured answer, the spoken reply and units, validator notes, phases, model (private).
    details: list[dict[str, Any]] = field(default_factory=list)
    opener_reopens: bool = False
    opener_stale: bool = False
    error: str | None = None
    verdict: dict[str, Any] | None = None

    @property
    def failures(self) -> list[str]:
        """The deterministic failures, as codes."""
        out: list[str] = []
        for c in self.checks:
            if c.help and not c.substance:
                out.append(f"t{c.turn}:no_substance")
            if c.help and c.question_back_only:
                out.append(f"t{c.turn}:question_back_only")
            if c.steer_back:
                out.append(f"t{c.turn}:steer_back")
            if c.reask:
                out.append(f"t{c.turn}:reask")
            if c.stale:
                out.append(f"t{c.turn}:stale_commitment")
            if c.raises and not c.follows_up:
                out.append(f"t{c.turn}:no_follow_up")
        if self.opener_stale:
            out.append("opener:stale_commitment")
        return out

    @property
    def passed(self) -> bool:
        judged = self.verdict is None or self.verdict.get("expectation_met") is not False
        return self.error is None and not self.failures and judged

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "channel": self.channel,
            "passed": self.passed,
            "failures": self.failures,
            "error": self.error,
            "openerReopensCommitment": self.opener_reopens,
            "checks": [c.public() for c in self.checks],
            # Codes only: what the validators did to each reply (e.g. repeated_sentences_removed:2).
            "notes": [_notes(d) for d in self.details],
            "judge": None
            if self.verdict is None
            else {k: self.verdict.get(k) for k in ("scores", "expectation_met", "error")},
        }

    def private(self) -> dict[str, Any]:
        return {
            **self.public(),
            "opener": self.opener,
            "transcript": self.turns,
            "details": self.details,
            "verdict": self.verdict,
        }


def _notes(detail: Mapping[str, Any]) -> list[str]:
    validator = detail.get("validator") or {}
    notes = validator.get("notes") if isinstance(validator, Mapping) else None
    return [str(n) for n in notes or [] if isinstance(n, str) and re.fullmatch(r"[a-z0-9_:.-]{1,80}", n)]


def grade_conversation(result: ConversationResult, conversation: Mapping[str, Any]) -> None:
    earlier: list[str] = [s for s in sentences(result.opener) if s.endswith("?")]
    result.opener_reopens = bool(AGENDA_TERMS.search(result.opener))
    result.opener_stale = bool(STALE.search(result.opener))
    result.checks = []
    done = False  # the founder said the commitment happened
    for index, ((_, reply), turn) in enumerate(
        zip(result.turns, conversation["turns"], strict=False), start=1
    ):
        check, asked = check_reply(reply, turn, index, earlier)
        if done and BOOK_AGAIN.search(reply or ""):
            check.stale = True
        done = done or bool(turn.get("raises"))
        result.checks.append(check)
        earlier += asked


def summarize(results: Sequence[ConversationResult]) -> dict[str, Any]:
    """Counts and rates per channel and overall (numbers only)."""

    def block(rs: Sequence[ConversationResult]) -> dict[str, Any]:
        checks = [c for r in rs for c in r.checks]
        help_ = [c for c in checks if c.help]
        other = [c for c in checks if c.topic == "other"]
        openings = [c.opening for c in checks if c.opening]
        raises = [c for c in checks if c.raises]
        judged = [r.verdict for r in rs if r.verdict and not r.verdict.get("error")]

        def mean_score(key: str) -> float | None:
            values = [v["scores"].get(key) for v in judged if isinstance(v.get("scores", {}).get(key), int)]
            return round(sum(values) / len(values), 2) if values else None

        return {
            "conversations": len(rs),
            "passed": sum(1 for r in rs if r.passed),
            "replies": len(checks),
            "helpTurns": len(help_),
            "substanceOnRequest": sum(1 for c in help_ if c.substance),
            "questionBackOnly": sum(1 for c in help_ if c.question_back_only),
            "fragmentsOnRequest": sum(1 for c in help_ if c.statements < 2 and c.list_items < 2),
            "otherTopicTurns": len(other),
            "steerBack": sum(1 for c in other if c.steer_back),
            "reasks": sum(1 for c in checks if c.reask),
            "staleMentions": sum(1 for c in checks if c.stale) + sum(1 for r in rs if r.opener_stale),
            "followUpWhenRaised": f"{sum(1 for c in raises if c.follows_up)}/{len(raises)}",
            "openersReopeningCommitment": sum(1 for r in rs if r.opener_reopens),
            "soOpenings": sum(1 for c in checks if c.so_opening),
            "distinctOpenings": f"{len(set(openings))}/{len(openings)}",
            "judgeExpectationMet": f"{sum(1 for v in judged if v.get('expectation_met'))}/{len(judged)}",
            "judgeAnswersTheRequest": mean_score("answers_the_actual_request"),
            "judgeFollowsTopic": mean_score("follows_topic_changes"),
            "judgeFeltHeard": mean_score("felt_heard"),
        }

    channels = sorted({r.channel for r in results})
    return {"all": block(results), **{c: block([r for r in results if r.channel == c]) for c in channels}}


def run_channel(
    *,
    client: Any,
    venture_id: str,
    channel: str,
    conversations: Sequence[Mapping[str, Any]],
    heard: Callable[[Any, bool], str],
    judge: Any | None,
    founder_context: str,
    reserve: Callable[[int], None],
    pause_seconds: float = 20.0,
    sleep: Callable[[float], None] = time.sleep,
) -> list[ConversationResult]:
    """Plays the conversations in order as remembered conversations (each ends, so the next one meets it)."""
    from conversation_lab.judge import transcript_text
    from conversation_lab.smoke import turn_detail
    from foundry_evals.client import ApiError, ApiUnreachableError

    voice = channel == "call"
    out: list[ConversationResult] = []
    for conversation in conversations:
        reserve(len(conversation["turns"]))
        result = ConversationResult(id=f"{conversation['id']}-{channel}", channel=channel)
        session = client.create_session(venture_id, mode="coach", privacy="standard")
        result.opener = session.opener or ""
        call_id: str | None = None
        try:
            if voice:
                started = client.start_call(session.id)
                call_id = started.call.id
                if started.intro is not None:
                    result.opener = started.intro.text
            for turn in conversation["turns"]:
                try:
                    outcome = client.run_turn(session.id, turn["say"], call_id=call_id)
                except (ApiError, ApiUnreachableError) as exc:
                    result.error = getattr(exc, "code", "unreachable")
                    break
                result.turns.append((turn["say"], heard(outcome, voice)))
                result.details.append(turn_detail(outcome))
                if outcome.kind == "error":
                    result.error = outcome.error_code or "turn_error"
                    break
        finally:
            if call_id is not None:
                with contextlib.suppress(ApiError, ApiUnreachableError):
                    client.end_call(call_id)
            with contextlib.suppress(ApiError, ApiUnreachableError):
                client.end_session(session.id)
        grade_conversation(result, conversation)
        if judge is not None and result.error is None and result.turns:
            verdict = judge.grade(
                founder_context=founder_context,
                expectation=conversation["expect"],
                transcript=transcript_text(result.turns, channel),
            )
            result.verdict = {
                "scores": verdict.scores,
                "expectation_met": verdict.expectation_met,
                "rationale": verdict.rationale,
                "error": verdict.error,
            }
        out.append(result)
        # The next conversation meets this one distilled (its digest and notebook), as a founder calling back would.
        sleep(pause_seconds)
    return out


def load(path: Path = SCENARIOS) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
