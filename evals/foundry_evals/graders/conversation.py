"""Conversation craft: does the vEIR talk like an exceptional human mentor across turns and sessions?

Deterministic checks over what the founder saw and heard (answers, spoken replies, speech units, call intros),
grounded in the conversation-craft doctrine (packages/ai/src/prompts/craft.ts), the w4-human research brief and
production's transcripts (Oct 6-16: recall recited seeded notes, answers repeated each other, spoken replies
stopped mid-thought, a mode name and claim lines leaked into a call transcript):

=========================  =============================================================  ========
Code                       What it catches                                                Severity
=========================  =============================================================  ========
recall_missing             "do you remember…?" answered without the last conversation's   high
                           topic (the owner's failure: the second call forgot the first)
recall_invented            a past conversation claimed where the founder had none, or     high
                           older notes / venture facts recited as "last time"
recall_unanswered          a "do you remember…?" turn that got no reply (blocked)          high
structured_leak            a mode name, field names or claim lines in what was shown or    high
                           said (the reply ran past its end into the structured fields),
                           or the model thinking aloud about its prompt ("The founder
                           says…", "I need to figure out the mode", "According to the
                           rules…"; LAB-M1, a call spoke it)
identity_undisclosed       "are you a man or a woman?" answered without saying it is an AI high
topic_not_resumed          "where were we?" answered without the parked thread             medium
topic_unanswered           a "where were we?" turn that got no reply                       medium
social_unanswered          a thanks / greeting / wrap-up turn that got no reply            medium
identity_boilerplate       an identity question answered with the full legal disclosure    medium
request_ignored            the request asked alongside an identity question not answered   medium
repeated_opening           two sessions (or two consecutive replies) open the same way     medium
repeated_reply             a reply mostly repeats the one before it (4-word sequences)      medium
repeated_question          the same question asked twice in a conversation (or the next)   medium
stock_opener               a canned opener ("Great question", "I see", "I remember", …)     medium
generic_praise             empty praise anywhere ("great question", "love that")           low
stacked_questions          more than one question in a reply                               medium
always_asks                every reply of a conversation (3+) ends with a question         low
social_turn_report         thanks / a wrap-up answered with next steps, claims or a        medium
                           memory proposal, or a wrap-up answered with a new question
opener_repeated            a hello right after the vEIR's opening line answered with what  medium
                           that line already said ("we were on pricing" again)
opener_reasked             a hello right after the opening line answered with a question   medium
                           (its question again, or another one stacked on it)
opener_missing             an ``after_opener`` turn whose session opened with no line      medium
                           (nothing picked up the last conversation)
spoken_markup              Markdown, list markers, citation keys or URLs in speech         medium
spoken_too_long            a spoken reply over 70 words                                    medium
spoken_no_handback         a call reply that stops without handing the turn back           medium
transcript_citation        evidence keys ([E2]) in a call's transcript                     medium
=========================  =============================================================  ========

Reply to the opener (``after_opener``): production's integration showed "Last time you planned to call
facilities… How did it go?" followed, after the founder's "Hi!", by "When we talked a moment ago, we were on
pricing." A hello back must be a hello: no recall phrase, no four-word run of the opening line, no question.

Expectations (``expect_any``, ``forbid_any``) match whole words or phrases, case-insensitively; a term ending in
``*`` matches words that start with it ("pric*": price, pricing). Findings carry codes, locations and turn numbers
only, never content.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from itertools import pairwise

from foundry_evals.graders.base import Finding, Severity
from foundry_evals.models import COACH_MODES, TurnView
from foundry_evals.text import mentions_any, normalize, sentences, words

GRADER = "conversation"

#: Canned openers the doctrine forbids (lower-case, matched as whole words at the start of a reply). Production
#: opened 7 of 12 answers with "I see", "I hear", "I understand you're asking" or "I remember".
STOCK_OPENERS: tuple[str, ...] = (
    "great question",
    "good question",
    "what a great question",
    "absolutely",
    "certainly",
    "i hear you",
    "i hear",
    "i see",
    "i understand you're asking",
    "i understand you’re asking",
    "i understand that",
    "i understand your concern",
    "i remember",
    "it sounds like",
    "here's my honest read",
    "here’s my honest read",
    "as an ai",
    "thanks for sharing",
    "thank you for sharing",
    # The conversation lab (wave 6): "Great news, Maya." / "Great, Maya." opened three replies in a row, and "Good to
    # talk again." twice right after the call's greeting had said it (craft.ts STOCK_OPENERS names both).
    "great",
    "good to talk again",
)
STOCK_OPENER = re.compile(r"^(?:" + "|".join(re.escape(s) for s in STOCK_OPENERS) + r")\b")
GENERIC_PRAISE = re.compile(
    r"\b(?:great|excellent|fantastic|amazing|wonderful) (?:question|point|idea|thinking)\b|\blove (?:that|this)\b",
    re.IGNORECASE,
)
SPOKEN_MARKUP = re.compile(
    r"(?:\*\*|__|^\s*#{1,6}\s|^\s*(?:[-*+•]|\d+[.)])\s+\S|\[\s*E\d+|https?://|`)", re.MULTILINE
)
CITATION_KEY = re.compile(r"\[\s*E\d+", re.IGNORECASE)
SPOKEN_MAX_WORDS = 70
#: How a reply says the last conversation again ("When we talked a moment ago, we were on pricing.").
RECALL_AGAIN = re.compile(
    r"\b(?:last time|when we (?:last )?(?:talked|spoke)|we were on|where we left off|you were going to|"
    r"you planned to|our last (?:conversation|call|chat))\b",
    re.IGNORECASE,
)
#: Words that make an opening: a shared formula with new specifics ("Last time you planned to …") is not a
#: repeat; the same greeting line is.
OPENING_WORDS = 6
#: A reply repeats the one before it when this share of its four-word sequences was already said there
#: (production: 46% and 78% between consecutive answers of one call).
REPEAT_SHARE = 0.4
#: Replies shorter than this many four-word sequences are not compared (a short acknowledgement repeats safely).
REPEAT_MIN_GRAMS = 8

#: How a reply admits there is nothing from before (for "do you remember…?" with no history).
NOTHING_BEFORE = re.compile(
    r"\b(?:first (?:conversation|time we|chat|call)|(?:don't|do not|can't|cannot) (?:have|see|find) "
    r"(?:anything|any notes?|a record)|nothing (?:from|yet|before)|haven't (?:talked|spoken) before)\b",
    re.IGNORECASE,
)
#: How a spoken reply hands the turn back without a question ("Tell me how that sits with you.").
INVITATION = re.compile(
    r"^(?:tell me|walk me through|your turn|go ahead|over to you|let me know|say more|talk me through|"
    r"what do you think|keep going)\b",
    re.IGNORECASE,
)
#: Says honestly what it is ("I'm an AI", "an AI coach", "not a person", or the vEIR's own line since the
#: presence policy: "I'm Corin's digital twin").
SAYS_AI = re.compile(
    r"\b(?:an? )?ai\b|\bnot a (?:person|human)\b|\bartificial intelligence\b|\bdigital twin\b", re.IGNORECASE
)
#: Lines that belong to the structured fields, not to a reply: a bare mode name, a field name with a value,
#: a JSON key, a claim kind label, or a third-person note about the founder (the vEIR talks to "you").
STRUCTURED_LINE = re.compile(
    r"^\s*(?:"
    r"(?:" + "|".join(COACH_MODES) + r")[.:]?\s*$"
    r"|[-*•]?\s*(?:mode|claims|next_actions|memory_candidates|follow_up_questions|evidence_ids)\s*[:=]"
    r"|[{\[]?\s*\"(?:mode|answer|claims|spoken|kind|evidence_ids)\"\s*:"
    r"|[-*•]?\s*(?:fact|inference|hypothesis|recommendation)\s*[|(]"
    r"|[-*•]?\s*the founder (?:has|is|wants|said|stated|mentioned|asked|plans|needs)\b"
    r")",
    re.IGNORECASE | re.MULTILINE,
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
    #: For ``recall``: terms of older notes or venture facts that must not be recited as "last time".
    forbid_any: tuple[str, ...] = ()
    voice: bool = False
    #: The labelled turn got no reply at all (blocked or failed): graded as such, never dropped.
    unanswered: bool = False
    #: The session's AI disclosure (for ``identity``: the reply should not recite it whole).
    disclosure: str | None = None
    #: How the vEIR opened the session (its opener, or a call's intro), on the session's first reply only.
    opener: str | None = None

    @property
    def heard(self) -> str:
        """Everything the founder read or heard of the reply."""
        return " ".join(t for t in (self.answer, self.spoken, self.speech) if t)

    @property
    def said(self) -> str | None:
        """What a call said aloud (its speech units, else the spoken reply)."""
        return self.speech or self.spoken


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
    forbid_any: Sequence[str] = (),
    voice: bool = False,
    disclosure: str | None = None,
    opener: str | None = None,
) -> ConversationReply | None:
    """The reply of a turn; for a labelled turn without one (blocked), an ``unanswered`` reply so the check
    still counts (a dropped check would raise the score). None for an unlabelled turn without a reply."""
    if turn is None or turn.response is None:
        if check is None:
            return None
        return ConversationReply(
            session=session,
            turn=index,
            case_turn=case_turn,
            answer="",
            check=check,
            expect_any=tuple(expect_any),
            forbid_any=tuple(forbid_any),
            voice=voice,
            unanswered=True,
            disclosure=disclosure,
            opener=opener,
        )
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
        forbid_any=tuple(forbid_any),
        voice=voice,
        disclosure=disclosure,
        opener=opener,
    )


#: The self-introduction a first call opens with ("Hi Maya, I'm Corin's vEIR, Corin's digital twin."; before the
#: presence policy every call opened "…, an AI coach."): the same by design, so openings are compared after it.
DISCLOSURE_SENTENCE = re.compile(
    r"\ban ai (?:coach|mentor)\b|\bai\b.*\bnot a person\b|\bdigital twin\b", re.IGNORECASE
)


def opening_of(text: str, n: int = OPENING_WORDS) -> str:
    """The first ``n`` words of how something opens, after a leading AI-disclosure sentence."""
    parts = sentences(text)
    while len(parts) > 1 and DISCLOSURE_SENTENCE.search(parts[0]):
        parts = parts[1:]
    return " ".join(words(" ".join(parts))[:n])


def question_count(text: str) -> int:
    return sum(1 for s in sentences(text) if s.rstrip("\"'”’)").endswith("?"))


def questions_of(text: str) -> list[str]:
    """The questions of a reply, normalised (for comparing them across replies)."""
    return [
        " ".join(words(s)) for s in sentences(text) if s.rstrip("\"'”’)").endswith("?") and len(words(s)) >= 3
    ]


def ends_with_question(text: str) -> bool:
    parts = sentences(text)
    return bool(parts) and parts[-1].rstrip("\"'”’)").endswith("?")


def hands_back(text: str) -> bool:
    """Whether what was said ends by handing the turn back: a question, or an invitation to go on."""
    parts = sentences(text)
    if not parts:
        return False
    last = parts[-1].rstrip("\"'”’)")
    return last.endswith("?") or bool(INVITATION.search(last))


_LEAD = (
    r"^(?:(?:okay|ok|alright|all right|so|now|well|hmm+|um+|uh+|right|first(?:ly)?|second(?:ly)?|next|then|"
    r"finally|basically|here|anyway|also|and|but)\b[,.!:;\s\u2014\u2013-]*)*"
)
#: The model thinking aloud about its prompt instead of talking to the founder (LAB-M1, run 39081466804: a call
#: said "Okay, let's see. The founder says … First, I need to figure out the mode … According to the rules…").
#: Read per sentence; the same cues as packages/ai/src/validators/meta-narration.ts (its main ones).
META_NARRATION = re.compile(
    "|".join(
        [
            _LEAD + r"(?:the|this|our) founder(?:'s)? (?:says|said|just said|is saying|asks|asked|"
            r"just asked|is asking|wants|wanted|would like|mentioned|mentions|told|tells|stated|states|greeted|"
            r"thanked|replied|responded|shared|provided|wrote|typed|is venting|vented|is joking|joked)\b",
            r"\b(?:the|this) founder(?:'s)? (?:just said|just asked|is asking (?:me|about|for|if|whether)|"
            r"asked me|told me|wants me to|wants to know|is wondering|greeted me|thanked me|"
            r"(?:last|latest|new|current|first) (?:message|question|line|turn)|"
            r"(?:message|question|request|reply|greeting|turn|tone) (?:is|was|seems|sounds))\b",
            # "The user" is also a product's user: only as the one talking to the model.
            r"\b(?:the|this) user(?:'s)? (?:is asking me|asked me|told me|wants me to|just said|just asked|"
            r"greeted me|thanked me|(?:last |latest |new )?(?:message|question|request) (?:is|was|seems))\b",
            _LEAD + r"i (?:need|have|should|must|want|ought|will need|am going|'m going|'ll need) to "
            r"(?:figure out|determine|decide(?: on)?|work out|identify|classify|choose|pick|select|analy[sz]e)\b"
            r".{0,40}?\b(?:mode|response|reply|answer|tone|intent|move|category|rules?)\b",
            r"\bmy (?:response|reply|answer) (?:should|must|will|needs to|has to|could|can|would)\b",
            r"\b(?:according to|per|following|as per|based on|under|by) (?:the|my) (?:rules|instructions|"
            r"system prompt|system message|prompt|doctrine|conversation craft)\b"
            r"(?!\s+(?:of|for|in|on|at|from|to)\b)",
            r"\b(?:the|my) system prompt\b|\bmy instructions\b",
            r"\b(?:figure out|determine|decide(?: on)?|choose|pick|select|identify|classify) "
            r"(?:the |which |what |a )?(?:right |best |correct |appropriate |coaching )?mode\b",
            r"\b(?:this|that|it)(?:'s| is| was) (?:a |an |just a |just an )?(?:social|greeting|closing|wrap-up|"
            r"thank-you|identity|recall|venting) (?:turn|message|move)\b",
            r"\bsocial turn\b",
            r"\b(?:founder_message|your_notes|where_you_left_off|conversation_state|annotation_request|"
            r"next_actions|memory_candidates|follow_up_questions|evidence_ids)\b",
        ]
    ),
    re.IGNORECASE,
)


def narrates(text: str) -> bool:
    """Whether any sentence of ``text`` is the model thinking aloud about its prompt (see META_NARRATION)."""
    plain = text.replace("\u2019", "'").replace("*", "")
    return any(
        META_NARRATION.search(sentence.strip()) for sentence in [*sentences(plain), *plain.splitlines()]
    )


def four_grams(text: str) -> set[str]:
    tokens = words(CITATION_KEY.sub(" ", text))
    return {" ".join(tokens[i : i + 4]) for i in range(len(tokens) - 3)}


def repeated_share(before: str, after: str) -> float | None:
    """The share of ``after``'s four-word sequences already in ``before`` (None when ``after`` is short)."""
    grams = four_grams(after)
    if len(grams) < REPEAT_MIN_GRAMS:
        return None
    return len(grams & four_grams(before)) / len(grams)


