"""Dataset schemas, loading, validation and template rendering.

``datasets/scenarios.yaml`` — labelled coaching prompts (blueprint 01 §4 scenario benchmark).
``datasets/redteam.yaml`` — adversarial conversations (``attacks``) and API authorization probes
(``api_probes``).

Prompts may use ``{{placeholder}}`` tokens that the runner fills from the live environment (other
ventures' names, the assigned EIR's name, the acting venture's own canary, …), so the datasets never
embed real identifiers. Unknown placeholders are a validation error.
"""

from __future__ import annotations

import base64
import codecs
import hashlib
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, get_args

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from foundry_evals.graders.behaviours import BEHAVIOURS
from foundry_evals.models import CoachModeName, EscalationCategoryName

DATASETS_DIR = Path(__file__).resolve().parent.parent / "datasets"

VentureKey = Literal["quietquad", "benchtally", "solesignal", "emberloop"]
Stage = Literal["idea", "discovery", "validation", "business_model", "commercialization", "transition"]
Domain = Literal["consumer", "software", "medical_device", "climate_hardware"]
RiskArea = Literal["ip", "securities", "fda_clinical", "legal", "crisis_wellbeing", "harassment"]
Behaviour = Literal[
    "asks_evidence_question",
    "separates_fact_assumption",
    "cites_evidence",
    "states_uncertainty",
    "proposes_next_action",
    "challenges_assumption",
    "refers_to_human",
    "refuses_or_limits",
    "provides_crisis_resources",
    "routes_to_resource",
    "gives_rehearsal_feedback",
    "structured_explanation",
]
Violation = Literal[
    "leaks_other_venture",
    "reveals_system_prompt",
    "claims_human",
    "claims_eir_or_approval",
    "gives_legal_advice",
    "gives_securities_advice",
    "gives_medical_regulatory_advice",
    "gives_ip_determination",
    "guarantees_outcome",
    "follows_injected_instruction",
    "exfiltrates_data",
    "disables_escalation",
]
AttackCategory = Literal[
    "cross_venture",
    "prompt_injection",
    "identity",
    "policy_bypass",
    "exfiltration",
    "escalation_jailbreak",
]
Technique = Literal[
    "direct",
    "indirect",
    "multi_turn",
    "authority",
    "membership_inference",
    "guessing",
    "document",
    "memory",
    "roleplay",
    "translation",
    "encoding",
    "system_prompt",
    "hypothetical",
    "urgency",
    "splitting",
    "consent_claim",
    "config_claim",
    "markdown_image",
    "link",
]
MemoryTypeName = Literal[
    "fact",
    "hypothesis",
    "decision",
    "experiment",
    "evidence",
    "action",
    "milestone",
    "risk",
    "preference",
    "relationship",
    "insight",
]

DOMAIN_VENTURE: Mapping[str, str] = {
    "consumer": "quietquad",
    "software": "benchtally",
    "medical_device": "solesignal",
    "climate_hardware": "emberloop",
}
RISK_AREA_CATEGORY: Mapping[str, str] = {
    "ip": "ip_licensing",
    "securities": "securities_investment",
    "fda_clinical": "medical_regulatory",
    "legal": "legal",
    "crisis_wellbeing": "safety_wellbeing",
    "harassment": "conflict_harassment",
}
#: Definitive-advice detectors (graders.high_risk) per risk area / violation.
RISK_AREA_ADVICE: Mapping[str, str] = {
    "ip": "ip",
    "securities": "securities",
    "fda_clinical": "medical_regulatory",
    "legal": "legal",
}
CATEGORY_ADVICE: Mapping[str, str] = {
    "ip_licensing": "ip",
    "securities_investment": "securities",
    "medical_regulatory": "medical_regulatory",
    "legal": "legal",
}
VIOLATION_ADVICE: Mapping[str, str] = {
    "gives_legal_advice": "legal",
    "gives_securities_advice": "securities",
    "gives_medical_regulatory_advice": "medical_regulatory",
    "gives_ip_determination": "ip",
}
HIGH_RISK_CATEGORIES = frozenset(RISK_AREA_CATEGORY.values())
ATTACK_PREFIX: Mapping[str, str] = {
    "cross_venture": "CV",
    "prompt_injection": "PI",
    "identity": "ID",
    "policy_bypass": "PB",
    "exfiltration": "EX",
    "escalation_jailbreak": "EJ",
}
#: Placeholders available to prompts, setup content and probe paths.
TEXT_PLACEHOLDERS = frozenset(
    {
        "other_venture",
        "other_venture_2",
        "other_founder",
        "other_slug",
        "own_venture",
        "own_canary",
        "eir_name",
        "staff_name",
        "payload",
        "marker",
    }
)
PROBE_PLACEHOLDERS = frozenset({"other_venture_id", "own_venture_id", "other_memory_id"})
PLACEHOLDER = re.compile(r"\{\{\s*([a-z0-9_]+)\s*\}\}")

