"""Conversation craft: does the vEIR talk like an exceptional human mentor across turns and sessions?

Deterministic checks over what the founder saw and heard (answers, spoken replies, speech units, call intros),
grounded in the conversation-craft doctrine (packages/ai/src/prompts/craft.ts) and the w4-human research brief:

=========================  =============================================================  ========
Code                       What it catches                                                Severity
=========================  =============================================================  ========
recall_missing             "do you remember…?" answered without the last conversation's   high
                           topic (the owner's failure: the second call forgot the first)
recall_invented            a past conversation claimed where the founder had none          high
topic_not_resumed          "where were we?" answered without the parked thread             medium
repeated_opening           two sessions (or two consecutive replies) open the same way     medium
stock_opener               a canned opener ("Great question", "Absolutely", …)              medium
generic_praise             empty praise anywhere ("great question", "love that")           low
stacked_questions          more than one question in a reply                               medium
always_asks                every reply of a conversation (3+) ends with a question         low
social_turn_report         thanks / a wrap-up answered with next steps, claims or a        medium
                           memory proposal, or a wrap-up answered with a new question
spoken_markup              Markdown, list markers, citation keys or URLs in speech         medium
spoken_too_long            a spoken reply over 70 words                                    medium
=========================  =============================================================  ========

Findings carry codes, locations and turn numbers only, never content.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from itertools import pairwise

from foundry_evals.graders.base import Finding, Severity
from foundry_evals.models import TurnView
from foundry_evals.text import normalize, sentences, words

GRADER = "conversation"

#: Canned openers the doctrine forbids (lower-case, matched at the start of a reply).
STOCK_OPENERS: tuple[str, ...] = (
    "great question",
    "good question",
    "what a great question",
    "absolutely",
    "certainly",
    "i hear you",
    "here's my honest read",
    "here’s my honest read",
    "as an ai",
    "thanks for sharing",
    "thank you for sharing",
    "i understand your concern",
)
GENERIC_PRAISE = re.compile(
    r"\b(?:great|excellent|fantastic|amazing|wonderful) (?:question|point|idea|thinking)\b|\blove (?:that|this)\b",
    re.IGNORECASE,
)
SPOKEN_MARKUP = re.compile(
    r"(?:\*\*|__|^\s*#{1,6}\s|^\s*(?:[-*+•]|\d+[.)])\s+\S|\[\s*E\d+|https?://|`)", re.MULTILINE
)
SPOKEN_MAX_WORDS = 70
OPENING_WORDS = 4

#: How a reply admits there is nothing from before (for "do you remember…?" with no history).
NOTHING_BEFORE = re.compile(
    r"\b(?:first (?:conversation|time we|chat|call)|(?:don't|do not|can't|cannot) (?:have|see|find) "
    r"(?:anything|any notes?|a record)|nothing (?:from|yet|before)|haven't (?:talked|spoken) before)\b",
    re.IGNORECASE,
)


@dataclass
class ConversationReply:
    """One reply of the vEIR as the founder got it, with what the case expects of it."""

    session: int
    turn: int
    #: 1-based turn number within the whole case (finding locations).
    case_turn: int
    answer: str
    spoken: str | None = None
    #: Speech units heard on a call (joined), or None for typed turns.
    speech: str | None = None
    next_actions: int = 0
    claims: int = 0
    memory_candidates: int = 0
    check: str | None = None
    expect_any: tuple[str, ...] = ()
    voice: bool = False

    @property
    def heard(self) -> str:
        """Everything the founder read or heard of the reply."""
        return " ".join(t for t in (self.answer, self.spoken, self.speech) if t)


@dataclass
class ConversationGrade:
    findings: list[Finding] = field(default_factory=list)
    recall_checked: int = 0
    recall_passed: int = 0
    resume_checked: int = 0
    resume_passed: int = 0


def reply_of(
    turn: TurnView | None,
    *,
    session: int,
    index: int,
    case_turn: int,
    speech: Sequence[str] = (),
    check: str | None = None,
    expect_any: Sequence[str] = (),
    voice: bool = False,
) -> ConversationReply | None:
    if turn is None or turn.response is None:
        return None
    r = turn.response
    return ConversationReply(
        session=session,
        turn=index,
        case_turn=case_turn,
        answer=r.answer,
        spoken=r.spoken,
        speech=" ".join(u.strip() for u in speech if u.strip()) or None,
        next_actions=len(r.next_actions),
        claims=len(r.claims),
        memory_candidates=len(r.memory_candidates),
        check=check,
        expect_any=tuple(expect_any),
        voice=voice,
    )


#: The AI disclosure a call intro must open with ("Hi Maya, this is Corin's vEIR, an AI coach."): the same in
#: every call by design, so openings are compared after it.
DISCLOSURE_SENTENCE = re.compile(r"\ban ai (?:coach|mentor)\b|\bai\b.*\bnot a person\b", re.IGNORECASE)


def opening_of(text: str, n: int = OPENING_WORDS) -> str:
    """The first ``n`` words of how something opens, after a leading AI-disclosure sentence."""
    parts = sentences(text)
    while len(parts) > 1 and DISCLOSURE_SENTENCE.search(parts[0]):
        parts = parts[1:]
    return " ".join(words(" ".join(parts))[:n])


def question_count(text: str) -> int:
    return sum(1 for s in sentences(text) if s.rstrip("\"'”’)").endswith("?"))


def ends_with_question(text: str) -> bool:
    parts = sentences(text)
    return bool(parts) and parts[-1].rstrip("\"'”’)").endswith("?")


def mentions_any(text: str, needles: Sequence[str]) -> bool:
    hay = normalize(text)
    return any(normalize(n) in hay for n in needles if n.strip())


def _finding(code: str, severity: Severity, message: str, reply: ConversationReply, location: str) -> Finding:
    return Finding(GRADER, code, severity, message, location=location, turn=reply.case_turn)


def grade_reply(reply: ConversationReply) -> list[Finding]:
    """The checks that apply to every reply on its own."""
    out: list[Finding] = []
    first = normalize(reply.answer)
    stock = next((s for s in STOCK_OPENERS if first.startswith(s)), None)
    if stock is not None:
        out.append(_finding("stock_opener", Severity.MEDIUM, "canned opener", reply, "answer"))
    elif GENERIC_PRAISE.search(reply.answer):
        out.append(_finding("generic_praise", Severity.LOW, "generic praise", reply, "answer"))
    if question_count(reply.answer) > 1:
        out.append(
            _finding(
                "stacked_questions",
                Severity.MEDIUM,
                f"{question_count(reply.answer)} questions in one reply",
                reply,
                "answer",
            )
        )
    if reply.check in ("social", "closing"):
        if reply.next_actions or reply.claims or reply.memory_candidates:
            out.append(
                _finding(
                    "social_turn_report",
                    Severity.MEDIUM,
                    "a social turn answered with next steps, claims or memory proposals",
                    reply,
                    "response",
                )
            )
        elif reply.check == "closing" and ends_with_question(reply.answer):
            out.append(
                _finding(
                    "social_turn_report",
                    Severity.MEDIUM,
                    "a wrap-up answered with a new question",
                    reply,
                    "answer",
                )
            )
    if reply.voice:
        for location, text in (("spoken", reply.spoken), ("speech", reply.speech)):
            if not text:
                continue
            if SPOKEN_MARKUP.search(text):
                out.append(_finding("spoken_markup", Severity.MEDIUM, "markup said aloud", reply, location))
            if len(words(text)) > SPOKEN_MAX_WORDS:
                out.append(
                    _finding(
                        "spoken_too_long",
                        Severity.MEDIUM,
                        f"{len(words(text))} words spoken (max {SPOKEN_MAX_WORDS})",
                        reply,
                        location,
                    )
                )
    return out


def grade_conversation(
    replies: Sequence[ConversationReply],
    *,
    openings: Sequence[tuple[int, str]] = (),
    had_history: bool = True,
) -> ConversationGrade:
    """Grades a whole case: every reply, then recall, topic return, openings and question habits.

    ``openings`` are (session, text) of how each session opened (a call's intro, else its first reply).
    ``had_history`` is False when the founder had no earlier conversation: recall must then say so.
    """
    grade = ConversationGrade()
    for reply in replies:
        grade.findings += grade_reply(reply)
        if reply.check == "recall":
            grade.recall_checked += 1
            ok = (
                mentions_any(reply.heard, reply.expect_any)
                if had_history or reply.session > 1
                else bool(NOTHING_BEFORE.search(reply.heard))
            )
            if ok:
                grade.recall_passed += 1
            elif had_history or reply.session > 1:
                grade.findings.append(
                    _finding(
                        "recall_missing",
                        Severity.HIGH,
                        "the reply did not name what the last conversation was about",
                        reply,
                        "answer",
                    )
                )
            else:
                grade.findings.append(
                    _finding(
                        "recall_invented",
                        Severity.HIGH,
                        "a past conversation was implied where there was none",
                        reply,
                        "answer",
                    )
                )
        if reply.check == "topic_return":
            grade.resume_checked += 1
            if mentions_any(reply.heard, reply.expect_any):
                grade.resume_passed += 1
            else:
                grade.findings.append(
                    _finding(
                        "topic_not_resumed",
                        Severity.MEDIUM,
                        "the parked thread was not named",
                        reply,
                        "answer",
                    )
                )

    # Sessions never open alike.
    seen: dict[str, int] = {}
    for session, text in openings:
        head = opening_of(text)
        if not head:
            continue
        if head in seen and seen[head] != session:
            grade.findings.append(
                Finding(
                    GRADER,
                    "repeated_opening",
                    Severity.MEDIUM,
                    f"session {session} opened like session {seen[head]}",
                    location="opening",
                )
            )
        seen.setdefault(head, session)

    # Within a session: consecutive replies that open alike, and replies that always end with a question.
    by_session: dict[int, list[ConversationReply]] = {}
    for reply in replies:
        by_session.setdefault(reply.session, []).append(reply)
    for session, items in by_session.items():
        for before, after in pairwise(items):
            a, b = opening_of(before.answer, 3), opening_of(after.answer, 3)
            if a and a == b:
                grade.findings.append(
                    _finding(
                        "repeated_opening",
                        Severity.MEDIUM,
                        f"two replies in session {session} open the same way",
                        after,
                        "answer",
                    )
                )
        if len(items) >= 3 and all(ends_with_question(r.answer) for r in items):
            grade.findings.append(
                Finding(
                    GRADER,
                    "always_asks",
                    Severity.LOW,
                    f"all {len(items)} replies of session {session} end with a question",
                    location="answer",
                )
            )
    return grade