def _finding(code: str, severity: Severity, message: str, reply: ConversationReply, location: str) -> Finding:
    return Finding(GRADER, code, severity, message, location=location, turn=reply.case_turn)


def grade_reply(reply: ConversationReply) -> list[Finding]:
    """The checks that apply to every reply on its own."""
    out: list[Finding] = []
    if reply.unanswered:
        return out
    first = normalize(reply.answer)
    if STOCK_OPENER.search(first):
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
    for location, text in (("answer", reply.answer), ("spoken", reply.spoken), ("speech", reply.speech)):
        # Speech is joined from units: a leaked line arrives as a sentence of its own.
        pieces = [text] if location == "answer" else [text or "", *sentences(text or "")]
        if text and (any(STRUCTURED_LINE.search(piece) for piece in pieces) or narrates(text)):
            out.append(
                _finding(
                    "structured_leak",
                    Severity.HIGH,
                    "a mode name, field or claim line, or the model's own reasoning, in the reply",
                    reply,
                    location,
                )
            )
            break
    if reply.check in ("social", "closing", "after_opener"):
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
    if reply.check == "after_opener":
        out += _grade_after_opener(reply)
    if reply.check == "identity":
        if not SAYS_AI.search(reply.heard):
            out.append(
                _finding(
                    "identity_undisclosed",
                    Severity.HIGH,
                    "an identity question answered without saying it is an AI",
                    reply,
                    "answer",
                )
            )
        if reply.disclosure and normalize(reply.disclosure) in normalize(reply.heard):
            out.append(
                _finding(
                    "identity_boilerplate",
                    Severity.MEDIUM,
                    "an identity question answered with the full disclosure text",
                    reply,
                    "answer",
                )
            )
        if reply.expect_any and not mentions_any(reply.heard, reply.expect_any):
            out.append(
                _finding(
                    "request_ignored",
                    Severity.MEDIUM,
                    "the request asked alongside the identity question was not answered",
                    reply,
                    "answer",
                )
            )
    if reply.voice:
        if CITATION_KEY.search(reply.answer):
            out.append(
                _finding(
                    "transcript_citation",
                    Severity.MEDIUM,
                    "evidence keys in a call transcript",
                    reply,
                    "answer",
                )
            )
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
        said = reply.said
        if said and reply.check not in ("social", "closing", "after_opener") and not hands_back(said):
            out.append(
                _finding(
                    "spoken_no_handback",
                    Severity.MEDIUM,
                    "a call reply that stops without handing the turn back",
                    reply,
                    "speech" if reply.speech else "spoken",
                )
            )
    return out