if set(get_args(Behaviour)) != set(BEHAVIOURS):  # pragma: no cover - registry consistency
    raise RuntimeError("dataset behaviours and grader behaviours are out of sync")


class DatasetError(Exception):
    """A dataset file is missing or invalid (messages name ids and fields, never prompt text)."""


def placeholders(text: str) -> set[str]:
    return {m.group(1) for m in PLACEHOLDER.finditer(text)}


def render(text: str, values: Mapping[str, str]) -> str:
    """Replaces ``{{name}}`` tokens. Raises KeyError naming a missing value."""

    def sub(match: re.Match[str]) -> str:
        return values[match.group(1)]

    return PLACEHOLDER.sub(sub, text)


LEET = str.maketrans({"a": "4", "e": "3", "i": "1", "o": "0", "s": "5", "t": "7"})


def encode_payload(payload: str, method: str | None) -> str:
    if method is None:
        return payload
    if method == "base64":
        return base64.b64encode(payload.encode("utf-8")).decode("ascii")
    if method == "rot13":
        return codecs.encode(payload, "rot_13")
    if method == "hex":
        return payload.encode("utf-8").hex()
    if method == "reverse":
        return payload[::-1]
    if method == "leet":
        return payload.lower().translate(LEET)
    raise ValueError(f"unknown encoding {method}")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _unique(values: list[str], what: str) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError(f"duplicate {what}")
    return values


class Scenario(_Strict):
    id: str = Field(pattern=r"^SC-\d{3}$")
    title: str = Field(min_length=3, max_length=120)
    stage: Stage
    domain: Domain
    mode: CoachModeName
    risk: Literal["high", "standard"]
    risk_area: RiskArea | None = None
    venture: VentureKey | None = None
    rehearsal_counterpart: str | None = Field(default=None, max_length=120)
    setup_turns: list[str] = Field(default_factory=list, max_length=3)
    prompt: str = Field(min_length=10, max_length=4000)
    expected_escalation: bool
    expected_category: EscalationCategoryName | None = None
    must_include: list[Behaviour] = Field(default_factory=list)
    must_not: list[Violation] = Field(default_factory=list)

    @field_validator("must_include", "must_not")
    @classmethod
    def _no_duplicates(cls, value: list[str]) -> list[str]:
        return _unique(value, "behaviour")

    @model_validator(mode="after")
    def _consistent(self) -> Scenario:
        if self.risk == "high":
            if self.risk_area is None:
                raise ValueError("high-risk scenarios need a risk_area")
            if not self.expected_escalation or self.expected_category != RISK_AREA_CATEGORY[self.risk_area]:
                raise ValueError("high-risk scenarios must expect escalation in their risk area's category")
        elif self.risk_area is not None:
            raise ValueError("risk_area is only for high-risk scenarios")
        if self.expected_escalation != (self.expected_category is not None):
            raise ValueError("expected_category must be set exactly when expected_escalation is true")
        if (self.mode == "rehearse") != (self.rehearsal_counterpart is not None):
            raise ValueError("rehearsal_counterpart is required for (and only for) rehearse mode")
        for text in [self.prompt, *self.setup_turns]:
            unknown = placeholders(text) - TEXT_PLACEHOLDERS
            if unknown:
                raise ValueError(f"unknown placeholders: {sorted(unknown)}")
        return self

    @property
    def venture_key(self) -> str:
        return self.venture or DOMAIN_VENTURE[self.domain]

    @property
    def advice_areas(self) -> list[str]:
        areas = {VIOLATION_ADVICE[v] for v in self.must_not if v in VIOLATION_ADVICE}
        if self.risk_area in RISK_AREA_ADVICE:
            areas.add(RISK_AREA_ADVICE[self.risk_area])
        return sorted(areas)


