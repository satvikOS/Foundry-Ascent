"""How the client graders read a reply: sentences, content words, figures, dates, questions put to the founder. Shared
readings come from the live suite's checks (``live/checks.py``), so both suites read a reply the same way."""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Mapping
from typing import Any

from conversation_lab.live.checks import (
    _APOSTROPHES,
    Figure,
    _question_clauses,
    _spelled_numbers,
    figures,
    in_quotation,
    put_to_student,
)
from conversation_lab.live.checks import _content as content_stems

__all__ = ["content_stems", "figures"]

CITATION_KEY = re.compile(r"\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\](?!\()", re.IGNORECASE)
_LIST_MARK = re.compile(r"(?m)^\s*(?:[-*+•]|\d{1,2}[.)])\s+")
_SPLIT = re.compile(r"(?<=[.!?])[\"”')\]*_]*\s+|\n+")
_MONTHS = {
    name: i
    for i, name in enumerate(
        (
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ),
        start=1,
    )
}
_MONTH = (
    r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?)"
)
_DAY = r"(\d{1,2})(?:st|nd|rd|th)?"
_DATE_FORMS = (
    re.compile(rf"\b{_MONTH}\.?\s+{_DAY}\b(?:,?\s+(?:19|20)\d\d)?", re.IGNORECASE),
    re.compile(rf"\b{_DAY}\s+(?:of\s+)?{_MONTH}\b(?:,?\s+(?:19|20)\d\d)?", re.IGNORECASE),
    re.compile(r"\b(?:19|20)\d\d-(\d\d)-(\d\d)\b"),
    re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(?:19|20)?\d\d)?\b"),
)
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_YEAR = re.compile(r"\b(?:19|20)\d\d\b")
_TIME = re.compile(
    r"\b\d{1,2}(?::\d\d)\s*(?:[ap]\.?m\.?)?\b|\b\d{1,2}\s*[ap]\.?m\b\.?|\b24/7\b", re.IGNORECASE
)


def plain(text: str) -> str:
    """The reply with apostrophes made straight and evidence keys removed."""
    return CITATION_KEY.sub("", (text or "").translate(_APOSTROPHES))


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SPLIT.split(_LIST_MARK.sub("\n", text or "")) if s.strip(" *_#>-•")]


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def questions_to_founder(reply: str) -> list[str]:
    """The questions put to the founder: never one quoted for them to say, nor one in a list they are to ask others."""
    out = []
    for clause in _question_clauses(reply):
        if in_quotation(reply, clause) or not put_to_student(reply, clause):
            continue
        out.append(clause)
    return out


def overlap(of: Iterable[str], within: Iterable[str]) -> float:
    a, b = set(of), set(within)
    return len(a & b) / len(a) if a else 0.0


# Figures -----------------------------------------------------------------------------------------------------


def _month_number(name: str) -> int:
    return next(i for full, i in _MONTHS.items() if full.startswith(name.lower()[:3]))


def dates_in(text: str) -> set[tuple[int, int]]:
    """Every (month, day) a text names."""
    out: set[tuple[int, int]] = set()
    for i, form in enumerate(_DATE_FORMS):
        for m in form.finditer(text or ""):
            if i == 0:
                month, day = _month_number(m.group(1)), int(m.group(2))
            elif i == 1:
                month, day = _month_number(m.group(2)), int(m.group(1))
            else:
                month, day = int(m.group(1)), int(m.group(2))
            if 1 <= month <= 12 and 1 <= day <= 31:
                out.add((month, day))
    return out


def shifted(days: Iterable[tuple[int, int]], back: int, today: dt.date) -> set[tuple[int, int]]:
    """Dates moved back with the conversation they were said in (``back`` days), each also as it was said."""
    out: set[tuple[int, int]] = set()
    for month, day in days:
        out.add((month, day))
        try:
            moved = dt.date(today.year, month, day) - dt.timedelta(days=back)
        except ValueError:
            continue
        out.add((moved.month, moved.day))
    return out


def without_dates(text: str) -> str:
    """A text with its dates, clock times, years, list numbers and evidence keys blanked: what is left is figures."""
    out = _LIST_MARK.sub("\n", plain(text))
    for form in _DATE_FORMS:
        out = form.sub(" ", out)
    out = _YEAR.sub(" ", _TIME.sub(" ", out))
    # "50 cents" and "$0.50" are one amount.
    return _CENTS.sub(lambda m: f"${int(m.group(1)) / 100:.2f}", out)


_CENTS = re.compile(r"(?<![\d.,$])(\d{1,2}) cents\b", re.IGNORECASE)


def figure_list(text: str) -> list[Figure]:
    return figures(without_dates(text))


def spelled_values(text: str) -> set[float]:
    return {float(v) for v in _spelled_numbers(without_dates(text))}


def values(text: str) -> set[float]:
    """Every number a text states, in digits or words."""
    return {f.value for f in figure_list(text)} | spelled_values(text)


_PERIODS = (4.0, 7.0, 12.0, 30.0, 52.0, 60.0)
#: A reply that carries a number over time ("a month", "weekly") may multiply by a period.
_PERIOD_WORD = re.compile(
    r"\b(?:a|per|each|every) (?:day|week|month|year|term|semester|hour)\b|\b(?:dai|week|month|year|hour)ly\b",
    re.IGNORECASE,
)


def says_period(text: str) -> bool:
    return bool(_PERIOD_WORD.search(text or ""))


