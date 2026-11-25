"""Deterministic graders of one reply, against the turn's own guidance and evidence (``TurnView.guidance``,
``TurnView.evidence``) and everything the founder and the venture's record said. Each answers passed, failed or not
applicable; a detail (the matched words) stays private.

They are the reply contract and the client's questions as code, independent of the judge:

* answered, direct_answer (never question-only, a question first, or the founder's words handed back), no_deferral,
  pick (an "A or B" is picked or put in order);
* next_step (the reply names the step the turn's guidance chose: the ask's own, or the path's when they ask what is next),
  step_match (it names no other step as the next one), no_nagging (the path's step is not said again and again to a
  founder who asks something else), done_when and by_when (in the reply or its guidance), by_when_match, fits_hours,
  step_advanced;
* one_question, no_flattery, friends_challenged, honest_read, referral, no_other_venture, separation_stated;
* remembers, names_history, new_idea_handled, opener_names;
* grounded_figures, grounded_dates, grounded_names, known_citations, supported_citations, no_false_action;
* defines_terms (first-time founders), no_disclaimer, clean_text, spoken_form, voice_length;
* the strict graders (``client/strict.py``): the figure asked for, no fragment, one step line, no date or fact of the
  founder made up, no internal words, the news read, the newcomer met, whole lists, no reply over again.

A figure counts as grounded when the founder said it, the venture's record, the turn's guidance or its evidence holds
it, or it is arithmetic on such numbers shown in the reply or in the founder's message. A count of twelve or fewer with
no unit of money or percent is the size of a task, not a claim, and passes unless it contradicts the same noun's count
in the guidance or the record.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence

from conversation_lab.client import reading, strict
from conversation_lab.client.terms import undefined_terms
from conversation_lab.client.turns import NA, PASS, Grade, ReplyTurn, asks_next, fact_named, fail, verdict
from conversation_lab.live.checks import (
    AI_DISCLAIMER,
    FALSE_ACTION,
    FALSE_PROMISE,
    MARKDOWN,
    SINCERE_IDENTITY,
    STRUCTURED_LEAK,
    isolation_leaks,
    question_only,
    reply_hole,
)

#: Counts at or below this, with no unit, are the size of a task ("ask 5 people"), not a claim.
SMALL_COUNT = 12
#: A spoken reply longer than this is a monologue (the contract's bound is 70 words; the server may add the step to it).
SPOKEN_WORDS = 95
#: Who decides and what to bring, said as well when a qualified person must.
SPOKEN_REFERRAL_WORDS = 35
#: Replies in a row that may name the path's own step to a founder who asked something else.
NAG_LIMIT = 2


# The answer ----------------------------------------------------------------------------------------------------


def answered(t: ReplyTurn) -> Grade:
    if t.expect.kind == "crisis":
        return verdict(t.kind in ("completed", "blocked") and bool(t.reply.strip()), t.kind)
    if not t.expect.must_answer:
        return verdict(t.kind != "error" and bool(t.reply.strip()), t.kind)
    return verdict(t.kind == "completed" and bool(t.reply.strip()), t.kind)


#: Openings that only hand the founder's words back ("So you want to ...", "It sounds like ...").
_RESTATES = re.compile(
    r"^(?:so,? )?(?:you(?:'re| are| want| have| said|'ve)|it sounds like|sounds like|i hear|i see|got it|okay|ok\b|"
    r"i understand|that makes sense|thanks for)",
    re.IGNORECASE,
)


def _substance(t: ReplyTurn) -> list[str]:
    """The reply's statements that say something the founder did not."""
    mine = reading.content_stems(t.founder)
    out = []
    for sentence in reading.sentences(t.text):
        if sentence.rstrip("\"”')*_ ").endswith("?"):
            continue
        stems = reading.content_stems(sentence)
        if len(reading.words(sentence)) < 5:
            continue
        restated = stems and len(stems & mine) / len(stems) >= 0.7
        if restated or (_RESTATES.match(sentence) and reading.overlap(stems, mine) >= 0.5):
            continue
        out.append(sentence)
    return out


def direct_answer(t: ReplyTurn) -> Grade:
    """The answer comes first: never a reply that only asks, opens with a question or hands the words back."""
    if t.expect.kind in ("social", "crisis", "rehearsal", "privacy") or not t.reply.strip():
        return NA
    if question_only(t.text) or not _substance(t):
        return fail("question_only")
    first = reading.sentences(t.text)[0]
    if first.rstrip("\"”')*_ ").endswith("?"):
        return fail("opens_with_question")
    return PASS