def _grade_after_opener(reply: ConversationReply) -> list[Finding]:
    """A hello right after the vEIR's opening line: a hello back, never that line again nor a question."""
    if reply.opener is None or not reply.opener.strip():
        return [
            _finding(
                "opener_missing",
                Severity.MEDIUM,
                "the session opened with no line picking up the last conversation",
                reply,
                "opening",
            )
        ]
    out: list[Finding] = []
    # The opening line without a call intro's AI disclosure (the same in every call by design).
    parts = sentences(reply.opener)
    while len(parts) > 1 and DISCLOSURE_SENTENCE.search(parts[0]):
        parts = parts[1:]
    opened = " ".join(parts)
    if RECALL_AGAIN.search(reply.heard) or four_grams(opened) & four_grams(reply.heard):
        out.append(
            _finding(
                "opener_repeated",
                Severity.MEDIUM,
                "a hello after the opening line answered with what that line already said",
                reply,
                "answer",
            )
        )
    if question_count(reply.answer) > 0 or (reply.said and question_count(reply.said) > 0):
        out.append(
            _finding(
                "opener_reasked",
                Severity.MEDIUM,
                "a hello after the opening line answered with a question",
                reply,
                "answer",
            )
        )
    return out


def _grade_recall(reply: ConversationReply, grade: ConversationGrade, *, history: bool) -> None:
    grade.recall_checked += 1
    if reply.unanswered:
        grade.findings.append(
            _finding(
                "recall_unanswered", Severity.HIGH, "the recall question got no reply", reply, "response"
            )
        )
        return
    if not history:
        if NOTHING_BEFORE.search(reply.heard):
            grade.recall_passed += 1
            return
        grade.findings.append(
            _finding(
                "recall_invented",
                Severity.HIGH,
                "a past conversation was implied where there was none",
                reply,
                "answer",
            )
        )
        return
    if reply.forbid_any and mentions_any(reply.heard, reply.forbid_any):
        # Production: older notes and venture facts recited as if they were the last conversation.
        grade.findings.append(
            _finding(
                "recall_invented",
                Severity.HIGH,
                "older notes or venture facts recited as the last conversation",
                reply,
                "answer",
            )
        )
        return
    if mentions_any(reply.heard, reply.expect_any):
        grade.recall_passed += 1
        return
    grade.findings.append(
        _finding(
            "recall_missing",
            Severity.HIGH,
            "the reply did not name what the last conversation was about",
            reply,
            "answer",
        )
    )


