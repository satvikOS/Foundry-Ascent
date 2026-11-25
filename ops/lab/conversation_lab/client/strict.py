"""The strict graders: what an entrepreneurship professor would be embarrassed to read. They were written from the faults
of the first live run (none of its wording is here), and each has replies it must pass and must fail
(``tests/test_client_strict.py``).

* answers_the_number: a figure the conversation or the record gives is said when it is asked for;
* no_fragment: more than a step line, and never a reply that starts or stops mid-thought;
* single_step_line: one step, one deadline, one way to know it is done;
* no_step_by_model_dates: every deadline and date is the guidance's, the founder's or the record's, and a date's weekday is
  the real one;
* no_invented_founder_fact: nothing is claimed of the founder that nobody said: a filled template's "I ...", "you have
  paying customers", an amount of money;
* no_internal_words, no_identity_leak, no_duplicate_story_entries;
* news_interpreted: a result the founder reports is read (what it means, with its own words or numbers), not only counted;
* first_time_adapted: someone who says they are new to this is answered in plain words, on their own idea;
* list_formatting: a list is whole, its items are not glued to other lines;
* repeats_previous_reply: not the reply before it again.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from collections.abc import Callable, Iterable, Mapping

from conversation_lab.client import reading, workings
from conversation_lab.client.terms import GLOSSARY, defined
from conversation_lab.client.turns import NA, PASS, Grade, ReplyTurn, asks_next, fact_named, fail, verdict
from conversation_lab.live.checks import REPEAT_REQUEST, SINCERE_IDENTITY

# Reading a reply's step lines --------------------------------------------------------------------------------------

#: A sentence that declares the step ("Next: ...", "Your next step is ...", "Now: ..., due Monday").
_LABEL = re.compile(
    r"^\W*(?:next(?: step)?|do this next|now|open step(?: now)?|your (?:open|next) step|first step)\s*[:—–]|"
    r"\b(?:your|the|a|one) next (?:step|move) (?:is|would be)\b|^\W*your next step\b|\bthe first step is\b",
    re.IGNORECASE,
)
_VERB = (
    r"(?:write|ask|make|list|send|talk|call|sell|pick|choose|put|book|test|count|run|offer|try|set|take|find|start|email|"
    r"message|mark|fill|read|check|look|keep|bring|decide|show|work|contact|build|draft|collect|get|copy|rehearse|deliver)"
)
#: The server's line before the step: the one thing to do first ("Start with: ring the hall.").
_STARTS = re.compile(r"^\W*start with\W{0,3}:", re.IGNORECASE)
#: "Next, run an interview": a step said with a comma.
_NEXT_DO = re.compile(rf"^\W*next,? {_VERB}\b", re.IGNORECASE)
_DONE = re.compile(
    r"\bdone (?:when|once)\b|\byou(?:'re| are| will be|'ll be) done (?:when|once)\b", re.IGNORECASE
)
_DAY = (
    rf"(?:{'|'.join(reading.WEEKDAYS)}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{{1,2}}|"
    r"\d{4}-\d\d-\d\d|today|tonight|tomorrow|(?:the )?end of (?:today|the day|the week|this week))"
)
#: "Do it by Monday", "Finish that by December 2": a deadline that stands on its own.
_DO_BY = re.compile(
    rf"^\W*(?:and |then |so )?(?:do|finish|complete|start|aim to finish|have|get) (?:it|this|that|them|the \w+)?\s*"
    rf"(?:done |finished )?(?:by|before|on)\b[^.!?]{{0,12}}{_DAY}",
    re.IGNORECASE,
)
_DEADLINE = re.compile(
    rf"\b(?:by|due|until|no later than)\s+(?:on\s+)?(?:this\s+|next\s+|the\s+)?({_DAY}(?:,\s*[a-z]+\.? \d{{1,2}})?)",
    re.IGNORECASE,
)
_ACK = re.compile(
    r"^\W*(?:got it|ok(?:ay)?|right|great|sure|thanks?|thank you|i hear you|fine|good|alright|all right|understood|noted|"
    r"let's (?:get this done|start|begin|move forward|do it|get (?:it|this) \w+|start the \w+))\b[^.!?]{0,30}[.!?]*$",
    re.IGNORECASE,
)
#: An identity sentence on its own: "I'm Corin.", "I'm Corin, an AI mentor."
_IDENTITY = re.compile(
    r"^\W*(?:hi,? |hello,? )?I(?:'m| am) (?:[A-Z][a-z]+(?:'s)?(?: vEIR)?|(?:an? |your )(?:AI|virtual|digital)\b[^.!?]*)"
    r"(?:,[^.!?]*)?[.!]?\W*$"
)
_ASKED = re.compile(
    r"\?|\b(?:give|tell|help|show|explain|write|draft|walk|work out|make|fill|list|cite)\b[^.!?]{0,20}\b(?:me|us|my|it|"
    r"something|a|an|the)\b|\bhow (?:do|can|should|would|much|many)\b|\bwhat(?:'s| is| do| should| would)\b|\bi need\b",
    re.IGNORECASE,
)


#: "I'll email them by Friday": a promise, not an ask.
_PROMISE = re.compile(r"\b(?:i|we)(?:'ll| will|'m going to| am going to|'re going to)\b", re.IGNORECASE)


def asks(founder: str) -> bool:
    """Whether the founder's message asks for something (a question, or a request), not only tells or promises it."""
    text = reading.plain(founder)
    if "?" in text:
        return True
    return bool(_ASKED.search(text)) and not _PROMISE.search(text)


