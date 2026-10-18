"""Persistent synthetic-identity disclosure (blueprint 01 F-09; system design §9; ADR-0020).

Every session view must carry a disclosure on record that (1) says the coach is an AI, (2) says it is not a
person, and (3) says no human EIR authored or approved the responses. Persona releases may word it differently
(``disclosureText`` ≥ 40 characters), so the check is semantic rather than an exact string match.

Since the presence policy (ADR-0020) a founder reads that record only in print: what they get on screen is the
one-time welcome (stored with the person, ``Me.veirWelcomeAcknowledgedAt``) and the badge beside the coach's
name ("Corin · vEIR", or "AI" for the guide). ``grade_founder_disclosure`` checks that the server gives clients
both: it reports the welcome for this person, and it names the coach's kind (and a vEIR's EIR) for the badge.
"""

from __future__ import annotations

import re

from foundry_evals.graders.base import Finding, Severity
from foundry_evals.models import Me, PersonaSummary
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


def grade_founder_disclosure(persona: PersonaSummary | None, me: Me) -> list[Finding]:
    """What the founder sees: the server reports the one-time welcome for this person (read or not: null is
    an unread welcome the app shows), and names the venture coach's kind, with a vEIR's EIR, for its badge."""
    findings: list[Finding] = []
    if "veir_welcome_acknowledged_at" not in me.model_fields_set:
        findings.append(
            Finding(
                GRADER,
                "no_welcome",
                Severity.HIGH,
                "the server reports no vEIR welcome for this person",
                "me",
            )
        )
    if persona is None or persona.kind is None:
        findings.append(
            Finding(
                GRADER, "no_badge", Severity.HIGH, "the venture names no coach kind for its badge", "persona"
            )
        )
    elif persona.kind == "eir_persona" and not persona.eir_first_name:
        findings.append(
            Finding(GRADER, "no_badge", Severity.HIGH, "the vEIR has no EIR name for its badge", "persona")
        )
    return findings