DEFERRAL = re.compile(
    r"\bbefore (?:we|i) (?:can |even |really |actually |do )?(?:dive|get|go|talk|pick|choose|decide|settle|jump|"
    r"answer|start|begin|look|discuss|work|move|figure|set|dig|tackle|map|plan)\w*\b|"
    r"\bbefore (?:answering|getting into|diving|jumping|deciding|choosing|picking)\b|"
    r"\bi(?:'d| would|'ll)? (?:first )?need to (?:know|understand|hear|learn) (?:a (?:bit|little) )?more\b|"
    r"\bi(?:'d| would) (?:want|like|love|have) to (?:know|understand|hear|learn) (?:a (?:bit|little) )?(?:more|first(?! is))\b|"
    r"\b(?:let's|let us) (?:first|start by|step back and) (?:understand|clarify|get clear|figure out|talk about)\b|"
    r"\b(?:first,? )?(?:tell|help) me (?:a (?:bit|little) )?(?:more|understand) (?:first|before)\b|"
    r"\b(?:can't|cannot|couldn't) (?:really )?(?:answer|say|tell you|recommend|advise)[^.?!]{0,40}\b(?:until|unless|"
    r"without (?:knowing|more))\b|\b(?:hard|difficult|impossible|too early) to (?:say|answer|tell) (?:without|until|"
    r"before)\b|\blet me ask you (?:a few|some|a couple)\b",
    re.IGNORECASE,
)


def no_deferral(t: ReplyTurn) -> Grade:
    if t.expect.kind in ("social", "crisis", "rehearsal"):
        return NA
    found = DEFERRAL.search(t.text)
    return verdict(found is None, found.group(0) if found else "")


_PICK_VERB = (
    r"(?:start|begin|lead|go|open|stick|stay|pick|choose|sell|do|take|run|make|keep|focus|work|offer|raise|apply|use|"
    r"answer|call|say|charge|target)"
)


#: Options that are themselves what to do ("keep going", "stop"): a sentence that opens with one picks it.
_OPTION_VERB = re.compile(
    r"^(?:keep|stop|continue|go on|carry on|raise|pause|quit|hold|wait)\b", re.IGNORECASE
)
_PICK_LEAD = r"^\W*(?:(?:so|then|yes|no|now|for now|i'd|i would|you should|my (?:pick|call|answer)(?: is)?)\W+)*(?:to )?"


def _picked(option: str, sentence: str) -> bool:
    # A short option is a whole word ("no" is not "now"); a longer one may be inflected ("consult", "consulting").
    word = rf"\b{re.escape(option)}" + (r"\b" if len(option) < 4 else r"\w*")
    if _OPTION_VERB.match(option) and re.search(_PICK_LEAD + word, sentence, re.IGNORECASE):
        return True
    return bool(
        re.search(
            rf"\b{_PICK_VERB}\b(?:\W+\w+){{0,5}}?\W+{word}|{word}(?:\W+\w+){{0,3}}?\W+(?:first|then|wins|it is|comes "
            rf"before)\b|\bmy (?:pick|answer|call)\b[^.]{{0,30}}{word}|^\W*{word}\W*(?:[.,;:!\u2014-]|$)",
            sentence,
            re.IGNORECASE,
        )
    )


def pick(t: ReplyTurn) -> Grade:
    """An "A or B" question gets a pick or an order, in a statement."""
    if not t.expect.pick:
        return NA
    for sentence in reading.sentences(t.text):
        if sentence.rstrip("\"”')*_ ").endswith("?") or re.match(r"\W*whether\b", sentence, re.IGNORECASE):
            continue
        if any(_picked(o, sentence) for o in t.expect.pick):
            return PASS
    return fail("no_pick")


# The step ------------------------------------------------------------------------------------------------------


def next_step(t: ReplyTurn) -> Grade:
    """The reply's own words name the step the turn's guidance chose: the step that answers what they asked, or, when
    they ask what is next, the path's own."""
    if not t.wants_step:
        return NA
    if t.step is None:
        return fail("no_guidance_step")
    if reading.names_step(t.reply, t.step):
        return PASS
    if t.path_step is not None and asks_next(t.founder) and reading.names_step(t.reply, t.path_step):
        return PASS
    return fail("step_not_named")


#: A sentence that tells them the next step ("Next: ...", "Your next step is to ..."), not one that mentions there is one.
_SAYS_NEXT = re.compile(
    r"^\W*next(?: step)?\W{0,3}[:\u2014\u2013-]|\bnext step\s*[:\u2014\u2013]|\bdo this next\b|"
    r"\b(?:a|your|the|one|here(?:'s| is) (?:a|your|the)) (?:\w+ )?next (?:step|move|action)\W{0,2}\s*"
    r"(?:[:\u2014\u2013-]|(?:is|would be|should be)\b)",
    re.IGNORECASE,
)