def step_texts(t: ReplyTurn) -> list[str]:
    """Everything that is the step's own text: its title, sub-steps with their how, its done-check (both steps')."""
    out: list[str] = []
    for step in (t.step, t.path_step):
        if step is None:
            continue
        out += reading.step_targets(step)
        for item in step.get("items") or []:
            if isinstance(item, Mapping):
                out.append(f"{item.get('do', '')} {item.get('how', '')}")
    return [x for x in out if x.strip()]


def _is_step_text(sentence: str, targets: Iterable[set[str]]) -> bool:
    stems = reading.content_stems(sentence)
    return len(stems) >= 3 and any(reading.overlap(stems, target) >= 0.6 for target in targets)


def _declares(sentence: str) -> bool:
    return bool(_LABEL.search(sentence) or _NEXT_DO.search(sentence))


def _is_step_line(sentence: str, targets: Iterable[set[str]]) -> bool:
    return bool(
        _declares(sentence)
        or _STARTS.match(sentence)
        or _DONE.search(sentence)
        or _DO_BY.search(sentence)
        or _is_step_text(sentence, targets)
    )


def _targets(t: ReplyTurn) -> list[set[str]]:
    return [reading.content_stems(x) for x in step_texts(t)]


# The figure --------------------------------------------------------------------------------------------------------


def answers_the_number(t: ReplyTurn) -> Grade:
    """The figure they asked for, which the conversation or the record gives, is in the reply."""
    if not t.expect.number:
        return NA
    wanted = {float(n.replace(",", "")) for n in t.expect.number}
    said = reading.values(t.text)
    if any(
        abs(v - w) <= max(0.005 * abs(w), 0.004, 1.0 if abs(w) >= 100 else 0.0) for v in said for w in wanted
    ):
        return PASS
    # A count that must be reached is said as the next whole one ("62" for 61.3), never a small one or a length of time.
    reached = workings.counts_to_reach(t.reply, t.founder)
    if any(w >= 10 and w != int(w) and math.ceil(w) in reached for w in wanted):
        return PASS
    return fail("not_said: " + ", ".join(sorted(t.expect.number)))


# The shape of the reply --------------------------------------------------------------------------------------------

_MID_START = re.compile(
    rf"^\W*(?:(?:do|finish|complete) (?:it|this|that) by\b|done when\b|by (?:next )?{_DAY}|then\b(?! again)|also\b|and\b|"
    r"but\b|\(\d+ min|or\b)",
    re.IGNORECASE,
)
#: "One card." "Two lines.": a scrap of another line.
_ORPHAN = re.compile(r"^\W*(?:[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive|\d+) [a-z]+\.$|^In \d+ minutes\.$")
#: A reply shorter than this whose words besides the step's are fewer than these says the step and nothing else.
_SHORT_REPLY = 60
_SUBSTANCE_WORDS = 8


def no_fragment(t: ReplyTurn) -> Grade:
    """A whole reply: it does not start mid-thought, hold a scrap of another line, or answer an ask with a step line alone."""
    if t.expect.kind in ("crisis", "rehearsal") or not t.reply.strip():
        return NA
    said = reading.sentences(t.text)
    first = said[0] if said else ""
    if _MID_START.search(first) or re.match(r"^[a-z]", first.lstrip("\"'“*_ ")):
        return fail("starts_mid_thought: " + first)
    # An answer may open with how many parts it has ("Five sentences."); inside one it is another line's scrap.
    orphan = next((s for s in said[1:] if _ORPHAN.match(s)), None)
    if orphan is not None:
        return fail("scrap: " + orphan)
    targets = _targets(t)
    for i, s in enumerate(said):
        # "Do it by Friday" with nothing before it that could be "it".
        if _DO_BY.search(s) and not any(
            _declares(x) or _is_step_text(x, targets) or _imperative(x) for x in said[:i]
        ):
            return fail("deadline_for_nothing: " + s)
    if t.expect.kind == "social" or asks_next(t.founder) or not asks(t.founder):
        return PASS
    rest = [
        s
        for s in said
        if not (_is_step_line(s, targets) or _ACK.match(s) or _IDENTITY.match(s)) and not s.endswith("?")
    ]
    words = sum(len(reading.words(s)) for s in rest)
    short = len(reading.words(t.text)) < _SHORT_REPLY
    return verdict(words >= _SUBSTANCE_WORDS or not short, f"only_a_step_line: {words} words besides it")


