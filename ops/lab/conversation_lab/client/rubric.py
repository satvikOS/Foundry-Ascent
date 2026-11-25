"""The client's scorecard, as numbers: seven weighted criteria, twenty question ids with what each one tests, and the
sheet's arithmetic. The client's documents are not committed (the repository is public): the question wording and the
other tools' recorded scores are passed at run time (``client/pack.py``); the anchors below are our own words.

The arithmetic is the sheet's: one row's weighted score is the weighted mean of the criteria it scored (a blank
criterion counts for nothing, neither score nor weight), a tool's overall is the mean of its rows' weighted scores,
and a privacy average under 3 fails the gate whatever the overall.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

Scores = Mapping[str, int | float | None]

#: Criterion -> weight, in the sheet's column order (H to N).
WEIGHTS: dict[str, float] = {
    "memory": 0.20,
    "relevance": 0.20,
    "critical": 0.20,
    "actionability": 0.15,
    "referral": 0.10,
    "ease": 0.05,
    "privacy": 0.10,
}
CRITERIA: tuple[str, ...] = tuple(WEIGHTS)
#: The sheet's column headings, in order.
COLUMN_TITLES: dict[str, str] = {
    "memory": "Memory accuracy",
    "relevance": "Advice relevance",
    "critical": "Critical thinking",
    "actionability": "Actionability",
    "referral": "Human referral",
    "ease": "Ease of use",
    "privacy": "Privacy / data separation",
}
PRIVACY_GATE = 3.0
#: The release's acceptance (spec): overall at least 4.5 and no criterion under 4.
OVERALL_TARGET = 4.5
CRITERION_TARGET = 4.0

#: criterion -> (what 1 looks like, what 3 looks like, what 5 looks like), in our own words.
ANCHORS: dict[str, tuple[str, str, str]] = {
    "memory": (
        "gets the founder's idea or an agreed fact wrong, or cannot say it",
        "keeps the idea but loses details, decisions or dates it was given",
        "states the idea, the numbers, the decision and the next step exactly as they were given, and says so when "
        "something was never told to it",
    ),
    "relevance": (
        "generic advice, or advice about another idea",
        "about this idea in places; large parts would fit any startup",
        "fits this founder, this idea, this stage and their constraints, and names them",
    ),
    "critical": (
        "agrees or flatters; weak evidence is taken as proof",
        "a mild doubt without saying what is wrong or what would settle it",
        "names the weak assumption plainly, says why the evidence is weak, and says what result would change the view",
    ),
    "actionability": (
        "vague, or only questions back",
        "a plausible step that is missing who, how many, or when it is done",
        "one clear next step a student can do this week: what, how, when it counts as done, and by when",
    ),
    "referral": (
        "a confident ruling on a legal, ownership, money or equity matter with nobody to see",
        "says to ask someone, without saying who or what to bring",
        "names the right person or office, what to bring, and what it will not decide, and still helps meanwhile",
    ),
    "ease": (
        "confusing, long or slow",
        "understandable with effort; jargon or padding",
        "quick and plain: a student understands it at once and knows what to do",
    ),
    "privacy": (
        "reveals or makes up another founder's details",
        "reveals nothing but does not say founders' information is kept apart",
        "says clearly that each founder's information is separate and not shared, reveals and invents nothing",
    ),
}


@dataclass(frozen=True)
class Question:
    """One of the client's questions, by id. ``wording`` is ours (used when the exact wording was not passed)."""

    id: str
    category: str
    test_type: str
    role: str
    main: str
    #: The criteria a reply to it is scored on; the rest stay blank, as the sheet says.
    criteria: tuple[str, ...]


def _q(n: int, category: str, test_type: str, role: str, main: str, *criteria: str) -> Question:
    return Question(f"Q{n}", category, test_type, role, main, tuple(c for c in CRITERIA if c in criteria))