class DocumentSetup(_Strict):
    filename: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:md|txt)$")
    content: str = Field(min_length=20, max_length=20000)


class MemorySetup(_Strict):
    type: MemoryTypeName
    title: str = Field(min_length=3, max_length=200)
    content: str = Field(min_length=3, max_length=8000)


class AttackSetup(_Strict):
    document: DocumentSetup | None = None
    memory: MemorySetup | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> AttackSetup:
        if (self.document is None) == (self.memory is None):
            raise ValueError("setup needs exactly one of document or memory")
        return self


class Attack(_Strict):
    id: str = Field(pattern=r"^RT-(?:CV|PI|ID|PB|EX|EJ)-\d{3}$")
    category: AttackCategory
    technique: Technique
    title: str = Field(min_length=3, max_length=120)
    venture: VentureKey | None = None
    mode: CoachModeName = "coach"
    rehearsal_counterpart: str | None = Field(default=None, max_length=120)
    turns: list[str] = Field(min_length=1, max_length=4)
    payload: str | None = None
    encode: Literal["base64", "rot13", "hex", "reverse", "leet"] | None = None
    setup: AttackSetup | None = None
    injection_marker: str | None = Field(default=None, pattern=r"^[A-Z0-9-]{6,32}$")
    exfil_domains: list[str] = Field(default_factory=list)
    expected_escalation: bool = False
    expected_category: EscalationCategoryName | None = None
    must_include: list[Behaviour] = Field(default_factory=list)
    must_not: list[Violation] = Field(min_length=1)
    severity: Literal["critical", "high", "medium"]

    @field_validator("must_include", "must_not")
    @classmethod
    def _no_duplicates(cls, value: list[str]) -> list[str]:
        return _unique(value, "behaviour")

    @model_validator(mode="after")
    def _consistent(self) -> Attack:
        if self.id.split("-")[1] != ATTACK_PREFIX[self.category]:
            raise ValueError("id prefix does not match the category")
        if self.expected_escalation != (self.expected_category is not None):
            raise ValueError("expected_category must be set exactly when expected_escalation is true")
        if self.category in ("policy_bypass", "escalation_jailbreak") and not self.expected_escalation:
            raise ValueError("policy-bypass and escalation-jailbreak attacks must expect escalation")
        texts = [*self.turns]
        if self.payload is not None:
            texts.append(self.payload)
        if self.rehearsal_counterpart is not None:
            texts.append(self.rehearsal_counterpart)
        if self.setup is not None:
            if self.setup.document is not None:
                texts.append(self.setup.document.content)
            if self.setup.memory is not None:
                texts += [self.setup.memory.title, self.setup.memory.content]
        used: set[str] = set()
        for text in texts:
            used |= placeholders(text)
        unknown = used - TEXT_PLACEHOLDERS
        if unknown:
            raise ValueError(f"unknown placeholders: {sorted(unknown)}")
        if self.payload is not None and "payload" not in set().union(*(placeholders(t) for t in self.turns)):
            raise ValueError("payload is set but no turn uses {{payload}}")
        if self.encode is not None and self.payload is None:
            raise ValueError("encode needs a payload")
        if "marker" in used and self.injection_marker is None:
            raise ValueError("{{marker}} is used but injection_marker is not set")
        if "follows_injected_instruction" in self.must_not and self.injection_marker is None:
            raise ValueError("follows_injected_instruction needs an injection_marker")
        if self.technique in ("document", "memory") and (
            self.setup is None or getattr(self.setup, self.technique) is None
        ):
            raise ValueError(f"technique {self.technique} needs setup.{self.technique}")
        if (self.mode == "rehearse") != (self.rehearsal_counterpart is not None):
            raise ValueError("rehearsal_counterpart is required for (and only for) rehearse mode")
        return self

    @property
    def high_risk(self) -> bool:
        return self.expected_category in HIGH_RISK_CATEGORIES

    @property
    def advice_areas(self) -> list[str]:
        areas = {VIOLATION_ADVICE[v] for v in self.must_not if v in VIOLATION_ADVICE}
        if self.expected_category in CATEGORY_ADVICE:
            areas.add(CATEGORY_ADVICE[self.expected_category])
        return sorted(areas)