def _imperative(sentence: str) -> bool:
    return bool(re.match(rf"^\W*(?:now |then |first,? |next,? |just )?{_VERB}\b", sentence, re.IGNORECASE))


#: A day told back from the story ("you said you would ... by Friday") is no deadline set now.
_TOLD = re.compile(
    r"\byou (?:said|were going|told|agreed|promised|planned|set|reported)\b|\bwas due\b|\bwe (?:set|agreed)\b",
    re.IGNORECASE,
)
#: A line to say or send ("ready by Monday" in an offer is no deadline of the step).
_QUOTED = re.compile(r"[\"“][^\"“”]*[\"”]?")


def _deadlines(t: ReplyTurn, sentence: str) -> set[str]:
    """The deadlines one sentence sets, each as a date where it can be read as one."""
    if _TOLD.search(sentence):
        return set()
    unquoted = _QUOTED.sub(" ", sentence)
    return {_day_key(t, m.group(1)) for m in _DEADLINE.finditer(unquoted)}


def _day_key(t: ReplyTurn, said: str) -> str:
    dates = reading.dates_in(said)
    if dates:
        month, day = next(iter(dates))
        return f"{month}/{day}"
    word = said.lower()
    today = t.today
    if today is None:
        return word
    if "today" in word or "tonight" in word or "the day" in word:
        return f"{today.month}/{today.day}"
    if "tomorrow" in word:
        day = today + dt.timedelta(days=1)
        return f"{day.month}/{day.day}"
    if word in reading.WEEKDAYS:
        for due in (reading.due_date(t.step), reading.due_date(t.path_step)):
            if due is not None and reading.WEEKDAYS[due.weekday()] == word:
                return f"{due.month}/{due.day}"
        ahead = (reading.WEEKDAYS.index(word) - today.weekday()) % 7 or 7
        day = today + dt.timedelta(days=ahead)
        return f"{day.month}/{day.day}"
    return word


def _template_lines(t: ReplyTurn) -> set[str]:
    """The lines of the steps' own templates, as words: a line of one that the reply hands over says no step."""
    out = set()
    for step in (t.step, t.path_step):
        template = (step or {}).get("template")
        body = str(template.get("body") or "") if isinstance(template, Mapping) else ""
        out |= {" ".join(reading.words(ln)) for ln in body.split("\n") if len(reading.words(ln)) >= 3}
    return out


def single_step_line(t: ReplyTurn) -> Grade:
    """One step said once: one declaration, one deadline, one done-check, and at most one line of what to do first."""
    if t.expect.kind in ("crisis", "rehearsal", "recall") or not t.reply.strip():
        return NA
    template = _template_lines(t)
    said = [s for s in reading.sentences(t.text) if " ".join(reading.words(s)) not in template]
    labels = [s for s in said if _declares(s)]
    if len(labels) > 1:
        return fail("declared_twice: " + " | ".join(labels))
    starts = [s for s in said if _STARTS.match(s)]
    if len(starts) > 1:
        return fail("starts_twice: " + " | ".join(starts))
    done = [s for s in said if _DONE.search(s)]
    if len(done) > 1:
        return fail("done_twice: " + " | ".join(done))
    own = {_day_key(t, d) for d in _founder_days(t)}
    deadlines: set[str] = set()
    for s in said:
        deadlines |= _deadlines(t, s) - own
    if len(deadlines) > 1:
        return fail("deadlines: " + ", ".join(sorted(deadlines)))
    alone = [s for s in said if _DO_BY.search(s) and not (_deadlines(t, s) & own or _TOLD.search(s))]
    labelled = [s for s in labels if _DEADLINE.search(s)]
    if len(alone) > 1 or (alone and labelled):
        return fail("deadline_twice: " + " | ".join([*alone, *labelled]))
    return PASS


def _founder_days(t: ReplyTurn) -> list[str]:
    """Days the founder named in this message (their own event or promise is no second deadline)."""
    text = reading.plain(t.founder)
    return [m.group(0) for m in re.finditer(_DAY, text, re.IGNORECASE)]


_WEEKDAY_DATE = re.compile(
    rf"\b({'|'.join(reading.WEEKDAYS)}),?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{{1,2}})",
    re.IGNORECASE,
)


