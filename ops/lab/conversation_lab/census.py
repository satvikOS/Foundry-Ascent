"""The phrase census: how often the vEIR's replies use the habits the lab tracks (counts only, public-safe).

Each pattern is a habit the production transcripts or the lab runs showed (docs/runbooks/conversation-lab.md,
SP findings LAB-M5, LAB-M7, LAB-R4): templated phrases, prompt examples said verbatim, report artefacts, stacked
questions, length. The counts are per reply (a reply counts once per pattern), so runs of different sizes compare as
shares.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence

#: name -> pattern; a reply counts once per pattern it matches.
PATTERNS: dict[str, re.Pattern[str]] = {
    "riskiest_assumption": re.compile(r"\briskiest assumption\b", re.IGNORECASE),
    "cheapest_test": re.compile(r"\bcheapest test\b", re.IGNORECASE),
    "cut_to_the_chase": re.compile(r"\bcut to the chase\b", re.IGNORECASE),
    "great_opening": re.compile(r"^\s*great(?: news)?\b", re.IGNORECASE),
    "so_neither": re.compile(r"\bso neither\b", re.IGNORECASE),
    "misread_that": re.compile(r"\bmisread that\b", re.IGNORECASE),
    "says_ai": re.compile(r"\b(?:i(?:'m|’m| am) (?:just |only )?an ai|as an ai)\b", re.IGNORECASE),
    "evidence_keys": re.compile(r"\[\[?\s*E\d+", re.IGNORECASE),
    "markdown_list_or_heading": re.compile(r"^\s*(?:[-*]\s|\d+\.\s|#{1,6}\s)", re.MULTILINE),
    "two_or_more_questions": re.compile(r"\?[^?]*\?"),
    "reasoning_leak": re.compile(
        r"\bthe founder (?:is|just|says|said|asked|wants)\b|\bI need to figure out\b|\baccording to the rules\b",
        re.IGNORECASE,
    ),
}


def _percentile(values: Sequence[int], q: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered), max(1, math.ceil(q * len(ordered)))) - 1]


def census(replies: Sequence[str], founder_names: Sequence[str] = ("Maya",)) -> dict[str, int | None]:
    texts = [r for r in replies if r and r.strip()]
    out: dict[str, int | None] = {"replies": len(texts)}
    for name, pattern in PATTERNS.items():
        out[name] = sum(1 for t in texts if pattern.search(t))
    names = [re.compile(rf"\b{re.escape(n)}\b") for n in founder_names if n]
    out["founder_name"] = sum(1 for t in texts if any(p.search(t) for p in names))
    words = [len(t.split()) for t in texts]
    out["words_p50"] = _percentile(words, 0.5)
    out["words_p90"] = _percentile(words, 0.9)
    return out