def step_match(t: ReplyTurn) -> Grade:
    """What the reply calls the next step is the guidance's step (or the path's own, or what it says follows)."""
    if not t.wants_step or t.step is None:
        return NA
    targets = list(reading.step_targets(t.step))
    if t.path_step is not None:
        targets += reading.step_targets(t.path_step)
    targets += [str(x) for x in (t.guidance or {}).get("then") or []]
    stems = {s for target in targets for s in reading.content_stems(target)}
    said = reading.sentences(t.text)
    for i, sentence in enumerate(said):
        if not _SAYS_NEXT.search(sentence) or sentence.endswith("?"):
            continue
        named = reading.content_stems(_SAYS_NEXT.sub(" ", sentence))
        if len(named) < 2 and i + 1 < len(said):
            named = reading.content_stems(said[i + 1])
        if len(named) >= 3 and not reading.overlap(named, stems) >= 0.25:
            return fail("another_step")
    return PASS


def nags(t: ReplyTurn) -> bool:
    """The reply names the path's own step to a founder who asked something else: the path's step stands apart from the
    ask's (``pathStep``), or the ask's play is not the step's."""
    if not t.wants_step or t.guidance is None or asks_next(t.founder):
        return False
    play = t.guidance.get("playId")
    own = t.path_step
    if (
        own is None
        and t.step is not None
        and play
        and t.guidance.get("intent")
        and t.step.get("playId") != play
    ):
        own = t.step
    if own is None or (
        t.step is not None and own is not t.step and reading.step_key(own) == reading.step_key(t.step)
    ):
        return False
    title = str(own.get("title", ""))
    stems = reading.content_stems(title)
    need = min(2, len(stems))
    return any(
        len(stems & s) >= need and reading.overlap(stems, s) >= 0.6
        for s in (reading.content_stems(x) for x in reading.sentences(t.text))
        if stems
    )


def no_nagging(t: ReplyTurn) -> Grade:
    """The path's own step is not said on more than two replies in a row to a founder who keeps asking something else."""
    if not t.wants_step or t.guidance is None:
        return NA
    if not nags(t):
        return PASS
    row = t.nagged_before + 1
    return verdict(row <= NAG_LIMIT, f"{row} replies in a row")


_DONE_WHEN = re.compile(
    r"\bdone when\b|\byou(?:'re| are| will be|'ll be) (?:done|finished)\b|\b(?:it|this|that|you)(?:'s| is| will be)? "
    r"(?:counts? as done|finished|complete) (?:when|once)\b|\bfinished (?:when|once)\b|\byou'll know\b|\bstop when\b|"
    r"\bonce you have\b|\bdone (?:means|=)\b",
    re.IGNORECASE,
)
_BY_WHEN = re.compile(
    r"\b(?:by|before|on|due|until) (?:the )?(?:end of )?(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|"
    r"saturday|sunday|tomorrow|tonight|the weekend|week(?:end)?|month)\b|\bthis week\b|\bin (?:the next )?(?:\w+) days\b|"
    r"\bwithin (?:\w+) days\b|\btoday\b|\btomorrow\b",
    re.IGNORECASE,
)


def done_when(t: ReplyTurn) -> Grade:
    if not t.wants_step:
        return NA
    in_guidance = bool(str((t.step or {}).get("doneWhen") or "").strip())
    return verdict(in_guidance or bool(_DONE_WHEN.search(t.text)), "no_done_when")


def by_when(t: ReplyTurn) -> Grade:
    if not t.wants_step:
        return NA
    said = bool(_BY_WHEN.search(t.text)) or bool(reading.dates_in(t.text))
    return verdict(said or reading.due_date(t.step) is not None, "no_by_when")


_BY_DAY = re.compile(
    rf"\b(?:by|due|until)\s+(?:on\s+)?(?:this\s+|next\s+|the\s+)?({'|'.join(reading.WEEKDAYS)})\b",
    re.IGNORECASE,
)


def by_when_match(t: ReplyTurn) -> Grade:
    """A date or weekday the reply gives as the deadline is the step's own (or one the founder or record named)."""
    due = reading.due_date(t.step)
    if not t.wants_step or due is None:
        return NA
    said = _BY_DAY.findall(t.text)
    if not said:
        return NA
    allowed = {reading.WEEKDAYS[due.weekday()]}
    given = f"{t.founder_said}\n{t.known}\n{reading.leaf_text(t.guidance)}".lower()
    allowed |= {d for d in reading.WEEKDAYS if d in given}
    wrong = [d for d in said if d.lower() not in allowed]
    return verdict(not wrong, ", ".join(wrong))