def _real_weekday(today: dt.date, month: int, day: int) -> str | None:
    """The weekday of a date near today (within half a year either way)."""
    best: dt.date | None = None
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            found = dt.date(year, month, day)
        except ValueError:
            continue
        if best is None or abs((found - today).days) < abs((best - today).days):
            best = found
    return None if best is None else reading.WEEKDAYS[best.weekday()]


def no_step_by_model_dates(t: ReplyTurn) -> Grade:
    """Dates come from the guidance, the founder or the record; a weekday written with a date is that date's own."""
    if not t.reply.strip() or t.today is None:
        return NA
    named = reading.dates_in(t.text)
    deadlines = [m.group(1).lower() for m in _DEADLINE.finditer(t.text)]
    if not named and not deadlines:
        return NA
    for m in _WEEKDAY_DATE.finditer(t.text):
        for month, day in reading.dates_in(m.group(2)):
            real = _real_weekday(t.today, month, day)
            if real is not None and real != m.group(1).lower():
                return fail(f"wrong_weekday: {m.group(0)}")
    due = [d for d in (reading.due_date(t.step), reading.due_date(t.path_step)) if d is not None]
    allowed = reading.dates_in(t.sources) | t.established_dates | {(d.month, d.day) for d in due}
    allowed |= {(t.today.month, t.today.day)}
    wrong = sorted(named - allowed)
    if wrong:
        return fail("date: " + ", ".join(f"{m}/{d}" for m, d in wrong))
    given = f"{t.founder_said}\n{t.known}".lower()
    days = {reading.WEEKDAYS[d.weekday()] for d in due} | {w for w in reading.WEEKDAYS if w in given}
    for month, day in named & allowed:
        real = _real_weekday(t.today, month, day)
        if real is not None:
            days.add(real)
    # Today and tomorrow as deadlines are days like any other (a suggestion for this evening is no deadline).
    for word, day in (("today", t.today), ("tomorrow", t.today + dt.timedelta(days=1))):
        if any(word in d for d in deadlines) and day not in due and word not in given:
            return fail(f"deadline: {word}")
    loose = [d for d in deadlines if d in reading.WEEKDAYS and d not in days]
    return verdict(not loose, "deadline: " + ", ".join(loose))


# What is said of the founder -----------------------------------------------------------------------------------------

#: A filled line of a template, in the founder's voice ("Why me: I study ..."), never a proposal ("I would", "I'll").
_FILLED = re.compile(r"(?m)^\s*(?:\d{1,2}[.)]|[-*+•])\s+(.*)$")
_FIRST_PERSON = re.compile(
    r"\bI(?:'m| am|'ve| have| can| know| study| work| run| own| built| live| met| saw| did| already)\b.*",
    re.IGNORECASE,
)
_COMMON = frozenset(
    reading.content_stems(
        "know can talk reach study see saw get make have use help am student students idea people thing things "
        "experience background access skills insight good able learn learned real one"
    )
)
#: Sales and buyers are one subject, however they are said.
_SAME = dict.fromkeys(
    reading.content_stems(
        "pay pays paid paying payer buy buys bought buyer buyers buying sell sells sold sale sales selling customer "
        "customers client clients purchase purchased order orders ordered ticket tickets charge charged"
    ),
    "pay",
)
_FACT_NOUN = frozenset(
    reading.content_stems(
        "customer customers user users revenue sale sales pilot pilots prototype cofounder co-founder team patent "
        "interview interviews signup signups waitlist contract contracts investor investors grant grants employee "
        "employees paying buyers orders subscribers partner partners"
    )
) | {"pay"}
_YOU_HAVE = re.compile(
    r"\byou(?:'ve)?(?:\s+(?:still|already|now|currently|also))*\s*(?:have|had|got|sold|talked to|interviewed|signed|"
    r"launched|raised|built|tested|proved|ran)\b([^.!?;]{3,90})",
    re.IGNORECASE,
)
_HYPOTHETICAL = re.compile(
    r"\b(?:if|when|once|until|whether|unless|should|would|could|after|before|need to|want to|until you|done when|so that|"
    r"as soon as|the more|every time|no|not|n't|haven't)\b",
    re.IGNORECASE,
)
_PLACEHOLDER = re.compile(r"\[[^\]]+\]|[“\"]")


def _merged(stems: Iterable[str]) -> set[str]:
    return {_SAME.get(s, s) for s in stems}


def _of_founder(t: ReplyTurn) -> set[str]:
    return _merged(reading.content_stems(f"{t.founder_said}\n{t.known}"))