def _near(result: float, value: float) -> bool:
    rounding = 0.5 if value == int(value) and abs(result) >= 10 else 0.005
    return bool(result) and abs(result - value) <= max(0.005 * abs(result), rounding)


def _pairs(a: float, b: float, percent: bool) -> list[float]:
    results = [a + b, b - a, a * b, a / b, b / a]
    if percent:
        results += [100 * a / b, 100 * (b - a) / b, 100 * (b - a) / a]
    return results


def derivable(
    value: float,
    shown: Iterable[float],
    *,
    given: Iterable[float] = (),
    percent: bool = False,
    period: bool = False,
    shares: Iterable[float] = (),
) -> bool:
    """Whether ``value`` is arithmetic, to within its own rounding: a sum, difference, product or ratio of two different
    numbers the reply shows or the founder's message gave; or, of shown numbers only, a chain of three, or a product
    carried over a period when the reply speaks of one. ``shares``: the percentages among them; a shown number may be
    divided by one, or by what is left of one ("a price that keeps 40 percent")."""
    pool = sorted({o for o in shown if o})
    wide = sorted({*pool, *(o for o in given if o)})
    for i, a in enumerate(wide):
        for b in wide[i + 1 :]:
            if any(_near(r, value) for r in _pairs(a, b, percent)):
                return True
    if percent:
        return False
    parts = {p / 100 for p in shares if 0 < p < 100} | {1 - p / 100 for p in shares if 0 < p < 100}
    if any(_near(r, value) for p in parts for r in (p, *(a / p for a in wide))):
        return True
    for i, a in enumerate(pool):
        if period and any(_near(a * f, value) for f in _PERIODS):
            return True
        for j, b in enumerate(pool[i + 1 :], start=i + 1):
            if period and any(_near(a * b * f, value) for f in _PERIODS):
                return True
            for c in pool[j + 1 :]:
                chains = (
                    *(a * b * c, a * b - c, a * c - b, b * c - a, a * b + c, a * c + b, b * c + a),
                    *((c - a) * b, (c - b) * a, (b - a) * c, c / (b - a), a + b + c, c - a - b, c - b + a),
                )
                if any(_near(r, value) for r in chains):
                    return True
    return False


# Guidance ----------------------------------------------------------------------------------------------------


#: Parts of a guidance that are no words of it: ids' digits are no figures a reply may state.
_NOT_TEXT = frozenset({"id", "version", "url", "sourceId", "completedAt"})


def leaf_text(value: Any) -> str:
    """Every string and number inside a JSON value, as one text (ids, versions and links left out)."""
    if isinstance(value, Mapping):
        return "\n".join(leaf_text(v) for k, v in value.items() if k not in _NOT_TEXT)
    if isinstance(value, list | tuple):
        return "\n".join(leaf_text(v) for v in value)
    return "" if value is None or isinstance(value, bool) else str(value)


def step_of(guidance: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    step = (guidance or {}).get("step")
    return step if isinstance(step, Mapping) else None


def step_targets(step: Mapping[str, Any]) -> list[str]:
    """What a reply may name to name the step: its title, each sub-step and the check that it is done."""
    items = [str(i.get("do", "")) for i in step.get("items") or [] if isinstance(i, Mapping)]
    return [t for t in (str(step.get("title", "")), *items, str(step.get("doneWhen", ""))) if t.strip()]


def step_minutes(step: Mapping[str, Any] | None) -> set[float]:
    """How long the step takes, as a reply may add it up: its first sub-steps together, all of them, the open ones."""
    items = [i for i in (step or {}).get("items") or [] if isinstance(i, Mapping)]
    out: set[float] = set()
    for chosen in (items, [i for i in items if not i.get("done")]):
        total = 0.0
        for item in chosen:
            minutes = item.get("minutes")
            if not isinstance(minutes, int):
                break
            total += minutes
            out.add(total)
    return out


def step_key(step: Mapping[str, Any] | None) -> str | None:
    """What makes two steps the same one: the play, the criterion and the title (ids differ between ventures)."""
    if step is None:
        return None
    return "|".join(str(step.get(k) or "") for k in ("playId", "criterionId", "title"))


#: What makes a sub-step in a sentence the step, not only its subject: a day, "next", "start with", what done means.
_STEP_CUE = re.compile(
    rf"\bnext\b|\bfirst\b|\bthis (?:week|weekend|afternoon|evening|morning)\b|\btoday\b|\btonight\b|\btomorrow\b|"
    rf"\b(?:by|on|before|until) (?:the |next |this )?(?:{'|'.join(WEEKDAYS)}|end\b|{_MONTH})|\bstart (?:with|by)\b|"
    r"\bdone (?:when|once)\b|\bstep\b",
    re.IGNORECASE,
)


def names_step(text: str, step: Mapping[str, Any]) -> bool:
    """Whether a text names the step: one sentence carries at least half of the content words of its title, or of a
    sub-step or its done-check in a sentence that says when, or that it comes next (two words at least)."""
    title = str(step.get("title", ""))
    said = [(s, content_stems(s)) for s in sentences(plain(text))]
    for target in step_targets(step):
        stems = content_stems(target)
        need = min(2, len(stems))
        for sentence, found in said:
            if not stems or len(stems & found) < need or overlap(stems, found) < 0.5:
                continue
            if target == title or _STEP_CUE.search(sentence):
                return True
    return False


def due_date(step: Mapping[str, Any] | None) -> dt.date | None:
    raw = (step or {}).get("dueOn")
    try:
        return dt.date.fromisoformat(str(raw)[:10]) if raw else None
    except ValueError:
        return None