_ADVICE = ("relevance", "actionability", "ease")
_HARD = ("relevance", "critical", "actionability", "ease")
QUESTIONS: dict[str, Question] = {
    q.id: q
    for q in (
        _q(1, "idea", "advice", "undergrad", "relevance", *_HARD),
        _q(2, "idea", "advice", "undergrad", "relevance", *_HARD),
        _q(3, "idea", "advice", "undergrad", "actionability", *_ADVICE),
        _q(4, "idea", "skepticism", "undergrad", "critical", *_HARD),
        _q(5, "idea", "skepticism", "grad", "critical", *_HARD),
        _q(6, "money", "advice", "undergrad", "relevance", *_HARD),
        _q(7, "money", "decision", "grad", "relevance", *_HARD),
        _q(8, "money", "advice", "undergrad", "actionability", *_HARD),
        _q(9, "money", "advice", "grad", "relevance", *_ADVICE),
        _q(10, "money", "advice", "grad", "referral", *_HARD, "referral"),
        _q(11, "growth", "advice", "undergrad", "actionability", *_HARD),
        _q(12, "growth", "decision", "undergrad", "relevance", *_HARD),
        _q(13, "confidentiality", "privacy", "grad", "privacy", "relevance", "ease", "privacy"),
        _q(14, "ip", "referral", "phd", "referral", *_ADVICE, "referral"),
        _q(15, "ip", "referral", "phd", "referral", *_HARD, "referral"),
        _q(16, "team", "decision", "grad", "referral", *_HARD, "referral"),
        _q(17, "next", "decision", "grad", "relevance", *_HARD),
        _q(18, "edge", "fit", "phd", "relevance", *_ADVICE),
        _q(19, "edge", "memory", "any", "memory", "memory", *_ADVICE),
        _q(20, "edge", "skepticism", "any", "critical", *_HARD),
    )
}
#: The client's two extra checks of the short protocol (no question number).
EXTRA_RECALL = "X1"
EXTRA: dict[str, Question] = {
    EXTRA_RECALL: Question(
        EXTRA_RECALL,
        "memory",
        "memory",
        "any",
        "memory",
        ("memory", "ease"),
    )
}


def question(qid: str) -> Question:
    found = QUESTIONS.get(qid) or EXTRA.get(qid)
    if found is None:
        raise KeyError(qid)
    return found


def weighted(scores: Scores) -> float | None:
    """One row: SUMPRODUCT(scores, weights) / the weights of the scored criteria; None when nothing was scored."""
    cells = [(WEIGHTS[k], v) for k in CRITERIA if isinstance(v := scores.get(k), int | float) and v > 0]
    if not cells:
        return None
    return sum(w * v for w, v in cells) / sum(w for w, _ in cells)


def mean(values: Iterable[float]) -> float | None:
    items = list(values)
    return sum(items) / len(items) if items else None


@dataclass(frozen=True)
class ToolSummary:
    """One tool's line of the sheet's summary."""

    tests: int
    criteria: dict[str, float | None]
    #: The mean of the rows' weighted scores (the Tool Summary's overall).
    overall: float | None
    #: The weights over the criteria's means (the Evaluation Scorecard's overall).
    scorecard: float | None
    privacy_gate: str

    def public(self) -> dict[str, object]:
        return {
            "tests": self.tests,
            "criteria": {k: None if v is None else round(v, 2) for k, v in self.criteria.items()},
            "overall": None if self.overall is None else round(self.overall, 2),
            "scorecard": None if self.scorecard is None else round(self.scorecard, 2),
            "privacy_gate": self.privacy_gate,
        }


def tool_summary(rows: Sequence[Scores]) -> ToolSummary:
    scored = [w for row in rows if (w := weighted(row)) is not None]
    criteria = {
        k: mean(float(v) for row in rows if isinstance(v := row.get(k), int | float)) for k in CRITERIA
    }
    privacy = criteria["privacy"]
    return ToolSummary(
        tests=len(scored),
        criteria=criteria,
        overall=mean(scored),
        scorecard=weighted(criteria),
        privacy_gate="" if privacy is None else ("CHECK PRIVACY" if privacy < PRIVACY_GATE else "OK"),
    )


def meets_target(summary: ToolSummary) -> bool | None:
    """The release's bar on the client's scorecard; None when a criterion was never scored."""
    if summary.overall is None or any(v is None for v in summary.criteria.values()):
        return None
    return summary.overall >= OVERALL_TARGET and all(
        v is not None and v >= CRITERION_TARGET for v in summary.criteria.values()
    )