def no_invented_founder_fact(t: ReplyTurn) -> Grade:
    """Nothing about the founder that they, their record or arithmetic on it did not say."""
    if not t.reply.strip() or t.expect.kind == "rehearsal":
        return NA
    known = _of_founder(t)
    for m in _FILLED.finditer(t.text):
        line = m.group(1)
        claim = _FIRST_PERSON.search(line)
        if claim is None or _PLACEHOLDER.search(line) or _IDENTITY.match(line):
            continue
        stems = _merged(reading.content_stems(re.sub(r"\((?:seen|guess)[^)]*\)", " ", claim.group(0))))
        stems -= _merged(_COMMON)
        if stems and reading.overlap(stems, known) < 0.8:
            return fail("template: " + claim.group(0))
    targets = _targets(t)
    for sentence in reading.sentences(t.text):
        # The step's own words ("List what you have shown ...") claim nothing.
        if sentence.rstrip("\"”')*_ ").endswith("?") or _is_step_line(sentence, targets):
            continue
        for m in _YOU_HAVE.finditer(sentence):
            if _HYPOTHETICAL.search(sentence[: m.start()]) or _HYPOTHETICAL.search(m.group(0)):
                continue
            stems = _merged(reading.content_stems(m.group(1)))
            facts = stems & _FACT_NOUN
            if facts and not facts & known:
                return fail("claim: " + m.group(0))
    money = _loose_money(t)
    return verdict(not money, "money: " + ", ".join(f"{v:g}" for v in money))


def _loose_money(t: ReplyTurn) -> list[float]:
    """Amounts of money nobody gave as money, and that are no arithmetic on amounts that were."""
    evidence = "\n".join(f"{e.get('excerpt', '')}" for e in t.evidence)
    given = f"{t.founder_said}\n{t.known}\n{reading.leaf_text(t.guidance)}\n{evidence}"
    amounts = {f.value for f in reading.figure_list(given) if "money" in f.classes}
    # What the founder or the record said is theirs, with its unit or without it ("charging 25 a pickup").
    amounts |= reading.values(f"{t.founder_said}\n{t.known}") | t.established
    sums = workings.of_turn(t)
    out = []
    stated = [f for f in reading.figure_list(sums.rest) if "money" in f.classes]
    counts = {f.value for f in reading.figure_list(t.reply) if not f.classes} | reading.spelled_values(
        t.reply
    )
    for f in stated:
        if f.value in amounts or f.value in sums.proven:
            continue
        if f.value not in sums.wrong and reading.derivable(
            f.value, amounts, period=reading.says_period(t.text)
        ):
            continue
        # An amount, so many times ("two kites at 16 dollars are 32").
        if f.value not in sums.wrong and any(
            reading.derivable(f.value, (a, c)) for a in amounts for c in counts if a != c
        ):
            continue
        out.append(f.value)
    return out


# Words that are not for a founder -------------------------------------------------------------------------------------

_INTERNAL = re.compile(
    r"\bplaybooks?\b|\b(?:the|this|that|your|my|a) play(?:'s)? (?:says?|is|card|answers?|tells?|for this)\b|\bon record:|"
    r"\bpath engine\b|\b(?:the|your|this|my) guidance\b|\bguidance (?:says|step|card)\b|\bevidence (?:pack|key)\b|"
    r"\b(?:system|developer) prompt\b|\b(?:domain|stage|one-?liner): [a-z_]+\.|\bcriteri(?:on|a)\b|\bstep id\b|"
    r"^\W*kept: |\bnothing is taken back\b",
    re.IGNORECASE | re.MULTILINE,
)
_CRITERIA_OK = re.compile(
    r"\b(?:judging|grading|scoring|selection|eligibility|inclusion|exclusion|evaluation|entry|pass|acceptance|their|"
    r"judges'?|competition(?:'s)?|success) criteri(?:on|a)\b",
    re.IGNORECASE,
)


def no_internal_words(t: ReplyTurn) -> Grade:
    """No word of the machinery behind the reply (unless the founder used it first)."""
    if not t.reply.strip():
        return NA
    theirs = t.founder_said.lower()
    for m in _INTERNAL.finditer(_CRITERIA_OK.sub(" ", t.text)):
        word = m.group(0)
        if word.lower() not in theirs:
            return fail(word)
    return PASS


_ASKS_WHO = re.compile(
    r"\bwho (?:are|r) (?:you|u)\b|\byour name\b|\bwho am i (?:talking|speaking)\b|\bwhat are you\b",
    re.IGNORECASE,
)


def no_identity_leak(t: ReplyTurn) -> Grade:
    """The coach's identity is said first, once, when a conversation opens, or when asked; never inside an answer."""
    if not t.reply.strip() or SINCERE_IDENTITY.search(t.founder) or _ASKS_WHO.search(t.founder):
        return NA
    said = reading.sentences(t.text)
    for i, sentence in enumerate(said):
        if _IDENTITY.match(sentence) and (i > 0 or t.earlier):
            return fail(sentence)
    return PASS


_ENTRY_NOISE = frozenset(
    reading.content_stems(
        "record on decided current idea far last conversation step open due next founder your you so now still"
    )
)