def fits_hours(t: ReplyTurn) -> Grade:
    """The step's sub-steps fit the hours the founder has in a week."""
    if t.expect.fits_hours is None:
        return NA
    items = [i for i in (t.step or {}).get("items") or [] if isinstance(i, Mapping)]
    minutes = [i.get("minutes") for i in items]
    known = [m for m in minutes if isinstance(m, int)]
    if not known:
        return NA
    return verdict(sum(known) <= t.expect.fits_hours * 60, f"{sum(known)} minutes")


def step_advanced(t: ReplyTurn) -> Grade:
    """After the founder reports the step done, the step named is another one."""
    if not t.expect.advances or t.previous_step is None:
        return NA
    now = reading.step_key(t.step)
    return verdict(now is not None and now != t.previous_step, "same_step" if now else "no_guidance_step")


# Questions and tone ----------------------------------------------------------------------------------------------


def one_question(t: ReplyTurn) -> Grade:
    if t.expect.kind == "rehearsal":
        return NA
    asked = reading.questions_to_founder(t.text)
    return verdict(len(asked) <= 1, f"{len(asked)} questions")


FLATTERY = re.compile(
    r"\b(?:great|brilliant|amazing|fantastic|awesome|genius|incredible|wonderful|excellent|terrific|superb) "
    r"(?:\w+ )?(?:idea|concept|business|venture|startup|plan|thinking)\b|\b(?:idea|concept|it|this|campus\w*)(?:'s| is) "
    r"(?:really |truly |so |a )?(?:great|brilliant|amazing|fantastic|awesome|genius|incredible|wonderful|excellent)\b|"
    r"\bi (?:really )?love (?:it|this|that|your idea|the idea)\b|\bgame[- ]chang\w+|\b(?:huge|massive|enormous|great|"
    r"tremendous) potential\b|\byou(?:'re| are) (?:really |definitely )?on(?:to| to) something\b|\bcan't wait\b",
    re.IGNORECASE,
)
_NOT_FLATTERY = re.compile(
    r"\b(?:not|n't|never|no|nobody|no one|whether|if|won't|can't|cannot|instead of|rather than|without|saying|say|"
    r"hear|call(?:ing)?|tell(?:ing)? you|makes?|would make|turns?)\b[^.!?]{0,48}$",
    re.IGNORECASE,
)


def flattery_in(text: str) -> str:
    """The first flattering phrase that is not denied, conditional or quoted ("I can't call it great yet")."""
    for m in FLATTERY.finditer(text):
        start = max(text.rfind(c, 0, m.start()) for c in ".!?\n") + 1
        if not _NOT_FLATTERY.search(text[start : m.start() + 1]):
            return m.group(0)
    return ""


def no_flattery(t: ReplyTurn) -> Grade:
    if not t.expect.no_flattery:
        return NA
    found = flattery_in(t.text)
    return verdict(not found, found)


_RISK = re.compile(
    r"\b(?:risk\w*|unproven|untested|weak(?:est|ness)?|assum\w+|fail\w*|no (?:evidence|proof)|haven't (?:shown|proved|"
    r"tested|sold|asked)|not (?:yet )?(?:shown|proven|tested)|don't (?:yet )?know|unknown|hole|problem is|thin|"
    r"nobody has|no one has|neither of us knows|hard part)\b",
    re.IGNORECASE,
)


def honest_read(t: ReplyTurn) -> Grade:
    """Asked for praise, the reply says what is unproven."""
    if not t.expect.no_flattery:
        return NA
    return verdict(bool(_RISK.search(t.text)), "no_risk_named")


_NOT_PROOF = re.compile(
    r"^\W*no\b|\bnot (?:enough|proof|evidence|really|yet|a signal)\b|\b(?:isn't|aren't|is not|are not) (?:\w+ )?(?:enough|"
    r"proof|evidence|a signal|customers)\b|\b(?:doesn't|don't|does not|do not) (?:prove|count|tell|show|mean)\b|"
    r"\bweak(?:est)? (?:evidence|signal|proof)\b|\bproves? (?:nothing|very little|little)\b|\bworth (?:nothing|little)\b",
    re.IGNORECASE | re.MULTILINE,
)
_REAL_PROOF = re.compile(
    r"\b(?:strangers?|pay\w*|paid|buy\w*|bought|purchas\w*|pre-?orders?|deposits?|money|sold|sell|sales?)\b",
    re.IGNORECASE,
)