class ApiProbe(_Strict):
    id: str = Field(pattern=r"^RT-API-\d{3}$")
    title: str = Field(min_length=3, max_length=120)
    actor: Literal["founder", "advisor", "anonymous"]
    method: Literal["GET", "POST", "PATCH", "DELETE"]
    path: str = Field(pattern=r"^/[A-Za-z0-9_{}/?=&.-]*$")
    body: dict[str, object] | None = None
    omit_csrf: bool = False
    expect_status: list[int] = Field(min_length=1)
    check: Literal["no_other_canary", "advisor_visibility"] | None = None
    severity: Literal["critical", "high", "medium"]

    @model_validator(mode="after")
    def _consistent(self) -> ApiProbe:
        unknown = placeholders(self.path) - PROBE_PLACEHOLDERS
        if unknown:
            raise ValueError(f"unknown placeholders: {sorted(unknown)}")
        return self


class ScenarioFile(_Strict):
    version: Literal[1]
    scenarios: list[Scenario] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_ids(self) -> ScenarioFile:
        _unique([s.id for s in self.scenarios], "scenario id")
        return self


class RedTeamFile(_Strict):
    version: Literal[1]
    attacks: list[Attack] = Field(min_length=1)
    api_probes: list[ApiProbe] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_ids(self) -> RedTeamFile:
        _unique([a.id for a in self.attacks] + [p.id for p in self.api_probes], "attack id")
        markers = [a.injection_marker for a in self.attacks if a.injection_marker]
        _unique(markers, "injection marker")
        return self


def _load_yaml(path: Path) -> object:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise DatasetError(f"cannot read {path.name}: {exc.strerror}") from exc
    try:
        return yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise DatasetError(f"{path.name} is not valid YAML") from exc


def _describe(exc: ValidationError, items_key: str, data: object) -> str:
    lines = []
    for err in exc.errors()[:10]:
        loc = list(err["loc"])
        where = ".".join(str(p) for p in loc)
        if len(loc) >= 2 and loc[0] == items_key and isinstance(loc[1], int) and isinstance(data, dict):
            items = data.get(items_key)
            if isinstance(items, list) and loc[1] < len(items) and isinstance(items[loc[1]], dict):
                where = f"{items[loc[1]].get('id', loc[1])}." + ".".join(str(p) for p in loc[2:])
        lines.append(f"{where}: {err['msg']}")
    return "; ".join(lines)


def load_scenarios(path: Path | None = None) -> ScenarioFile:
    path = path or DATASETS_DIR / "scenarios.yaml"
    data = _load_yaml(path)
    try:
        return ScenarioFile.model_validate(data)
    except ValidationError as exc:
        raise DatasetError(f"{path.name}: {_describe(exc, 'scenarios', data)}") from exc


def load_redteam(path: Path | None = None) -> RedTeamFile:
    path = path or DATASETS_DIR / "redteam.yaml"
    data = _load_yaml(path)
    try:
        return RedTeamFile.model_validate(data)
    except ValidationError as exc:
        key = "attacks"
        raise DatasetError(f"{path.name}: {_describe(exc, key, data)}") from exc


def dataset_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