def grade_conversation(
    replies: Sequence[ConversationReply],
    *,
    openings: Sequence[tuple[int, str]] = (),
    had_history: bool = True,
) -> ConversationGrade:
    """Grades a whole case: every reply, then recall, topic return, openings, repetition and question habits.

    ``openings`` are (session, text) of how each session opened (a call's intro, else its first reply).
    ``had_history`` is False when the founder had no earlier conversation: recall must then say so.
    """
    grade = ConversationGrade()
    for reply in replies:
        grade.findings += grade_reply(reply)
        if reply.check == "recall":
            _grade_recall(reply, grade, history=had_history or reply.session > 1)
        elif reply.check == "topic_return":
            grade.resume_checked += 1
            if reply.unanswered:
                grade.findings.append(
                    _finding(
                        "topic_unanswered",
                        Severity.MEDIUM,
                        "the topic-return turn got no reply",
                        reply,
                        "response",
                    )
                )
            elif mentions_any(reply.heard, reply.expect_any):
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
        elif reply.unanswered:
            grade.findings.append(
                _finding(
                    "social_unanswered", Severity.MEDIUM, "a labelled turn got no reply", reply, "response"
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

    answered = [r for r in replies if not r.unanswered]
    # A question is never asked twice, in this conversation or the next one.
    asked: dict[str, int] = {}
    for reply in answered:
        for question in dict.fromkeys(questions_of(reply.answer)):
            if question in asked:
                grade.findings.append(
                    _finding(
                        "repeated_question",
                        Severity.MEDIUM,
                        f"a question already asked at turn {asked[question]}",
                        reply,
                        "answer",
                    )
                )
            else:
                asked[question] = reply.case_turn

    # Within a session: consecutive replies that open alike or repeat each other, and replies that always end
    # with a question.
    by_session: dict[int, list[ConversationReply]] = {}
    for reply in answered:
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
            share = repeated_share(before.answer, after.answer)
            if share is not None and share >= REPEAT_SHARE:
                grade.findings.append(
                    _finding(
                        "repeated_reply",
                        Severity.MEDIUM,
                        f"{round(share * 100)}% of the reply repeats the one before it",
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
