"""How the judge agrees with a strict professor: synthetic replies graded by hand (``scenarios/client-calibration.yaml``),
scored by the run's own judge before the coach's replies are, and compared. A judge that is lenient on them makes the
run's client score no evidence, and the gate says so.

What counts: scores within one point of the hand-given ones, the mean difference (above zero is lenient), bad replies
(2 or less by hand) it lets through as decent, good ones (4 or more) it fails, and its first check (did the reply answer).
"""

from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from conversation_lab.client.judge import ANSWERED, Scorecard, reply_prompt
from conversation_lab.client.rubric import CRITERIA
from conversation_lab.config import SCENARIOS_DIR

CALIBRATION_FILE = SCENARIOS_DIR / "client-calibration.yaml"
#: The judge is calibrated when it clears all of these.
WITHIN_ONE = 0.85
MOST_BIAS = 0.4
LEAST_BIAS = -0.75
#: Of the scores a professor put at 2 or less, how many the judge also puts at 2 or less; of those at 4 or more, at 4 or more.
BAD_CAUGHT = 0.8
GOOD_KEPT = 0.7
BAD, GOOD = 2, 4


class CalibrationError(ValueError):
    """A calibration set that does not match its schema (ids only)."""


@dataclass(frozen=True)
class Case:
    id: str
    prompt: str
    criteria: tuple[str, ...]
    strict: dict[str, int]
    answered: str


def load(path: Path = CALIBRATION_FILE) -> tuple[Case, ...]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    founders = doc.get("founders") or {}
    out: list[Case] = []
    for raw in doc.get("cases") or []:
        cid = str(raw.get("id"))
        unknown = set(raw) - {
            "id",
            "founder",
            "asks",
            "reply",
            "card",
            "earlier",
            "tests",
            "strict",
            "answered",
        }
        founder = founders.get(raw.get("founder"))
        strict = raw.get("strict")
        if unknown or founder is None or not isinstance(strict, dict) or raw.get("answered") not in ANSWERED:
            raise CalibrationError(f"{cid}: malformed")
        if not strict or any(k not in CRITERIA or v not in (1, 2, 3, 4, 5) for k, v in strict.items()):
            raise CalibrationError(f"{cid}: scores")
        criteria = tuple(c for c in CRITERIA if c in strict)
        out.append(
            Case(
                id=cid,
                prompt=reply_prompt(
                    role=founder["role"],
                    founder=founder["about"],
                    known=founder["known"].strip(),
                    earlier=tuple((str(f), str(c)) for f, c in raw.get("earlier") or []),
                    founder_text=str(raw["asks"]),
                    reply=str(raw["reply"]).strip(),
                    card=str(raw.get("card", "")),
                    channel="chat",
                    seconds=1.5,
                    tests=str(raw["tests"]),
                    passing="",
                    first_time=bool(founder.get("first_time", False)),
                ),
                criteria=criteria,
                strict={c: int(strict[c]) for c in criteria},
                answered=str(raw["answered"]),
            )
        )
    ids = [c.id for c in out]
    if len(ids) != len(set(ids)) or not out:
        raise CalibrationError("duplicate or no cases")
    return tuple(out)


def _share(part: int, whole: int) -> float | None:
    return round(part / whole, 3) if whole else None


def agreement(cases: Sequence[Case], cards: Sequence[Scorecard]) -> dict[str, Any]:
    """The judge beside the hand-given scores: numbers and case ids only."""
    pairs: list[tuple[str, str, int, int]] = []
    errors: dict[str, int] = {}
    answered = same = 0
    for case, card in zip(cases, cards, strict=True):
        if card.error is not None:
            errors[card.error] = errors.get(card.error, 0) + 1
            continue
        for criterion in case.criteria:
            given = card.scores.get(criterion)
            if given is not None:
                pairs.append((case.id, criterion, case.strict[criterion], given))
        answered += 1
        same += int(card.checks.get("answered") == case.answered)
    n = len(pairs)
    bad = [p for p in pairs if p[2] <= BAD]
    good = [p for p in pairs if p[2] >= GOOD]
    bias = round(sum(j - s for _, _, s, j in pairs) / n, 3) if n else None
    out: dict[str, Any] = {
        "cases": len(cases),
        "scored": answered,
        "errors": dict(sorted(errors.items())),
        "pairs": n,
        "exact": _share(sum(1 for _, _, s, j in pairs if s == j), n),
        "within_one": _share(sum(1 for _, _, s, j in pairs if abs(s - j) <= 1), n),
        "bias": bias,
        "lenient_by_two": sum(1 for _, _, s, j in pairs if j - s >= 2),
        "harsh_by_two": sum(1 for _, _, s, j in pairs if s - j >= 2),
        "bad_caught": _share(sum(1 for p in bad if p[3] <= BAD), len(bad)),
        "good_kept": _share(sum(1 for p in good if p[3] >= GOOD), len(good)),
        "answered_same": _share(same, answered),
        "by_criterion": {
            c: {
                "pairs": len(mine),
                "bias": round(sum(j - s for _, _, s, j in mine) / len(mine), 2),
                "within_one": _share(sum(1 for _, _, s, j in mine if abs(s - j) <= 1), len(mine)),
            }
            for c in CRITERIA
            if (mine := [p for p in pairs if p[1] == c])
        },
        "off": sorted({cid for cid, _, s, j in pairs if abs(s - j) >= 2}),
    }
    out["calibrated"] = calibrated(out)
    return out


def calibrated(found: dict[str, Any]) -> bool | None:
    """Whether the judge may score the run; None when it scored fewer than nine in ten cases."""
    if found["pairs"] == 0 or found["scored"] < 0.9 * found["cases"]:
        return None
    return bool(
        found["within_one"] >= WITHIN_ONE
        and LEAST_BIAS <= found["bias"] <= MOST_BIAS
        and found["bad_caught"] >= BAD_CAUGHT
        and found["good_kept"] >= GOOD_KEPT
    )


def calibrate(
    judge: Any, cases: Sequence[Case] | None = None, *, concurrency: int = 4
) -> tuple[dict[str, Any], list[Scorecard]]:
    chosen = tuple(cases or load())
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        cards = list(pool.map(lambda c: judge.score(c.prompt, c.criteria), chosen))
    return agreement(chosen, cards), cards


def private_rows(cases: Sequence[Case], cards: Sequence[Scorecard]) -> list[dict[str, Any]]:
    """Case by case, with the judge's words (synthetic, but kept with the private outputs)."""
    return [
        {
            "id": case.id,
            "strict": case.strict,
            "judge": {c: card.scores.get(c) for c in case.criteria},
            "raw": {c: card.raw.get(c) for c in case.criteria},
            "answered": [case.answered, card.checks.get("answered")],
            "checks": card.checks,
            "reasons": card.reasons,
            "capped": card.capped,
            "error": card.error,
        }
        for case, card in zip(cases, cards, strict=True)
    ]
