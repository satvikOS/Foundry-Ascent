"""Loading and validating the conversation-matrix taxonomy and the template bank.

``taxonomy.yaml``: dimensions → values (label, description, the rule checks and judge criteria each value
implies, and where it may appear), the checks every reply gets, the rule-check catalogue (family, severity) and the
humanness weights. ``templates.yaml``: the personas and topics scenarios draw from and the template simulator's
phrase banks. Both are validated strictly: an unknown check, criterion, dimension, value, slot or term is an error.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from foundry_evals.datasets import DATASETS_DIR, DatasetError
from foundry_evals.matrix.judge import JUDGE_CRITERIA
from foundry_evals.text import mentions_any

MATRIX_DIR = DATASETS_DIR / "matrix"
TAXONOMY_PATH = MATRIX_DIR / "taxonomy.yaml"
TEMPLATES_PATH = MATRIX_DIR / "templates.yaml"

#: The dimensions every taxonomy must have, in the order scenarios list them (the generator, the turn plan and the
#: graders read these by name).
DIMENSIONS: tuple[str, ...] = (
    "question_type",
    "answer_style",
    "emotion",
    "trajectory",
    "topic_dynamic",
    "relational_move",
    "continuity",
    "channel",
    "register",
)
Family = Literal[
    "presence", "attunement", "request", "continuity", "topic", "craft", "relational", "voice", "safety"
]
SLOT = re.compile(r"<([a-z_]+)>")
PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")
#: Slots the template simulator fills (simulator.SLOT_NAMES must cover these).
TEMPLATE_SLOTS = frozenset(
    {
        "feeling",
        "detail",
        "detail_lower",
        "detail_b",
        "topic",
        "topic_b",
        "option_a",
        "option_a_cap",
        "option_b",
        "fact",
        "fact_typos",
        "contradiction",
        "subtopic",
        "commitment",
        "ramble",
        "vent",
        "marker",
        "recall_hint",
        "contact",
        "private_detail",
    }
)
#: Live placeholders the runner fills (datasets.render).
TEMPLATE_PLACEHOLDERS = frozenset({"eir_first_name", "other_venture"})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ValueSpec(_Strict):
    label: str = Field(min_length=2, max_length=60)
    description: str = Field(min_length=3, max_length=240)
    checks: list[str] = Field(default_factory=list)
    judge: list[str] = Field(default_factory=list)
    #: The value appears only together with these values of other dimensions.
    requires: dict[str, list[str]] = Field(default_factory=dict)


class DimensionSpec(_Strict):
    title: str = Field(min_length=3, max_length=60)
    values: dict[str, ValueSpec] = Field(min_length=2)
    #: The value that costs nothing extra (preferred when a choice covers nothing new).
    default: str | None = None
    #: Dimensions whose pairs with this one the covering array must cover (default: every other dimension).
    pairs_with: list[str] | None = None


class CheckSpec(_Strict):
    family: Family
    severity: Literal["low", "medium", "high"]
    means: str = Field(min_length=5, max_length=300)


class HumannessSpec(_Strict):
    rule_weight: float = Field(gt=0, le=1)
    judge_weight: float = Field(ge=0, le=1)
    families: dict[str, float]
    excluded_families: list[str] = Field(default_factory=list)


class Taxonomy(_Strict):
    version: Literal[1]
    dimensions: dict[str, DimensionSpec]
    always_checks: list[str]
    checks: dict[str, CheckSpec]
    humanness: HumannessSpec

    @model_validator(mode="after")
    def _consistent(self) -> Taxonomy:
        missing = [d for d in DIMENSIONS if d not in self.dimensions]
        extra = [d for d in self.dimensions if d not in DIMENSIONS]
        if missing or extra:
            raise ValueError(
                f"dimensions must be exactly {list(DIMENSIONS)} (missing {missing}, unknown {extra})"
            )
        for check in self.always_checks:
            if check not in self.checks:
                raise ValueError(f"always_checks: unknown check {check!r}")
        for dim_name, dim in self.dimensions.items():
            if dim.default is not None and dim.default not in dim.values:
                raise ValueError(f"{dim_name}: default {dim.default!r} is not one of its values")
            for other in dim.pairs_with or []:
                if other not in self.dimensions or other == dim_name:
                    raise ValueError(f"{dim_name}: pairs_with names an unknown dimension {other!r}")
            for value_name, value in dim.values.items():
                where = f"{dim_name}.{value_name}"
                for check in value.checks:
                    if check not in self.checks:
                        raise ValueError(f"{where}: unknown check {check!r}")
                for criterion in value.judge:
                    if criterion not in JUDGE_CRITERIA:
                        raise ValueError(f"{where}: unknown judge criterion {criterion!r}")
                for req_dim, req_values in value.requires.items():
                    if req_dim not in self.dimensions or req_dim == dim_name:
                        raise ValueError(f"{where}: requires an unknown dimension {req_dim!r}")
                    unknown = [v for v in req_values if v not in self.dimensions[req_dim].values]
                    if unknown or not req_values:
                        raise ValueError(f"{where}: requires unknown values {unknown} of {req_dim}")
        families = {c.family for c in self.checks.values()}
        for family in self.humanness.families:
            if family not in families:
                raise ValueError(f"humanness: no check is in family {family!r}")
        for family in families - set(self.humanness.families) - set(self.humanness.excluded_families):
            raise ValueError(f"humanness: family {family!r} has no weight and is not excluded")
        return self

    def values_of(self, dimension: str) -> list[str]:
        return list(self.dimensions[dimension].values)

    def allowed(self, assignment: dict[str, str]) -> bool:
        """Whether a (partial) assignment of values breaks no ``requires`` constraint among its own values."""
        for dim, value in assignment.items():
            for req_dim, req_values in self.dimensions[dim].values[value].requires.items():
                if req_dim in assignment and assignment[req_dim] not in req_values:
                    return False
        return True

    def pair_dimensions(self) -> list[tuple[str, str]]:
        """The dimension pairs the covering array covers (both orders of ``pairs_with`` are honoured)."""
        out: list[tuple[str, str]] = []
        for i, a in enumerate(DIMENSIONS):
            for b in DIMENSIONS[i + 1 :]:
                limit_a, limit_b = self.dimensions[a].pairs_with, self.dimensions[b].pairs_with
                if (limit_a is None or b in limit_a) and (limit_b is None or a in limit_b):
                    out.append((a, b))
        return out


class Persona(_Strict):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,30}$")
    summary: str = Field(min_length=10, max_length=240)
    goal: str = Field(min_length=5, max_length=200)
    topics: list[str] = Field(min_length=2)


class Topic(_Strict):
    name: str = Field(min_length=3, max_length=60)
    #: How the founder names the topic when asking "do you remember what I said about …?": never a recall term (a
    #: question that says the answer tests nothing).
    recall_hint: str = Field(min_length=3, max_length=60)
    detail: str = Field(min_length=10, max_length=240)
    #: The topic is being talked about (a reply on it names one of these).
    terms: list[str] = Field(min_length=1)
    #: Only someone who remembers what was said names these (recall, topic return).
    recall_terms: list[str] = Field(min_length=1)
    options: list[str] = Field(min_length=2, max_length=2)
    option_terms: list[list[str]] = Field(min_length=2, max_length=2)
    fact: str = Field(min_length=5, max_length=200)
    fact_terms: list[str] = Field(min_length=1)
    contradiction: str = Field(min_length=5, max_length=200)
    subtopic: str = Field(min_length=3, max_length=120)
    subtopic_terms: list[str] = Field(min_length=1)
    commitment: str = Field(min_length=10, max_length=200)
    commitment_terms: list[str] = Field(min_length=1)
    ramble: str = Field(min_length=120, max_length=1200)
    ramble_term: list[str] = Field(min_length=1)
    vent: str = Field(min_length=10, max_length=240)


class Templates(_Strict):
    version: Literal[1]
    personas: list[Persona] = Field(min_length=2)
    #: The default topics: the remembered (multi-session) conversations in the dedicated memory venture, and any
    #: venture without topics of its own.
    topics: dict[str, Topic] = Field(min_length=4)
    #: Each seeded venture's own topics, drawn from its seed facts (a founder of one venture never asks about
    #: another's product). A single-session scenario is planned for one of these ventures and takes its topics.
    venture_topics: dict[str, dict[str, Topic]] = Field(default_factory=dict)
    private_detail: str = Field(min_length=10, max_length=240)
    private_terms: list[str] = Field(min_length=1)
    phrases: dict[str, object]

    @model_validator(mode="after")
    def _consistent(self) -> Templates:
        for persona in self.personas:
            for topic in persona.topics:
                if topic not in self.topics:
                    raise ValueError(f"persona {persona.id}: unknown topic {topic!r}")
        for venture, own in self.venture_topics.items():
            if len(own) < 2:
                raise ValueError(f"venture {venture}: at least two topics (a scenario moves between two)")
        everything = [
            *self.topics.items(),
            *(
                (f"{venture}.{key}", topic)
                for venture, own in self.venture_topics.items()
                for key, topic in own.items()
            ),
        ]
        for key, topic in everything:
            # A topic's own sentences must carry the terms graders look for, or a check could never pass.
            if not mentions_any(topic.detail, topic.recall_terms):
                raise ValueError(f"topic {key}: the detail does not say any recall term")
            if not mentions_any(topic.detail, topic.terms):
                raise ValueError(f"topic {key}: the detail does not say any topic term")
            if mentions_any(topic.recall_hint, topic.recall_terms):
                raise ValueError(
                    f"topic {key}: the recall hint says a recall term (the question would hold the answer)"
                )
            for option, terms in zip(topic.options, topic.option_terms, strict=True):
                if not mentions_any(option, terms):
                    raise ValueError(f"topic {key}: option {option!r} does not say its terms")
            if not mentions_any(topic.fact, topic.fact_terms):
                raise ValueError(f"topic {key}: the fact does not say its terms")
            if not mentions_any(topic.subtopic, topic.subtopic_terms):
                raise ValueError(f"topic {key}: the subtopic does not say its terms")
            if not mentions_any(topic.commitment, topic.commitment_terms):
                raise ValueError(f"topic {key}: the commitment does not say its terms")
            if not mentions_any(topic.ramble, topic.ramble_term):
                raise ValueError(f"topic {key}: the ramble does not say its term")
            for term in [*topic.terms, *topic.recall_terms, *topic.commitment_terms, *topic.subtopic_terms]:
                if len(term.strip("* ")) < 2:
                    raise ValueError(f"topic {key}: term too short to mean anything: {term!r}")
        if not mentions_any(self.private_detail, self.private_terms):
            raise ValueError("private_detail does not say any private term")
        for text in _strings(self.phrases):
            unknown_slots = set(SLOT.findall(text)) - TEMPLATE_SLOTS
            if unknown_slots:
                raise ValueError(f"unknown template slots {sorted(unknown_slots)} in {text!r}")
            unknown = set(PLACEHOLDER.findall(text)) - TEMPLATE_PLACEHOLDERS
            if unknown:
                raise ValueError(f"unknown placeholders {sorted(unknown)} in {text!r}")
        return self

    def topics_for(self, venture: str | None) -> dict[str, Topic]:
        """The topics a scenario planned for ``venture`` talks about (its own, else the default topics)."""
        return self.venture_topics.get(venture or "", self.topics)

    def bank(self, *path: str) -> list[str]:
        """A phrase list by its path (``bank("question", "open")``); a missing one is a dataset error."""
        node: object = self.phrases
        for key in path:
            if not isinstance(node, dict) or key not in node:
                raise DatasetError(f"templates.yaml: no phrases at {'.'.join(path)}")
            node = node[key]
        if not isinstance(node, list) or not node or not all(isinstance(x, str) for x in node):
            raise DatasetError(f"templates.yaml: {'.'.join(path)} is not a list of phrases")
        return node

    def mapping(self, *path: str) -> dict[str, str]:
        node: object = self.phrases
        for key in path:
            if not isinstance(node, dict) or key not in node:
                raise DatasetError(f"templates.yaml: no mapping at {'.'.join(path)}")
            node = node[key]
        if not isinstance(node, dict):
            raise DatasetError(f"templates.yaml: {'.'.join(path)} is not a mapping")
        return {str(k): str(v) for k, v in node.items()}


def _strings(node: object) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, list):
        return [s for item in node for s in _strings(item)]
    if isinstance(node, dict):
        return [s for item in node.values() for s in _strings(item)]
    return []


def _load(path: Path) -> object:
    try:
        return yaml.safe_load(path.read_bytes())
    except OSError as exc:
        raise DatasetError(f"cannot read {path.name}: {exc.strerror}") from exc
    except yaml.YAMLError as exc:
        raise DatasetError(f"{path.name} is not valid YAML") from exc


def _describe(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in err['loc']) or '<root>'}: {err['msg']}" for err in exc.errors()[:8]
    )


def load_taxonomy(path: Path | None = None) -> Taxonomy:
    path = path or TAXONOMY_PATH
    try:
        return Taxonomy.model_validate(_load(path))
    except ValidationError as exc:
        raise DatasetError(f"{path.name}: {_describe(exc)}") from exc


def load_templates(path: Path | None = None) -> Templates:
    path = path or TEMPLATES_PATH
    try:
        templates = Templates.model_validate(_load(path))
    except ValidationError as exc:
        raise DatasetError(f"{path.name}: {_describe(exc)}") from exc
    for required in (
        ("phrases", "topic_intro"),
        ("phrases", "closing"),
        ("phrases", "contacts"),
        ("phrases", "gen_z_leads"),
        ("phrases", "gen_z_tails"),
    ):
        templates.bank(*required[1:])
    return templates


def matrix_digest(*paths: Path) -> str:
    """A short digest of the matrix datasets (results name the exact taxonomy and templates a run used)."""
    h = hashlib.sha256()
    for path in paths:
        h.update(path.read_bytes())
    return h.hexdigest()[:12]
