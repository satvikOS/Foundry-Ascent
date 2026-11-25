"""Business words and whether a reply gives them a meaning."""

from __future__ import annotations

import re

from conversation_lab.client.turns import ReplyTurn

#: Business words a first-time founder is given a meaning for, the first time they are used.
GLOSSARY: dict[str, re.Pattern[str]] = {
    name: re.compile(pattern, re.IGNORECASE)
    for name, pattern in {
        "unit economics": r"\bunit economics\b",
        "value proposition": r"\bvalue prop(?:osition)?s?\b",
        "mvp": r"\bMVPs?\b|\bminimum viable product\b",
        "tam": r"\b(?:TAM|SAM|SOM)\b|\btotal addressable market\b",
        "cac": r"\bCAC\b|\bcustomer acquisition cost\b",
        "ltv": r"\bLTV\b|\blifetime value\b",
        "churn": r"\bchurn\b",
        "runway": r"\brunway\b",
        "burn rate": r"\bburn rate\b",
        "go-to-market": r"\bgo-to-market\b|\bGTM\b",
        "product-market fit": r"\bproduct[- ]market fit\b|\bPMF\b",
        "cap table": r"\bcap table\b",
        "dilution": r"\bdilut(?:ion|ed|es)\b",
        "vesting": r"\bvest(?:ing|s)\b",
        "term sheet": r"\bterm sheets?\b",
        "seed round": r"\b(?:pre-)?seed (?:round|funding|stage)\b",
        "convertible note": r"\bconvertible notes?\b|\bSAFE\b(?! )",
        "beachhead": r"\bbeachhead\b",
        "early adopter": r"\bearly adopters?\b",
        "icp": r"\bICP\b|\bideal customer profile\b",
        "gross margin": r"\b(?:gross|contribution) margins?\b",
        "break-even": r"\bbreak[- ]?even\b",
        "loi": r"\bLOIs?\b|\bletters? of intent\b",
        "provisional": r"\bprovisional (?:patent|application)\b",
        "kpi": r"\bKPIs?\b",
        "recurring revenue": r"\b(?:ARR|MRR)\b",
        "b2b": r"\bB2[BC]\b",
        "concierge test": r"\bconcierge (?:test|mvp)\b",
        "smoke test": r"\bsmoke test\b",
    }.items()
}
_DEFINED_AFTER = re.compile(
    r"^[\"”')*_]*\s*(?:\(|[-–—:=]|,? ?(?:which|that|this) (?:is|means|just)|,? ?meaning\b|,? ?i\.e\.|,? ?that is|"
    r"means?\b|is (?:when|what|how|the|just|simply|an?\b|one\b|your)|are (?:the|people|what)|,? (?:or|in other words|basically)\b|"
    r",? (?:what|how much|how many|the (?:people|money|share|cost|price|first|smallest|part|amount)|a (?:small|rough|short|"
    r"first|promise|signed)))",
    re.IGNORECASE,
)
_DEFINED_BEFORE = re.compile(
    r"(?:called|known as|founders call|people call|this is (?:the|your|a)|that(?:'s| is) (?:the|your|a)|"
    r"name for (?:it|this|that) is|\(|[\u2014\u2013]|,? or)\s*(?:an?|the|your)?\s*[\"“'*_]*$",
    re.IGNORECASE,
)


def defined(text: str, pattern: re.Pattern[str]) -> bool:
    """The term is given a meaning somewhere in the text: before it, after it, or in a sentence of its own."""
    return any(
        _DEFINED_AFTER.match(text[m.end() :]) or _DEFINED_BEFORE.search(text[: m.start()])
        for m in pattern.finditer(text)
    )


def undefined_terms(t: ReplyTurn) -> list[str]:
    """The business words the reply uses first and gives no meaning."""
    before = "\n".join(x for pair in t.earlier for x in pair) + "\n" + t.founder
    return [
        name
        for name, pattern in GLOSSARY.items()
        if pattern.search(t.text) and not pattern.search(before) and not defined(t.text, pattern)
    ]
