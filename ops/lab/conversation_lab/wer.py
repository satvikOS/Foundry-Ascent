"""Word error rate of a transcript against the line the founder's voice actually said."""

from __future__ import annotations

import re
import unicodedata

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "`": "'"})
_NON_WORD = re.compile(r"[^a-z0-9' ]+")


def words(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKC", text).translate(_APOSTROPHES).lower()
    folded = folded.replace("-", " ")
    return [w.strip("'") for w in _NON_WORD.sub(" ", folded).split() if w.strip("'")]


def edit_distance(ref: list[str], hyp: list[str]) -> int:
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        current = [i]
        for j, h in enumerate(hyp, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h)))
        previous = current
    return previous[-1]


def wer(reference: str, hypothesis: str) -> float:
    """(substitutions + deletions + insertions) / reference words; 1.0 for an empty transcript."""
    ref = words(reference)
    if not ref:
        raise ValueError("empty reference")
    return round(edit_distance(ref, words(hypothesis)) / len(ref), 4)
