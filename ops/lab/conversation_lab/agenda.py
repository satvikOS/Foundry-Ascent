"""Suite ``agenda``: does the vEIR help with what the founder asks, or steer every conversation back to the one
open commitment in its notebook? (The owner's production calls, 2026-10-16…20: the notebook held one past-dated
commitment, "book the regulatory and reimbursement advisor session and prepare three questions", and every call
came back to it; "I don't know. You tell me." got the same question again; spoken replies were one-sentence
fragments starting "So the …"; a commitment from a week before was "still open".)

Synthetic only: two lab ventures with that notebook (packages/db lab-agenda-ventures.ts), one talked to in typed
conversations and one on calls, three remembered conversations each with fixed founder lines
(``scenarios/agenda.json``). Every reply is checked deterministically; each conversation is also judged.
Public output: counts, rates and codes. The conversations themselves go to the sealed private folder.

The owner's call of 2026-11-07 (AG-4; the opener checks of every conversation): a returning founder heard "Nice to see
you. What feels most pressing right now?" though the notebook held open threads; a goal got a question; a vague answer
got a question; "I don't know" and "I didn't do that" got the first question again in other words; and the notebook
gained a note judging the founder. So: an opener with the notebook's threads open names one and offers help; no reply
asks again on a question's subject after the founder said they have no answer; no profile note judges them.
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

from conversation_lab.live.checks import put_to_student, same_subject

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
#: An opener's offer of help (the product's distill/sanitize.ts ``HELP_OFFER``): a first-person frame, or a "want...?"
#: put to the founder, with a help verb within a few words of it (a help word alone is no offer: "Did the advisor help
#: you settle the device class?"), and the notebook's threads it may name (the suite's venture: a regulated sleeve).
_HELP_VERB = (
    r"(?:help|prepare|prep|walk (?:you )?through|draft|get (?:you |it |that )?ready|work through|go through|"
    r"run through|put together|map out|sketch out|lay out|rehearse|practi[sc]e)"
)
_OFFER_FRAME = (
    r"(?:i can|i could|i'll|i will|i'd (?:like|love|be (?:glad|happy)) to|let me|let's|lets|we can|we could|"
    r"shall (?:i|we)|should (?:i|we)|(?:do you |would you )?(?:want|like) (?:me|us) to|(?:do you )?want|would you like|"
    r"(?:happy|glad|ready|here) to|how about (?:i|we))"
)
OPENER_HELP = re.compile(rf"\b{_OFFER_FRAME}\b(?:\s+[\w'-]+){{0,4}}?\s+{_HELP_VERB}\b", re.IGNORECASE)
OPENER_THREAD = re.compile(
    r"\b(?:advis[oe]r|device|class\w*|reimburs\w*|clinic\w*|regulat\w*|billing|pay\w*|sleeve|pitch|cofounder|budget)\b",
    re.IGNORECASE,
)
#: An offer to carry on the conversation that just ended (the product's continuity-prompt.ts ``continuationOpeners``,
#: said only to the first conversation opened within three hours of one not distilled yet: lab run 42457618242). It
#: names that conversation rather than a thread of the notebook, which it may have settled or moved on from.
OPENER_CARRIES_ON = re.compile(r"\b(?:where we (?:just )?left off|from there)\b", re.IGNORECASE)
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
    #: After the founder said they have no answer (``unknown``), a question back on an earlier question's subject.
    reask_after_unknown: bool
    stale: bool
    follows_up: bool
    opening: str
    so_opening: bool

    def public(self) -> dict[str, Any]:
        return dict(self.__dict__)


def check_reply(
    reply: str, turn: Mapping[str, Any], index: int, earlier_questions: Sequence[str]
) -> tuple[ReplyCheck, list[str]]:
    """One reply's checks, and the questions it asked the founder (for the re-ask check of later replies). A question
    in a line the vEIR wrote for the founder to say or send (inside a quotation, however many sentences it runs and
    however it closes: '...in what order?".'; or under "Ask your advisor:") is not asked of them (the product's
    validators/social.ts ``putToFounder``; lab run 42457618242 counted one as a re-ask after a no-answer)."""
    said = sentences(reply)
    asked = [s for s in said if s.endswith("?") and put_to_student(reply or "", s)]
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
            reask_after_unknown=bool(turn.get("unknown"))
            and any(same_subject(q, e, strict=True) for q in asked for e in earlier_questions),
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
    #: The notebook as it stood just before this conversation (nextOpener, nextTopic, commitments, open questions).
    notebook_before: dict[str, Any] | None = None
    #: The founder's lines took up what the opener raised (the commitment, or the opener's own topic words).
    founder_took_up_opener: bool | None = None
    opener_reopens: bool = False
    opener_stale: bool = False
    #: The notebook held open threads before the conversation and the opener named none or offered no help.
    opener_bare: bool = False
    #: Founder-profile notes judging the founder in the notebook after the conversation (count; the notes are private).
    judgmental_notes: int = 0
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
            if c.reask_after_unknown:
                out.append(f"t{c.turn}:reask_after_unknown")
            if c.stale:
                out.append(f"t{c.turn}:stale_commitment")
            if c.raises and not c.follows_up:
                out.append(f"t{c.turn}:no_follow_up")
        if self.opener_stale:
            out.append("opener:stale_commitment")
        if self.opener_bare:
            out.append("opener:no_thread_or_help")
        if self.judgmental_notes > 0:
            out.append("notebook:judgmental_profile_note")
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
            "founderTookUpOpener": self.founder_took_up_opener,
            "notebookBefore": None
            if self.notebook_before is None
            else {
                "version": self.notebook_before.get("version"),
                "hasNextTopic": bool(self.notebook_before.get("nextTopic")),
                "openCommitments": sum(
                    1 for c in self.notebook_before.get("commitments") or [] if c.get("status") == "open"
                ),
            },
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
            "notebookBefore": self.notebook_before,
            "verdict": self.verdict,
        }


def _notes(detail: Mapping[str, Any]) -> list[str]:
    validator = detail.get("validator") or {}
    notes = validator.get("notes") if isinstance(validator, Mapping) else None
    return [str(n) for n in notes or [] if isinstance(n, str) and re.fullmatch(r"[a-z0-9_:.-]{1,80}", n)]


def took_up(opener: str, founder_lines: Sequence[str]) -> bool:
    """The founder's lines take up the opener: they name the commitment, or share two content words with it."""
    said = " ".join(founder_lines)
    if AGENDA_TERMS.search(opener) and re.search(
        r"\b(?:advis[oe]r|session|questions)\b", said, re.IGNORECASE
    ):
        return True
    return len(_content(opener) & _content(said)) >= 2