def _entry(sentence: str) -> set[str]:
    """A story entry's content, its label, its date and its numbers' spelling aside."""
    body = re.sub(r"^\W*[A-Z][^:.!?]{0,40}:\s*", "", reading.without_dates(sentence))
    stems = reading.content_stems(body) - _ENTRY_NOISE
    spelled = {"two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8"}
    spelled |= {"nine": "9", "ten": "10"}
    return {spelled.get(s, s) for s in stems if s not in reading.WEEKDAYS and s.rstrip("0123456789") != "e"}


_ENTRY = re.compile(
    r"^\W*(?:on record|decided on|so far|last (?:time|conversation)|open step|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|"
    r"nov|dec)[a-z]*\.? \d{1,2}:)",
    re.IGNORECASE,
)


def no_duplicate_story_entries(t: ReplyTurn) -> Grade:
    """What was said before is told once: no event or fact twice in other words."""
    said = reading.sentences(t.text)
    entries = [s for s in said if _ENTRY.match(s)]
    if t.expect.kind != "recall" and len(entries) < 2:
        return NA
    pool = [(s, _entry(s)) for s in said]
    for i, (a, x) in enumerate(pool):
        for b, y in pool[i + 1 :]:
            small = x if len(x) <= len(y) else y
            listed = _ENTRY.match(a) or _ENTRY.match(b)
            need = 2 if _ENTRY.match(a) and _ENTRY.match(b) else 4
            if listed and len(small) >= need and reading.overlap(small, x & y) >= 0.75:
                return fail(f"{a} | {b}")
    return PASS


# What the founder brought ---------------------------------------------------------------------------------------------

_RESULT = re.compile(
    r"\b(?:i|we)(?:'ve| have)? (?:did|ran|talked|interviewed|asked|sold|tested|got|launched|signed|offered|surveyed|met|"
    r"tried|showed|pitched|called|emailed|opened)\b|\b(?:said|bought|paid|signed up|came back|replied|dropped|quit|"
    r"complained|refused|agreed)\b",
    re.IGNORECASE,
)
_MEANING = re.compile(
    r"\bmean(?:s|ing)?\b|\bshows?\b|\bsuggests?\b|\btells? (?:you|us)\b|\bpoints? to\b|\bprov(?:es?|en)\b|\bproof\b|"
    r"\bbecause\b|\bper ?cent\b|%|\bout of\b|\brate\b|\bnot (?:yet )?(?:enough|proof|the same)\b|\bisn't\b|\bdoesn't\b|"
    r"\bweak\w*\b|\bstrong\w*\b|\binstead of\b|\brather than\b|\bthe real (?:problem|issue|buyer|customer)\b|\bso (?:the|"
    r"your|stop|drop|keep|change|it|that|this|they|price|build|sell|do)\b|\bunless\b|\bless than\b|\bmore than\b|"
    r"\b(?:above|below|under|over) (?:your|the)\b|\bhalf\b|\bmost of\b",
    re.IGNORECASE,
)
#: Praise or a count is no reading of a result.
_EMPTY_PRAISE = re.compile(
    r"^\W*(?:got it\W*)?(?:that(?:'s| is)|this is) (?:a |an )?(?:very |really )?(?:strong|good|great|promising|solid|useful|"
    r"clear|encouraging) \w+\W*$",
    re.IGNORECASE,
)


def news_interpreted(t: ReplyTurn) -> Grade:
    """A result they report is read: its own words or numbers, and what they mean."""
    authored = bool(t.expect.news)
    result = (
        t.expect.kind == "report"
        and bool(_RESULT.search(t.founder))
        and bool(reading.values(t.founder))
        and "?" not in t.founder
    )
    if not authored and not result:
        return NA
    said = [
        s for s in reading.sentences(t.text) if not (_LABEL.search(s) or _DONE.search(s) or _STARTS.match(s))
    ]
    said = [s for s in said if not s.endswith("?") and not _EMPTY_PRAISE.match(s)]
    text = " ".join(said)
    if authored and not any(fact_named(text, t.facts[f]) for f in t.expect.news):
        return fail("finding_not_read: " + ",".join(t.expect.news))
    if not any(_MEANING.search(s) for s in said):
        return fail("no_meaning")
    if authored:
        return PASS
    mine = reading.content_stems(t.founder)
    read = any(_MEANING.search(s) and len(reading.content_stems(s) & mine) >= 2 for s in said)
    derived = reading.values(text) - reading.values(t.founder) - reading.values(reading.leaf_text(t.guidance))
    return verdict(read or bool(derived), "counted_not_read")