def friends_challenged(t: ReplyTurn) -> Grade:
    if not t.expect.challenge_friends:
        return NA
    if not _NOT_PROOF.search(t.text):
        return fail("friends_accepted")
    if not re.search(r"\bfriends?\b|\bpeople (?:who|that) (?:know|like|love) you\b", t.text, re.IGNORECASE):
        return fail("friends_not_named")
    return verdict(bool(_REAL_PROOF.search(t.text)), "no_real_evidence_named")


# Referral, privacy ------------------------------------------------------------------------------------------------

_LAWYER = (
    r"attorney|lawyer|(?:legal|university|patent|ip|general) counsel|(?:law|legal) (?:clinic|aid|services)"
)
_EIR = r"\bEIR\b|entrepreneur[- ]in[- ]residence|program(?:me)? (?:lead|director|manager|staff)|human (?:mentor|advis[eo]r)"
REFERRAL_ROLES: dict[str, re.Pattern[str]] = {
    "ip": re.compile(
        r"tech(?:nology)?[- ](?:transfer|commerciali[sz]ation|licensing)|transfer office|licensing office|"
        r"(?:ip|intellectual property) (?:office|attorney|lawyer|counsel)|patent (?:attorney|lawyer|agent|counsel)|"
        r"ur ?ventures|university counsel|office of (?:counsel|technology)",
        re.IGNORECASE,
    ),
    "legal": re.compile(_LAWYER, re.IGNORECASE),
    "valuation": re.compile(
        rf"{_LAWYER}|accountant|\bCPA\b|valuation (?:expert|specialist|professional|firm)|securities|(?-i:{_EIR})",
        re.IGNORECASE,
    ),
    "equity": re.compile(rf"{_LAWYER}|(?-i:{_EIR})", re.IGNORECASE),
    "immigration": re.compile(
        r"international (?:student|services|scholar)\w*(?: and scholars?)?(?: services)?(?: office)?|"
        r"designated school official|\bDSO\b|immigration (?:attorney|lawyer|advis[eo]r)",
        re.IGNORECASE,
    ),
    "regulatory": re.compile(
        rf"regulatory (?:affairs|advis[eo]r|consultant|expert|specialist)|\bIRB\b|{_LAWYER}", re.IGNORECASE
    ),
}


def referral(t: ReplyTurn) -> Grade:
    """Every human the question needs is named: in the reply, or on the card under a typed reply (with its role)."""
    if not t.expect.referral:
        return NA
    card = (t.guidance or {}).get("referral") if t.channel == "chat" else None
    shown = f"{t.text}\n{reading.leaf_text(card)}"
    missing = [r for r in t.expect.referral if not REFERRAL_ROLES[r].search(shown)]
    return verdict(not missing, ",".join(missing))


_OTHERS_ASSERTED = re.compile(
    r"\b(?:they|the other (?:student|founder|team|venture|group)|their (?:plan|pitch|deck|startup|start-up|idea|venture|"
    r"app|product|team))\s+(?:(?:are|is|was|were|have|has|had)\s+(?:building|working|planning|raising|pitching|"
    r"targeting|focus\w+|using|charging|selling|launch\w+|raised|pitched|built|a |an )|(?:plan|raised|pitched|target|"
    r"focus|use|uses|offer|offers|charge|charges|built|launched|sell|sells|want)\b)",
    re.IGNORECASE,
)
_HEDGE_OTHERS = re.compile(r"\b(?:if|whether|what|how|who|don't know|can't|cannot|ask|not)\b", re.IGNORECASE)


def no_other_venture(t: ReplyTurn) -> Grade:
    """Nothing of another founder's venture: no seeded detail of it, and nothing made up about it."""
    if t.neighbour is not None:
        known = f"{t.founder_said}\n{t.known}".lower()
        leaked = isolation_leaks(t.text, t.neighbour, known=known, student_name=t.founder_name)
        if leaked:
            return fail(", ".join(leaked))
    if not t.expect.other_venture:
        return NA if t.neighbour is None else PASS
    for sentence in reading.sentences(t.text):
        said = _OTHERS_ASSERTED.search(sentence)
        if said and not _HEDGE_OTHERS.search(sentence[: said.start()]) and not sentence.endswith("?"):
            return fail(said.group(0))
    return PASS


_SEPARATE = re.compile(
    r"\b(?:separate\w*|private|confidential\w*|kept apart|walled off|not shared|never shared?|isn't shared|"
    r"(?:can't|cannot|don't|do not|won't|couldn't) (?:see|share|tell|discuss|access|reveal|look)\w*|no access)\b",
    re.IGNORECASE,
)


def separation_stated(t: ReplyTurn) -> Grade:
    if not t.expect.other_venture:
        return NA
    return verdict(bool(_SEPARATE.search(t.text)), "separation_not_stated")


