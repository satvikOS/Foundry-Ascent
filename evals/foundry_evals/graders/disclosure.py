"""Persistent synthetic-identity disclosure (blueprint 01 F-09; system design §9).

Every session view must carry a disclosure that (1) says the coach is an AI, (2) says it is not a person,
and (3) says no human EIR authored or approved the responses. Persona releases may word it differently
(``disclosureText`` ≥ 40 characters), so the check is semantic rather than an exact string match.
"""

from __future__ import annotations

import re

from foundry_evals.graders.base import Finding, Severity
from foundry_evals.text import normalize

GRADER = "disclosure"
MENTIONS_AI = re.compile(r"\b(?:ai|a\.i\.|artificial intelligence)\b")
NOT_A_PERSON = re.compile(r"\b(?:not|isn't|is not|never) (?:a |an )?(?:real )?(?:person|human|human being)\b")
NO_EIR_AUTHORSHIP = re.compile(
    r"\bno (?:human )?(?:eir|entrepreneur[- ]in[- ]residence|mentor|person)\b[^.]*\b(?:author\w*|approv\w*|wr[io]t\w*|review\w*)"
)


def grade_disclosure(disclosure: str | None, *, location: str = "session.disclosure") -> list[Finding]:
    text = normalize(disclosure or "")
    if not text:
        return [Finding(GRADER, "missing", Severity.HIGH, "session has no AI disclosure", location)]
    missing = []
    if not MENTIONS_AI.search(text):
        missing.append("ai")
    if not NOT_A_PERSON.search(text):
        missing.append("not_a_person")
    if not NO_EIR_AUTHORSHIP.search(text):
        missing.append("no_eir_authorship")
    if missing:
        return [
            Finding(GRADER, "incomplete", Severity.HIGH, f"disclosure lacks: {', '.join(missing)}", location)
        ]
    return []
