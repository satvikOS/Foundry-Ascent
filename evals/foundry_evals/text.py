"""Text helpers shared by the graders: normalisation and response field extraction."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

from foundry_evals.models import TurnView

ZERO_WIDTH = re.compile("[­᠎​-‏⁠-⁤﻿]")
NON_ALNUM = re.compile(r"[^0-9a-z]+")
WORD = re.compile(r"[0-9a-z]+(?:['’][0-9a-z]+)*")
SHINGLE_SIZE = 6


def normalize(text: str) -> str:
    """NFKC, zero-width characters removed, case-folded, whitespace collapsed."""
    value = ZERO_WIDTH.sub("", unicodedata.normalize("NFKC", text)).casefold()
    return re.sub(r"\s+", " ", value).strip()


def compact(text: str) -> str:
    """Normalised and stripped of everything but ASCII letters and digits (defeats spacing tricks)."""
    return NON_ALNUM.sub("", normalize(text))


def words(text: str) -> list[str]:
    return WORD.findall(normalize(text))


def shingle_hashes(text: str, size: int = SHINGLE_SIZE) -> set[str]:
    """Hashes of every run of ``size`` consecutive words. Only hashes are kept in memory or reports."""
    tokens = words(text)
    out: set[str] = set()
    for i in range(len(tokens) - size + 1):
        out.add(hashlib.sha256(" ".join(tokens[i : i + size]).encode("utf-8")).hexdigest()[:24])
    return out


@dataclass(frozen=True)
class TextField:
    """One human-readable string the founder can see, with where it came from."""

    location: str
    text: str
    #: Rehearsal lines role-play a counterpart: identity rules for the coach's own voice do not apply.
    roleplay: bool = False
    #: Evidence titles/excerpts are retrieved records shown alongside the answer.
    evidence: bool = False
    #: Rendered as Markdown (the answer); every other field is plain text, so images and links are inert.
    markdown: bool = False
    #: Memory candidates: facts the founder stated, proposed for the venture record (often quoting them).
    record: bool = False

    @property
    def coach_voice(self) -> bool:
        """The coach speaking for itself (not evidence, not a proposed record, not a role-played line)."""
        return not (self.evidence or self.record or self.roleplay)


def echoed(fragment: str, prompts: tuple[str, ...] | list[str]) -> bool:
    """Whether ``fragment`` (normalised) appears in any founder message: an echo, not a disclosure."""
    needle = normalize(fragment)
    return bool(needle) and any(needle in normalize(p) for p in prompts)


def turn_fields(turn: TurnView | None, *, support_message: str | None = None) -> list[TextField]:
    """Every string of a turn that is shown to the founder (founder_text excluded)."""
    out: list[TextField] = []
    if support_message:
        out.append(TextField("support_message", support_message))
    if turn is None:
        return out
    r = turn.response
    if r is not None:
        out.append(TextField("answer", r.answer, markdown=True))
        out.extend(TextField(f"claims[{i}]", c.text) for i, c in enumerate(r.claims))
        out.extend(TextField(f"uncertainty[{i}]", u.item) for i, u in enumerate(r.uncertainty))
        if r.challenge:
            out.append(TextField("challenge", r.challenge))
        for i, a in enumerate(r.next_actions):
            out.append(TextField(f"next_actions[{i}].owner", a.owner))
            out.append(TextField(f"next_actions[{i}].action", a.action))
        if r.escalation.reason:
            out.append(TextField("escalation.reason", r.escalation.reason))
        for i, m in enumerate(r.memory_candidates):
            out.append(TextField(f"memory_candidates[{i}].title", m.title, record=True))
            out.append(TextField(f"memory_candidates[{i}].content", m.content, record=True))
        out.extend(TextField(f"follow_up_questions[{i}]", q) for i, q in enumerate(r.follow_up_questions))
        if r.rehearsal is not None:
            out.append(TextField("rehearsal.counterpart", r.rehearsal.counterpart, roleplay=True))
            out.append(TextField("rehearsal.line", r.rehearsal.line, roleplay=True))
            out.append(TextField("rehearsal.critique", r.rehearsal.critique))
            for i, s in enumerate(r.rehearsal.scores):
                out.append(TextField(f"rehearsal.scores[{i}]", f"{s.criterion}: {s.note}"))
    for item in turn.evidence:
        out.append(TextField(f"evidence[{item.key}].title", item.title, evidence=True))
        out.append(TextField(f"evidence[{item.key}].excerpt", item.excerpt, evidence=True))
    return out


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p.strip() for p in parts if p.strip()]