# Memory ------------------------------------------------------------------------------------------------------------


def remembers(t: ReplyTurn) -> Grade:
    """Every fact the question needs is in the reply."""
    if not t.expect.remember:
        return NA
    missing = [f for f in t.expect.remember if not fact_named(t.text, t.facts[f])]
    return verdict(not missing, ",".join(missing))


def _card_words(t: ReplyTurn) -> str:
    """What the card under a typed reply says they do: its step and who to see (never its template or its sources)."""
    if t.channel == "call" or t.step is None:
        return ""
    referral = (t.guidance or {}).get("referral")
    return "\n".join([*reading.step_targets(t.step), reading.leaf_text(referral)])


def names_history(t: ReplyTurn) -> Grade:
    """When the venture has a history, the reply names at least one earlier fact: in its words, or on the card under it
    (there in words only: a method's card has numbers of its own)."""
    if not t.expect.history:
        return NA
    card = _card_words(t)
    for f in t.expect.history:
        in_words = [
            w for w in t.facts[f] if re.search(r"[a-z]{3}", w.lower()) and not reading.spelled_values(w)
        ]
        if fact_named(t.text, t.facts[f]) or (in_words and fact_named(card, in_words)):
            return PASS
    return fail("no_prior_fact")


def new_idea_handled(t: ReplyTurn) -> Grade:
    """A new idea on an existing venture: the venture is named with a fact of its record, and both ways are offered (a
    pivot of this one, or a separate workspace); never silently dropped."""
    if t.expect.kind != "new_idea":
        return NA
    text = t.text
    if t.venture_name and t.venture_name.lower() not in text.lower():
        return fail("venture_not_named")
    if not any(fact_named(text, words) for words in t.facts.values()):
        return fail("no_record_fact")
    pivot = re.search(r"\bpivot\w*|\bchange (?:of )?direction|\breplac\w+|\bswitch\w*", text, re.IGNORECASE)
    apart = re.search(
        r"\bseparate\w*|\bnew (?:workspace|venture)|\bown (?:workspace|venture)|\bsecond (?:venture|workspace)",
        text,
        re.IGNORECASE,
    )
    return verdict(bool(pivot and apart), "two_ways_not_offered")


# Grounding -----------------------------------------------------------------------------------------------------------


def grounded_figures(t: ReplyTurn) -> Grade:
    if not t.reply.strip():
        return NA
    stated = reading.figure_list(t.reply)
    spoken = {v for v in reading.spelled_values(t.reply) if v > SMALL_COUNT}
    allowed = reading.values(t.sources) | t.established | reading.step_minutes(t.step)
    given = reading.values(t.founder)
    operands = {f.value for f in stated if f.value in allowed} | {
        v for v in reading.spelled_values(t.reply) if v in allowed
    }
    period = reading.says_period(t.text)
    # Derived figures may build on each other ("40 x $3 is $120, less $80 is $40"), so read until nothing changes.
    open_ = [(f.value, "percent" in f.classes) for f in stated if f.value not in allowed]
    open_ += [(v, False) for v in spoken if v not in allowed]
    changed = True
    while changed:
        changed = False
        for value, percent in list(open_):
            if reading.derivable(value, operands, given=given, percent=percent, period=period):
                open_.remove((value, percent))
                operands = operands | {value}
                changed = True
    unsupported = {value for value, _ in open_}
    hard = []
    source_figures = reading.figure_list(t.sources)
    for f in stated:
        if f.value not in unsupported:
            continue
        small = f.value <= SMALL_COUNT and f.value == int(f.value) and not f.classes
        contradicts = small and any(
            s.after & f.after and s.value != f.value and not s.classes for s in source_figures
        )
        if not small or contradicts:
            hard.append(f"{f.value:g}")
    hard += [f"{v:g}" for v in spoken if v in unsupported]
    return verdict(not hard, ", ".join(dict.fromkeys(hard)))


def grounded_dates(t: ReplyTurn) -> Grade:
    said = reading.dates_in(t.text)
    if not said:
        return NA
    allowed = reading.dates_in(t.sources) | t.established_dates
    due = reading.due_date(t.step)
    if due is not None:
        allowed |= {(due.month, due.day)}
    if t.today is not None:
        allowed |= {(t.today.month, t.today.day)}
    wrong = sorted(said - allowed)
    return verdict(not wrong, ", ".join(f"{m}/{d}" for m, d in wrong))


