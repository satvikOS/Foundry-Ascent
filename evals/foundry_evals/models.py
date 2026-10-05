"""Pydantic mirrors of the API contracts the harness consumes (``packages/contracts/src``).

Only the fields the harness reads are modelled; unknown fields are ignored so additive API changes do
not break a run. Required fields stay required, so a contract break fails loudly instead of being
graded as an empty response. ``tests/test_contract_drift.py`` checks the mirrors against the
TypeScript sources.

API views use camelCase JSON (exposed here as snake_case attributes); the model response contract
(``CoachResponse``) uses snake_case JSON.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, TypeAdapter
from pydantic.alias_generators import to_camel

# Enumerations (packages/contracts/src/domain.ts) ----------------------------------------------------

COACH_MODES: tuple[str, ...] = ("diagnose", "challenge", "coach", "teach", "rehearse", "route")
ESCALATION_CATEGORIES: tuple[str, ...] = (
    "security_identity",
    "ip_licensing",
    "legal",
    "securities_investment",
    "medical_regulatory",
    "safety_wellbeing",
    "conflict_harassment",
    "expert_judgment",
    "low_grounding",
    "other",
)
TURN_STREAM_EVENTS: tuple[str, ...] = (
    "turn.accepted",
    "turn.status",
    "turn.completed",
    "turn.blocked",
    "turn.error",
)

CoachModeName = Literal["diagnose", "challenge", "coach", "teach", "rehearse", "route"]
EscalationCategoryName = Literal[
    "security_identity",
    "ip_licensing",
    "legal",
    "securities_investment",
    "medical_regulatory",
    "safety_wellbeing",
    "conflict_harassment",
    "expert_judgment",
    "low_grounding",
    "other",
]


class _Snake(BaseModel):
    """JSON keys equal the attribute names (model response contract)."""

    model_config = ConfigDict(extra="ignore")


class _Camel(BaseModel):
    """camelCase JSON keys exposed as snake_case attributes (API views)."""

    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


# Coach response contract (packages/contracts/src/coach.ts) -------------------------------------------


class Claim(_Snake):
    text: str
    kind: Literal["fact", "inference", "hypothesis", "recommendation"]
    evidence_ids: list[str]


class UncertaintyItem(_Snake):
    item: str
    level: Literal["low", "medium", "high"]


class NextAction(_Snake):
    owner: str
    action: str
    target_date: str | None


class EscalationProposal(_Snake):
    required: bool
    category: str | None
    priority: str | None
    reason: str | None
    requested_role: str | None


class MemoryCandidate(_Snake):
    type: str
    title: str
    content: str
    evidence_ids: list[str]
    confidence: float


class RehearsalScore(_Snake):
    criterion: str
    score: float
    note: str


class RehearsalBlock(_Snake):
    counterpart: str
    line: str
    scores: list[RehearsalScore]
    critique: str


class CoachResponse(_Snake):
    mode: str
    answer: str
    claims: list[Claim]
    uncertainty: list[UncertaintyItem]
    challenge: str | None
    next_actions: list[NextAction]
    escalation: EscalationProposal
    memory_candidates: list[MemoryCandidate]
    follow_up_questions: list[str]
    rehearsal: RehearsalBlock | None


# API views --------------------------------------------------------------------------------------------


class EvidenceItem(_Camel):
    key: str
    kind: str
    ref_id: str
    title: str
    excerpt: str
    score: float
    freshness_at: str | None = None
    status: str | None = None


class ValidatorResults(_Camel):
    unknown_evidence_ids_removed: int
    facts_downgraded: int
    grounding_coverage: float | None
    narrowed: bool
    escalation_forced: bool
    identity_violation: bool
    cross_venture_violation: bool
    risk_categories: list[str]
    notes: list[str]


class TurnUsage(_Camel):
    model_id: str
    fallback_used: bool
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int


class TurnBlockedDetail(_Camel):
    """Why a stored turn was blocked: the same fields as the live ``turn.blocked`` event."""

    reason: str
    support_message: str | None = None
    escalation_id: str | None = None


class TurnView(_Camel):
    id: str
    session_id: str
    ordinal: int
    mode: str
    founder_text: str
    status: Literal["pending", "completed", "blocked", "failed"]
    response: CoachResponse | None
    evidence: list[EvidenceItem]
    validator: ValidatorResults | None
    usage: TurnUsage | None
    created_at: str
    completed_at: str | None
    # Set for blocked turns (absent from older APIs).
    blocked: TurnBlockedDetail | None = None


class PrincipalRef(_Camel):
    id: str
    display_name: str


class SessionView(_Camel):
    id: str
    venture_id: str
    mode: str
    privacy: Literal["standard", "ephemeral"]
    status: Literal["active", "ended", "suspended"]
    persona_name: str
    persona_version: int
    disclosure: str
    started_by: PrincipalRef
    turn_count: int


class SessionDetail(_Camel):
    session: SessionView
    turns: list[TurnView]


class PrincipalView(_Camel):
    id: str
    display_name: str
    title: str | None = None
    synthetic: bool


class TenantView(_Camel):
    id: str
    slug: str
    name: str


class MembershipView(_Camel):
    venture_id: str
    venture_name: str
    role: Literal["founder", "team", "advisor"]


class Me(_Camel):
    principal: PrincipalView
    tenant: TenantView
    roles: list[str]
    memberships: list[MembershipView]
    disclosure: str
    ai_enabled: bool


class AdminAccessCodeRow(_Camel):
    id: str
    prefix: str
    label: str


class AdminPrincipalRow(_Camel):
    principal: PrincipalView
    status: Literal["active", "disabled"]
    roles: list[str]
    memberships: list[MembershipView]
    active_access_codes: list[AdminAccessCodeRow] = Field(default_factory=list)


class AccessCodeIssued(_Camel):
    """A one-time access code. ``access_code`` is a SecretStr: it never appears in repr or logs."""

    access_code_id: str
    principal: PrincipalView
    access_code: SecretStr
    expires_at: str | None


class AssignedEir(_Camel):
    id: str
    display_name: str
    synthetic: bool


class PersonaSummary(_Camel):
    name: str
    disclosure: str


class VentureSummary(_Camel):
    id: str
    name: str
    one_liner: str = ""
    stage: str
    domain: str
    status: str
    my_role: Literal["founder", "team", "advisor"] | None = None


class VentureDetail(VentureSummary):
    persona: PersonaSummary | None = None
    assigned_eir: AssignedEir | None = None


class ProgramVentureRow(_Camel):
    id: str
    name: str
    stage: str
    domain: str
    status: str


class MemoryObject(_Camel):
    id: str
    venture_id: str
    type: str
    title: str
    content: str
    status: str
    visibility: Literal["founder_private", "team", "venture", "advisors"]


class DocumentView(_Camel):
    id: str
    venture_id: str
    filename: str
    status: Literal["pending_upload", "processing", "ready", "failed", "deleted"]


class UploadTarget(_Camel):
    url: str
    method: Literal["PUT"]
    headers: dict[str, str]


class CreateDocumentResponse(_Camel):
    document: DocumentView
    upload: UploadTarget


class HealthResponse(_Camel):
    """Public ``GET /health``: never queries the database (so polling it cannot keep Aurora awake).

    ``db`` is the state the serving API instance last observed on real requests, and is absent when it
    has none (for example right after a deploy or a cold start).
    """

    status: Literal["ok", "degraded"]
    version: str
    db: Literal["awake", "resuming", "unavailable"] | None = None
    time: str | None = None


class ProblemDetails(_Camel):
    type: str = "about:blank"
    title: str = ""
    status: int
    detail: str | None = None
    code: str = "internal"
    request_id: str | None = None
    retry_after_seconds: int | None = None


# Turn stream events (POST /sessions/:id/turns, system design §6.1) -----------------------------------


class TurnAccepted(_Camel):
    event: Literal["turn.accepted"]
    turn_id: str
    ordinal: int


class TurnStatus(_Camel):
    event: Literal["turn.status"]
    phase: Literal["classifying", "retrieving", "reasoning", "validating"]
    detail: str | None = None
    evidence_count: int | None = None


class TurnCompleted(_Camel):
    event: Literal["turn.completed"]
    turn: TurnView


class TurnBlocked(_Camel):
    event: Literal["turn.blocked"]
    turn_id: str
    reason: str
    escalation_id: str | None = None
    support_message: str | None = None


class TurnError(_Camel):
    event: Literal["turn.error"]
    turn_id: str | None = None
    code: str
    message: str
    retryable: bool
    retry_after_seconds: int | None = None
    request_id: str | None = None


TurnStreamEvent = Annotated[
    TurnAccepted | TurnStatus | TurnCompleted | TurnBlocked | TurnError,
    Field(discriminator="event"),
]
TURN_STREAM_EVENT_ADAPTER: TypeAdapter[TurnStreamEvent] = TypeAdapter(TurnStreamEvent)