def offers_help(opener: str) -> bool:
    """The product's ``offersHelp``: an offer of help (``OPENER_HELP``), and no closing question that offers none."""
    text = opener.replace("\u2019", "'").replace("\u2018", "'")
    if not OPENER_HELP.search(text):
        return False
    last = ([s.strip() for s in _SENTENCE.split(text.strip()) if s.strip()] or [""])[-1]
    return not last.endswith("?") or bool(OPENER_HELP.search(last))


def grade_conversation(result: ConversationResult, conversation: Mapping[str, Any]) -> None:
    earlier: list[str] = [s for s in sentences(result.opener) if s.endswith("?")]
    result.opener_reopens = bool(AGENDA_TERMS.search(result.opener))
    result.opener_stale = bool(STALE.search(result.opener))
    before = result.notebook_before or {}
    threads = any(c.get("status") == "open" for c in before.get("commitments") or []) or bool(
        before.get("openQuestions")
    )
    result.opener_bare = (
        threads
        and result.opener != ""
        and not (
            offers_help(result.opener)
            and (OPENER_THREAD.search(result.opener) or OPENER_CARRIES_ON.search(result.opener))
        )
    )
    result.founder_took_up_opener = took_up(result.opener, [f for f, _ in result.turns])
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
            "reasksAfterUnknown": sum(1 for c in checks if c.reask_after_unknown),
            "openersWithoutThreadOrHelp": sum(1 for r in rs if r.opener_bare),
            "judgmentalProfileNotes": sum(r.judgmental_notes for r in rs),
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
    from conversation_lab.live.checks import judgmental_notes
    from conversation_lab.smoke import turn_detail
    from foundry_evals.client import ApiError, ApiUnreachableError

    voice = channel == "call"
    out: list[ConversationResult] = []
    for conversation in conversations:
        reserve(len(conversation["turns"]))
        result = ConversationResult(id=f"{conversation['id']}-{channel}", channel=channel)
        result.notebook_before = _notebook(client, venture_id)
        # New chat previews the opener (a link's hover: nothing is written) and, once open, has a missing line written;
        # a call started from there finds it (a call's start never waits for the writer).
        with contextlib.suppress(Exception):
            if client.request("GET", f"/ventures/{venture_id}/opener").json().get("missing") is True:
                client.request("POST", f"/ventures/{venture_id}/opener")
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
        # The next conversation meets this one distilled (its digest and notebook), as a founder calling back would:
        # wait until the notebook's version moves (or a minute: a short conversation may not be distilled).
        before = (result.notebook_before or {}).get("version")
        waited = 0.0
        sleep(min(pause_seconds, 5.0))
        while waited < 60.0:
            now = (_notebook(client, venture_id) or {}).get("version")
            if before is None or (now is not None and now != before):
                break
            sleep(3.0)
            waited += 3.0
        # What the distillation wrote of the founder: how they like to work, never a verdict on them.
        profile = [
            str(e.get("text", ""))
            for e in (_notebook(client, venture_id) or {}).get("founderProfile") or []
            if isinstance(e, Mapping)
        ]
        result.judgmental_notes = len(judgmental_notes(profile))
    return out


def _notebook(client: Any, venture_id: str) -> dict[str, Any] | None:
    """The notebook's raw view (nextOpener, nextTopic, commitments, openQuestions, version); None if unreadable."""
    try:
        response = client.request("GET", f"/ventures/{venture_id}/notebook")
        data = response.json()
    except Exception:  # noqa: BLE001 - a diagnostic read never fails the run
        return None
    if not isinstance(data, dict):
        return None
    keys = (
        "version",
        "updatedAt",
        "nextOpener",
        "nextTopic",
        "commitments",
        "openQuestions",
        "summary",
        "founderProfile",
    )
    return {k: data.get(k) for k in keys}


def load(path: Path = SCENARIOS) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