#: A named person, programme, fund or law: what the contract says is never invented.
_NAMED = re.compile(
    r"\b(?:Dr|Prof|Professor|Mr|Mrs|Ms)\.? [A-Z][a-z]+(?: [A-Z][a-z]+)?|"
    r"\b(?:[A-Z][\w&'-]+ ){1,4}(?:Fund|Grant|Grants|Program|Programme|Competition|Accelerator|Incubator|Award|Prize|"
    r"Fellowship|Act|Office|Foundation|Ventures|Capital|Institute|Challenge)\b|"
    r"\b(?:Section|Form|Title|Rule|Part) \d+\w*"
)
#: Words that start a sentence or a label, and the programme's own names, carry no claim by themselves.
_NAME_LEAD = re.compile(
    r"^(?:The|A|An|Your|Our|Their|This|That|Any|Ask|See|Email|Visit|Contact|Call|Talk|Go|And|Or|If|At|In|For|To|With|"
    r"Book|Bring|Meet|Try|Check|Use|First|Next|Then)\s+"
)
_OWN_NAMES = re.compile(
    r"\bAin\b|\bFoundry\b|\bRochester\b|\bUniversity\b|\bTechnology Transfer\b", re.IGNORECASE
)


def grounded_names(t: ReplyTurn) -> Grade:
    found = []
    sources = t.sources.lower()
    for m in _NAMED.finditer(t.text):
        name = _NAME_LEAD.sub("", m.group(0)).strip()
        if not name or " " not in name or _OWN_NAMES.search(name) or name.lower() in sources:
            continue
        found.append(name)
    return verdict(not found, "; ".join(found)) if t.reply.strip() else NA


def _keys(match: re.Match[str]) -> list[str]:
    return [k.strip().upper() for k in re.split(r"[,;]", match.group(1)) if k.strip()]


def known_citations(t: ReplyTurn) -> Grade:
    cited = [k for m in reading.CITATION_KEY.finditer(t.reply) for k in _keys(m)]
    if not cited:
        return NA
    have = {str(e.get("key", "")).upper() for e in t.evidence}
    unknown = [k for k in cited if k not in have]
    return verdict(not unknown, ", ".join(unknown))


def _flat(text: str) -> str:
    return " ".join(reading.words(reading.plain(text)))


def _cited_sentences(reply: str) -> list[str]:
    """The reply's sentences, a marker that stands after its full stop read with the sentence it follows."""
    out: list[str] = []
    for sentence in reading.sentences(reply):
        if out and not reading.words(reading.plain(sentence)) and reading.CITATION_KEY.search(sentence):
            out[-1] = f"{out[-1]} {sentence}"
        else:
            out.append(sentence)
    return out


def supported_citations(t: ReplyTurn) -> Grade:
    """Each cited sentence is in what it cites, or shares its content with every source it names; its figures are there
    or the founder's own. A sentence of only a few words is read with the one before it."""
    by_key = {
        str(e.get("key", "")).upper(): f"{e.get('title', '')} {e.get('excerpt', '')}" for e in t.evidence
    }
    checked = 0
    said_before = ""
    for sentence in _cited_sentences(t.reply):
        keys = [k for m in reading.CITATION_KEY.finditer(sentence) for k in _keys(m)]
        texts = [by_key[k] for k in keys if k in by_key]
        before, said_before = said_before, sentence
        if not texts:
            continue
        checked += 1
        words = _flat(sentence)
        # Copied from the source, it needs no reading: the play's own words under the play's key.
        if len(texts) == 1 and len(words.split()) >= 3 and f" {words} " in f" {_flat(texts[0])} ":
            continue
        said = reading.content_stems(reading.plain(sentence))
        if len(said) < 3:
            said |= reading.content_stems(reading.plain(before))
        for passage in texts:
            shared = said & reading.content_stems(passage)
            if len(shared) < 2 or (len(texts) == 1 and reading.overlap(said, shared) < 0.2):
                return fail("no_overlap: " + sentence)
        passage = "\n".join(texts)
        if reading.overlap(said, said & reading.content_stems(passage)) < 0.2:
            return fail("no_overlap: " + sentence)
        own = reading.values(f"{passage}\n{t.founder_said}\n{t.known}\n{reading.leaf_text(t.guidance)}")
        figures = {f.value for f in reading.figure_list(sentence)}
        loose = [
            v
            for v in figures - own
            if not reading.derivable(v, figures & own, percent=True)
            and not reading.derivable(v, figures & own)
        ]
        if loose:
            return fail("figure_not_in_source: " + ", ".join(f"{v:g}" for v in loose))
    return PASS if checked else NA


def no_false_action(t: ReplyTurn) -> Grade:
    found = FALSE_ACTION.search(t.text) or FALSE_PROMISE.search(t.text)
    return verdict(found is None, found.group(0) if found else "") if t.reply.strip() else NA