_NOVICE = re.compile(
    r"\bnever (?:done|started|run|built|sold) (?:this|any|one|a business|a company|anything)|\bfirst[- ]time\b|\bmy first "
    r"(?:startup|company|venture|business)|\bnew to (?:this|all this|business|startups?)\b|\bknow (?:nothing|little|next to "
    r"nothing) about (?:business|any of this|startups?|this)|\b(?:don't|do not) (?:really )?(?:know|understand|get) (?:the |"
    r"any(?:thing)? (?:about )?(?:the )?)?(?:business|startup|money)|\bnot a business (?:person|major)|\bno (?:business )?"
    r"background\b|\bzero business\b|\bno clue about (?:business|any of this)",
    re.IGNORECASE,
)
#: Words of the method a newcomer does not have, beside the glossary's.
_METHOD_WORDS: dict[str, re.Pattern[str]] = {
    "jobs, pains and gains": re.compile(r"\bjobs\b[^.!?]{0,60}\bpains\b[^.!?]{0,60}\bgains\b", re.IGNORECASE),
    "customer segment": re.compile(r"\b(?:customer|market) segments?\b", re.IGNORECASE),
    "canvas": re.compile(r"\bcanvas\b", re.IGNORECASE),
    "channel": re.compile(r"\b(?:marketing|sales|acquisition) channels?\b", re.IGNORECASE),
    "pipeline": re.compile(r"\bsales (?:pipeline|funnel)\b", re.IGNORECASE),
    "traction": re.compile(r"\btraction\b", re.IGNORECASE),
    "stakeholder": re.compile(r"\bstakeholders?\b", re.IGNORECASE),
    "hypothesis": re.compile(r"\bhypothes[ie]s\b", re.IGNORECASE),
}
#: The most separate instructions a newcomer is given in one reply's prose.
_NOVICE_STEPS = 7


def is_novice(t: ReplyTurn) -> bool:
    return bool(_NOVICE.search(reading.plain(t.founder_said)))


def unexplained(t: ReplyTurn) -> list[str]:
    """Business words the reply uses that nobody explained: not the founder's own, and given no meaning here or before."""
    ours = [*(c for _, c in t.earlier), t.text]
    return [
        name
        for words in (GLOSSARY, _METHOD_WORDS)
        for name, pattern in words.items()
        if pattern.search(t.text)
        and not pattern.search(t.founder_said)
        and not any(defined(reading.plain(x), pattern) for x in ours)
    ]


def first_time_adapted(t: ReplyTurn) -> Grade:
    """Someone who says they are new to this gets plain words (or each business word's meaning), about their own idea."""
    if not (t.expect.adapt or (t.first_time and is_novice(t))):
        return NA
    if t.expect.kind in ("social", "crisis", "rehearsal", "privacy") or not t.reply.strip():
        return NA
    missing = unexplained(t)
    if missing:
        return fail("undefined: " + ", ".join(missing))
    own = reading.content_stems(f"{t.venture_name} {t.known} {t.founder_said}") - _COMMON
    generic = reading.content_stems(
        "idea week step talk problem business plan product money price customer sell pay test"
    )
    said = reading.content_stems(t.text)
    if len((own - generic) & said) < 2:
        return fail("not_their_idea")
    many = sum(1 for s in reading.sentences(t.text) if _imperative(s))
    return verdict(many <= _NOVICE_STEPS, f"{many} instructions")


# Form -------------------------------------------------------------------------------------------------------------------

_NUMBERED = re.compile(r"(?m)^\s*(\d{1,2})[.)]\s+(.*)$")
#: A list item that runs on into a step line.
_GLUED = re.compile(
    r"\((?:seen|guess)\)[ \t]+(?:do|done|next|by)\b|[a-z)][ \t]+(?:Do (?:it|this|that) by|Done when|Next:)[ \t]",
)
_ANNOUNCES = re.compile(
    r"\b(two|three|four|five|six|seven|[2-7])[- ](?:\w+ ){0,2}?(?:lines?|steps?|questions?|things|parts|boxes|rows)\b",
    re.IGNORECASE,
)
_COUNT = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}
_LOOSE_MINUTES = re.compile(
    r"[.!?\]][ \t]*\(\d{1,3} min(?:utes)?\)[ \t]+[A-Z]|\(\d{1,3} min(?:utes)?\)[ \t]+by\b"
)
_UNFILLED = re.compile(r"\$[XYZN]\b|\bX (?:dollars|percent|customers|people)\b")