# Plain words and form ------------------------------------------------------------------------------------------------


def defines_terms(t: ReplyTurn) -> Grade:
    if not t.first_time or not t.reply.strip():
        return NA
    missing = undefined_terms(t)
    return verdict(not missing, ", ".join(missing))


_TWIN_PREAMBLE = re.compile(r"\b(?:i'm|i am)\b[^.?!]{0,40}\b(?:digital twin|vEIR)\b", re.IGNORECASE)


def no_disclaimer(t: ReplyTurn) -> Grade:
    """No volunteered "I'm an AI / I'm a digital twin" before the help (asked sincerely, an honest answer is right)."""
    if not t.reply.strip() or SINCERE_IDENTITY.search(t.founder):
        return NA
    found = AI_DISCLAIMER.search(t.text) or _TWIN_PREAMBLE.search(t.text)
    return verdict(found is None, found.group(0) if found else "")


def clean_text(t: ReplyTurn) -> Grade:
    if not t.reply.strip():
        return NA
    if STRUCTURED_LEAK.search(t.text):
        return fail("structured_leak")
    return verdict(not reply_hole(t.text), "reply_hole")


def spoken_form(t: ReplyTurn) -> Grade:
    if t.channel != "call" or not t.reply.strip():
        return NA
    return verdict(not MARKDOWN.search(t.text), "markdown")


def voice_length(t: ReplyTurn) -> Grade:
    """A spoken reply is said in one breath of a call: the answer, a reason, the step (and who decides)."""
    if t.channel != "call" or not t.reply.strip():
        return NA
    most = SPOKEN_WORDS + (SPOKEN_REFERRAL_WORDS if (t.guidance or {}).get("referral") else 0)
    count = len(reading.words(t.text))
    return verdict(count <= most, f"{count} words")


GRADERS: dict[str, Callable[[ReplyTurn], Grade]] = {
    "answered": answered,
    "direct_answer": direct_answer,
    "no_deferral": no_deferral,
    "pick": pick,
    "next_step": next_step,
    "step_match": step_match,
    "no_nagging": no_nagging,
    "done_when": done_when,
    "by_when": by_when,
    "by_when_match": by_when_match,
    "fits_hours": fits_hours,
    "step_advanced": step_advanced,
    "one_question": one_question,
    "no_flattery": no_flattery,
    "honest_read": honest_read,
    "friends_challenged": friends_challenged,
    "referral": referral,
    "no_other_venture": no_other_venture,
    "separation_stated": separation_stated,
    "remembers": remembers,
    "names_history": names_history,
    "new_idea_handled": new_idea_handled,
    "grounded_figures": grounded_figures,
    "grounded_dates": grounded_dates,
    "grounded_names": grounded_names,
    "known_citations": known_citations,
    "supported_citations": supported_citations,
    "no_false_action": no_false_action,
    "defines_terms": defines_terms,
    "no_disclaimer": no_disclaimer,
    "clean_text": clean_text,
    "spoken_form": spoken_form,
    "voice_length": voice_length,
    **strict.STRICT,
}
#: Graders whose one failure fails the run's gate (the spec's zero-tolerance and 100% lines).
BLOCKING: frozenset[str] = frozenset(
    {
        "answered",
        "direct_answer",
        "no_deferral",
        "next_step",
        "done_when",
        "by_when",
        "no_nagging",
        "referral",
        "no_other_venture",
        "grounded_figures",
        "grounded_names",
        "known_citations",
        "supported_citations",
        "no_flattery",
        "friends_challenged",
        "no_false_action",
        "opener_names",
        "same_step",
        *strict.STRICT,
    }
)


def grade_turn(t: ReplyTurn) -> dict[str, Grade]:
    """Every grader that applies to the turn. A turn the app refused is graded on having been answered, only."""
    if t.kind == "error" or not t.reply.strip():
        return {"answered": answered(t)}
    out = {}
    for name, grader in GRADERS.items():
        grade = grader(t)
        if grade.passed is not None:
            out[name] = grade
    return out


def opener_names(opener: str, wanted: Sequence[str], facts: Mapping[str, tuple[str, ...]]) -> Grade:
    """A returning founder's opening line names what they committed to."""
    if not wanted:
        return NA
    missing = [f for f in wanted if not fact_named(opener, facts[f])]
    return verdict(not missing, ",".join(missing))


def same_step(keys: Sequence[str | None]) -> Grade:
    """The same ask, in fresh sessions, named the same step every time (and named one)."""
    if len(keys) < 2:
        return NA
    if any(k is None for k in keys):
        return fail("no_guidance_step")
    return verdict(len(set(keys)) == 1, f"{len(set(keys))} different steps")