def list_formatting(t: ReplyTurn) -> Grade:
    """A list is whole (every item it announces), and nothing is glued to its items or left over from one."""
    if t.channel == "call" or not t.reply.strip():
        return NA
    text = t.reply
    glued = next((m.group(0) for m in _GLUED.finditer(text)), None)
    if glued is not None:
        return fail("glued: " + glued)
    loose = _LOOSE_MINUTES.search(text)
    if loose is not None:
        return fail("left_over: " + loose.group(0))
    if _UNFILLED.search(text):
        return fail("unfilled: " + (_UNFILLED.search(text) or [""])[0])
    items = list(_NUMBERED.finditer(text))
    if len(items) == 1:
        return fail("list_of_one")
    if items:
        announced = list(_ANNOUNCES.finditer(text[: items[0].start()]))
        if announced:
            word = announced[-1].group(1).lower()
            count = _COUNT.get(word) or int(word)
            if len(items) < count:
                return fail(f"cut_short: {len(items)} of {count}")
    days = re.findall(r"(?mi)^\W*week (\d)\b", text)
    asked = re.search(r"\b(two|three|four|\d) weeks?\b", t.founder, re.IGNORECASE)
    if days and asked:
        word = asked.group(1).lower()
        weeks = _COUNT.get(word) or (int(word) if word.isdigit() else 1)
        if len(set(days)) < weeks <= 4:
            return fail(f"cut_short: {len(set(days))} of {weeks} weeks")
    return PASS


_SAME_SENTENCE = 0.8
#: A reply two fifths of which was said before is that reply again, with something added.
_SAME_SHARE = 0.4
#: What joins or turns a sentence without adding to it.
_JOINERS = frozenset(reading.content_stems("because why don't not no now so yes"))
_MIN_WORDS = 4
#: The path's own step, as the server says it under an answer to something else.
_PATH_LINE = re.compile(r"^\W*on your path, next is\b", re.IGNORECASE)
#: A sentence that sends them to who decides.
_REFERS = re.compile(r"^\W*(?:talk to|ask|see|speak (?:to|with)|a qualified person decides)\b", re.IGNORECASE)
_ENOUGH_BESIDES = 3


def repeats_previous_reply(t: ReplyTurn) -> Grade:
    """Not an earlier reply of the conversation over again (the step's own words aside), unless asked to repeat."""
    if not t.same_session or t.expect.kind in ("recall", "crisis", "rehearsal"):
        return NA
    if REPEAT_REQUEST.search(t.founder):
        return NA
    own = _targets(t)
    referral = (t.guidance or {}).get("referral")
    if referral:
        own.append(reading.content_stems(reading.leaf_text(referral)))
    who = re.split(r"[,;]", str(referral.get("who") or ""))[0] if isinstance(referral, Mapping) else ""
    named = reading.content_stems(who)

    def refers(stems: set[str], s: str) -> bool:
        return len(named) >= 2 and named <= stems and bool(_REFERS.match(s))

    def lines(text: str) -> list[tuple[set[str], bool]]:
        out = []
        for s in reading.sentences(reading.plain(text)):
            if len(reading.words(s)) < _MIN_WORDS or _declares(s) or _DONE.search(s) or _DO_BY.search(s):
                continue
            if _is_step_text(s, own) or _PATH_LINE.match(s):
                continue
            stems = reading.content_stems(s) - _JOINERS
            if len(stems) >= 2:
                out.append((stems, refers(stems, s)))
        return out

    all_mine = lines(t.reply)
    # Who decides is said again whenever it applies: that line is set aside in a reply that says enough besides it.
    besides = [x for x, refer in all_mine if not refer]
    mine = besides if len(besides) >= _ENOUGH_BESIDES else [x for x, _ in all_mine]
    before = [x for reply in t.same_session for x, _ in lines(reply)]
    again = [x for x in mine if any(reading.overlap(x, b) >= _SAME_SENTENCE for b in before)]
    if not mine:
        # Nothing but the step: over again when an ask is answered with lines that were all said before.
        said = [
            " ".join(reading.words(x))
            for x in reading.sentences(t.text)
            if len(reading.words(x)) >= _MIN_WORDS and not _ACK.match(x)
        ]
        flat = [f" {' '.join(reading.words(reading.plain(r)))} " for r in t.same_session]
        known = [x for x in said if any(f" {x} " in r for r in flat)]
        asked = asks(t.founder) and not asks_next(t.founder)
        return verdict(not (asked and said and len(known) == len(said)), "the step line again")
    share = len(again) / len(mine)
    repeated = share >= _SAME_SHARE and (len(again) >= 2 or len(again) == len(mine))
    return verdict(not repeated, f"{len(again)} of {len(mine)}")


STRICT: dict[str, Callable[[ReplyTurn], Grade]] = {
    "answers_the_number": answers_the_number,
    "no_fragment": no_fragment,
    "single_step_line": single_step_line,
    "no_step_by_model_dates": no_step_by_model_dates,
    "no_invented_founder_fact": no_invented_founder_fact,
    "no_internal_words": no_internal_words,
    "no_identity_leak": no_identity_leak,
    "no_duplicate_story_entries": no_duplicate_story_entries,
    "news_interpreted": news_interpreted,
    "first_time_adapted": first_time_adapted,
    "list_formatting": list_formatting,
    "repeats_previous_reply": repeats_previous_reply,
}
