import { z } from 'zod';

import { SessionRecap, SessionView, TurnView } from './coach.js';
import {
  CoachMode,
  Doctrine,
  DocumentContentType,
  DocumentView,
  EirProfileView,
  EscalationCategory,
  EscalationPriority,
  EscalationStatus,
  EvidenceItem,
  Id,
  MAX_DOCUMENT_BYTES,
  Me,
  MembershipRole,
  MemoryEventView,
  MemoryObjectView,
  MemoryStatus,
  MemoryType,
  PersonaReleaseView,
  PersonaView,
  PlatformRole,
  PrincipalView,
  RequestedRole,
  ResourceKind,
  ResourceView,
  SessionPrivacy,
  SourceRef,
  Style,
  Timestamp,
  VentureDetail,
  VentureDomain,
  VentureStage,
  VentureSummary,
  Visibility,
} from './domain.js';

export const API_PREFIX = '/api/v1';
/** Required on every non-GET request (CSRF defence in depth alongside SameSite=Strict cookies). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'foundry-ascent';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REQUEST_ID_HEADER = 'x-request-id';
export const SESSION_COOKIE = 'fa_session';

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// Health ------------------------------------------------------------------------------------------
/**
 * `GET /health` (public, liveness): never queries the database, so polling it cannot keep Aurora awake.
 * `version` is the deployed release (`APP_VERSION`, the git SHA in CI). `db` is the state this API
 * instance last observed while serving real requests (within the last few minutes) and is absent when it
 * has no recent observation. `GET /admin/health` (platform admin) probes the database and always sets it.
 */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  db: z.enum(['awake', 'resuming', 'unavailable']).optional(),
  time: Timestamp,
});

// Auth ---------------------------------------------------------------------------------------------
export const ACCESS_CODE_PATTERN = /^FA-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;
export const SignInRequest = z.object({
  accessCode: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(ACCESS_CODE_PATTERN, 'Access codes look like FA-XXXXX-XXXXX-XXXXX-XXXXX')),
});
/**
 * `POST /auth/sign-in` 200 body: the signed-in principal (same shape as `GET /me`). The session itself
 * travels only in the `fa_session` cookie (HttpOnly), never in the body.
 */
export const SignInResponse = Me;
export type SignInResponse = z.infer<typeof SignInResponse>;

// Ventures -----------------------------------------------------------------------------------------
export const VentureListResponse = z.object({ items: z.array(VentureSummary) });
export const VentureDetailResponse = VentureDetail;
export const UpdateVentureRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    oneLiner: z.string().trim().max(280),
    stage: VentureStage,
    domain: VentureDomain,
    currentGoal: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const VentureOverview = z.object({
  venture: VentureDetail,
  sinceLastSession: z.object({
    lastSessionAt: Timestamp.nullable(),
    newEvidence: z.array(MemoryObjectView),
    changedMemory: z.array(MemoryObjectView),
  }),
  currentGoal: z.string().nullable(),
  verifiedDecisions: z.array(MemoryObjectView),
  openAssumptions: z.array(MemoryObjectView),
  overdueActions: z.array(MemoryObjectView),
  upcomingMilestones: z.array(MemoryObjectView),
  pendingMemoryCount: z.number().int(),
  openEscalations: z.number().int(),
  recentSessions: z.array(SessionView),
});
export type VentureOverview = z.infer<typeof VentureOverview>;

// Sessions and turns -------------------------------------------------------------------------------
export const CreateSessionRequest = z.object({
  mode: CoachMode.default('diagnose'),
  goal: z.string().trim().max(500).nullable().default(null),
  privacy: SessionPrivacy.default('standard'),
});
export const SessionListResponse = z.object({ items: z.array(SessionView) });
/** `POST /ventures/:id/sessions` 201 body. */
export const CreateSessionResponse = SessionView;
export const SessionDetailResponse = z.object({ session: SessionView, turns: z.array(TurnView) });
export const CreateTurnRequest = z.object({
  text: z.string().trim().min(1).max(8000),
  mode: CoachMode.optional(),
  rehearsalCounterpart: z.string().trim().max(120).optional(),
  /**
   * The ordinal the client expects this turn to get (the session's turn count + 1). A retry that sends
   * the same ordinal, author and text replays the stored turn instead of calling the model again; a
   * different turn already holding that ordinal is answered with 409 `conflict`. Optional.
   */
  expectedOrdinal: z.number().int().min(1).max(100_000).optional(),
});
export const EndSessionResponse = z.object({ session: SessionView, recap: SessionRecap.nullable() });
export const TurnFeedbackRequest = z.object({
  rating: z.number().int().min(1).max(5),
  flags: z
    .array(z.enum(['inaccurate', 'unsupported', 'unhelpful', 'too_generic', 'unsafe', 'great_challenge']))
    .max(6)
    .default([]),
  comment: z.string().trim().max(2000).nullable().default(null),
});
export const TurnEvidenceResponse = z.object({ items: z.array(EvidenceItem) });

// Memory -------------------------------------------------------------------------------------------
export const MemoryQuery = z.object({
  type: MemoryType.optional(),
  status: MemoryStatus.optional(),
  q: z.string().trim().max(200).optional(),
  /**
   * Query-string flag: `true/false`, `1/0`, `yes/no`, `on/off` (case-insensitive, surrounding spaces
   * ignored), or a boolean when the query is built in code. Unlike `z.coerce.boolean()`, `"false"` means false and other text is rejected.
   */
  pinned: z.union([z.boolean(), z.string().trim().pipe(z.stringbool())]).optional(),
});
export const MemoryListResponse = z.object({ items: z.array(MemoryObjectView) });
/** `POST /ventures/:id/memory` 201 body. */
export const CreateMemoryResponse = MemoryObjectView;
export const CreateMemoryRequest = z.object({
  type: MemoryType,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(8000),
  visibility: Visibility.default('venture'),
  attributes: z.record(z.string(), z.unknown()).default({}),
  sourceRefs: z.array(SourceRef).default([{ kind: 'manual', id: 'founder' }]),
});
/**
 * `PATCH /memory/:id` body. `approve`, `reject`, `dispute`, `pin` and `unpin` answer 200 with the item
 * (`MemoryObjectView`); `correct` answers 200 with the new version that supersedes it; `delete` answers
 * **204 No Content** (no body).
 */
export const MemoryAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), reason: z.string().trim().max(500).optional() }),
  z.object({
    action: z.literal('correct'),
    patch: z
      .object({
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(8000),
        attributes: z.record(z.string(), z.unknown()),
        visibility: Visibility,
        confidence: z.number().min(0).max(1),
      })
      .partial(),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({ action: z.literal('dispute'), reason: z.string().trim().max(500) }),
  z.object({ action: z.literal('pin') }),
  z.object({ action: z.literal('unpin') }),
  z.object({ action: z.literal('delete'), reason: z.string().trim().max(500).optional() }),
]);
export type MemoryAction = z.infer<typeof MemoryAction>;
/** `PATCH /memory/:id` 200 body for every action except `delete` (204, no body). */
export const MemoryActionResponse = MemoryObjectView;
export const MemoryHistoryResponse = z.object({ items: z.array(MemoryEventView) });

// Documents ----------------------------------------------------------------------------------------
export const CreateDocumentRequest = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^/\\]+$/, 'Filename must not contain path separators'),
  contentType: DocumentContentType,
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
});
export const CreateDocumentResponse = z.object({
  document: DocumentView,
  upload: z.object({
    url: z.url(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expiresAt: Timestamp,
  }),
});
export const DocumentListResponse = z.object({ items: z.array(DocumentView) });
/** `POST /documents/:id/complete` body: 202 while ingestion runs (`status: processing`), else 200. */
export const CompleteDocumentResponse = DocumentView;

// Escalations --------------------------------------------------------------------------------------
export const EscalationPacket = z.object({
  founderQuestion: z.string(),
  desiredDecision: z.string().nullable(),
  sharedFacts: z.array(z.object({ memoryId: Id.nullable(), text: z.string() })),
  evidenceConsidered: z.array(z.object({ key: z.string(), title: z.string() })),
  conflictingSignals: z.array(z.string()),
  unknowns: z.array(z.string()),
  reason: z.string(),
  urgency: z.string(),
  proposedNextStep: z.string().nullable(),
  sessionSummary: z.string().nullable(),
  aiGenerated: z.literal(true),
});
export type EscalationPacket = z.infer<typeof EscalationPacket>;

export const EscalationView = z.object({
  id: Id,
  ventureId: Id,
  ventureName: z.string(),
  sessionId: Id.nullable(),
  turnId: Id.nullable(),
  category: EscalationCategory,
  priority: EscalationPriority,
  status: EscalationStatus,
  requestedRole: RequestedRole,
  packet: EscalationPacket.nullable(), // null when the viewer may only see metadata
  sharingConsentAt: Timestamp.nullable(),
  assignee: PrincipalView.nullable(),
  dueAt: Timestamp.nullable(),
  resolution: z.object({ summary: z.string(), nextSteps: z.array(z.string()) }).nullable(),
  createdBy: PrincipalView,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type EscalationView = z.infer<typeof EscalationView>;
export const EscalationListResponse = z.object({ items: z.array(EscalationView) });
/** `POST /ventures/:id/escalations` 201 body. */
export const CreateEscalationResponse = EscalationView;
export const CreateEscalationRequest = z.object({
  turnId: Id.nullable().default(null),
  category: EscalationCategory,
  priority: EscalationPriority.default('P2'),
  requestedRole: RequestedRole.default('eir'),
  founderQuestion: z.string().trim().min(1).max(2000),
  desiredDecision: z.string().trim().max(1000).nullable().default(null),
});
export const EscalationAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve_sharing'), sharedMemoryIds: z.array(Id).max(30).default([]) }),
  z.object({
    action: z.literal('edit'),
    packet: EscalationPacket.pick({ founderQuestion: true, desiredDecision: true, unknowns: true }).partial(),
  }),
  z.object({ action: z.literal('withdraw') }),
  z.object({ action: z.literal('acknowledge') }),
  z.object({
    action: z.literal('resolve'),
    resolution: z.object({
      summary: z.string().trim().min(1).max(4000),
      nextSteps: z.array(z.string().max(500)).max(10),
    }),
  }),
  z.object({ action: z.literal('decline'), reason: z.string().trim().min(1).max(1000) }),
]);
export type EscalationAction = z.infer<typeof EscalationAction>;
/** `PATCH /escalations/:id` 200 body. */
export const EscalationActionResponse = EscalationView;

// Team ---------------------------------------------------------------------------------------------
export const TeamMemberView = z.object({
  principal: PrincipalView,
  role: MembershipRole,
  grantedAt: Timestamp,
  expiresAt: Timestamp.nullable(),
});
export const TeamResponse = z.object({ items: z.array(TeamMemberView) });
export const InviteMemberRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().nullable().default(null),
  title: z.string().trim().max(120).nullable().default(null),
  role: MembershipRole,
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});
/** The plaintext access code is returned exactly once. */
export const AccessCodeIssued = z.object({
  accessCodeId: Id,
  principal: PrincipalView,
  accessCode: z.string(),
  expiresAt: Timestamp.nullable(),
});

// EIR studio ---------------------------------------------------------------------------------------
export const PersonaListResponse = z.object({ items: z.array(PersonaView) });
export const CreatePersonaReleaseRequest = z.object({
  doctrine: Doctrine,
  style: Style,
  disclosureText: z.string().trim().min(40).max(600),
  allowedModes: z.array(CoachMode).min(1),
});
export const SuspendPersonaRequest = z.object({ reason: z.string().trim().min(3).max(500) });
/** `POST /personas/:id/releases` 201 body. */
export const CreatePersonaReleaseResponse = PersonaReleaseView;
/**
 * `GET /persona-releases/:id` 200 body: the full release (doctrine, style, disclosure, modes), e.g. a draft
 * under review. Drafts and withdrawn releases: program leads, platform admins and the EIR linked to the
 * persona; approved and superseded releases: every EIR-studio role of the tenant.
 */
export const PersonaReleaseDetailResponse = PersonaReleaseView;
/** `POST /persona-releases/:id/approve` 200 body. */
export const ApprovePersonaReleaseResponse = PersonaReleaseView;
/** `POST /personas/:id/suspend` 200 body. */
export const SuspendPersonaResponse = PersonaView;
/** `POST /personas/:id/resume` 200 body. */
export const ResumePersonaResponse = PersonaView;
/** `POST /eir/reviews/:turnId` 201 body. */
export const SubmitReviewResponse = z.object({ reviewId: Id, turnId: Id });
export const ReviewSample = z.object({
  turn: TurnView,
  ventureId: Id,
  ventureName: z.string(),
  reviewed: z.boolean(),
});
export const ReviewQueueResponse = z.object({ items: z.array(ReviewSample) });
export const ReviewScore = z.number().int().min(1).max(5);
export const SubmitReviewRequest = z.object({
  scores: z.object({
    correctness: ReviewScore,
    rigor: ReviewScore,
    specificity: ReviewScore,
    teachability: ReviewScore,
    personaFit: ReviewScore,
    escalation: ReviewScore,
  }),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export const EirProfileListResponse = z.object({ items: z.array(EirProfileView) });

// Program ------------------------------------------------------------------------------------------
export const PortfolioSummary = z.object({
  minGroupSize: z.number().int(),
  venturesByStage: z.record(z.string(), z.number().int().nullable()),
  escalationsByCategory: z.record(z.string(), z.number().int().nullable()),
  openEscalationsByPriority: z.record(z.string(), z.number().int()),
  activeVentures30d: z.number().int(),
  sessions30d: z.number().int(),
  confirmedDecisions30d: z.number().int(),
  experimentsCompleted30d: z.number().int(),
  medianFeedbackRating30d: z.number().nullable(),
});
export type PortfolioSummary = z.infer<typeof PortfolioSummary>;
export const ProgramVentureRow = z.object({
  id: Id,
  name: z.string(),
  stage: VentureStage,
  domain: VentureDomain,
  status: z.string(),
  memberCount: z.number().int(),
  personaName: z.string().nullable(),
  createdAt: Timestamp,
});
export const ProgramVentureListResponse = z.object({ items: z.array(ProgramVentureRow) });
/** `POST /program/ventures` 201 body. */
export const CreateProgramVentureResponse = ProgramVentureRow;
export const CreateVentureRequest = z.object({
  name: z.string().trim().min(1).max(120),
  oneLiner: z.string().trim().max(280).default(''),
  stage: VentureStage.default('idea'),
  domain: VentureDomain.default('general'),
  cohort: z.string().trim().max(60).nullable().default(null),
});
export const ResourceListResponse = z.object({ items: z.array(ResourceView) });
/** `POST /program/resources` 201 body. */
export const CreateResourceResponse = ResourceView;
/** `PATCH /program/resources/:id` 200 body. */
export const UpdateResourceResponse = ResourceView;
/** `GET /program/resources` query (all optional; text values are trimmed). */
export const ResourceFilter = z.object({
  kind: ResourceKind.optional(),
  stage: VentureStage.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().max(200).optional(),
});
export type ResourceFilter = z.infer<typeof ResourceFilter>;
export const UpsertResourceRequest = z.object({
  name: z.string().trim().min(1).max(160),
  kind: ResourceKind,
  description: z.string().trim().min(1).max(2000),
  url: z.url().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  stages: z.array(VentureStage).default([]),
  eligibility: z.string().trim().max(500).nullable().default(null),
  owner: z.string().trim().max(120).nullable().default(null),
});
/**
 * `PATCH /program/resources/:id` body: any subset of the `UpsertResourceRequest` fields plus `status`.
 * No defaults are applied (an omitted field is left unchanged); at least one field is required.
 */
export const UpdateResourceRequest = z
  .object({
    name: z.string().trim().min(1).max(160),
    kind: ResourceKind,
    description: z.string().trim().min(1).max(2000),
    url: z.url().nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    stages: z.array(VentureStage),
    eligibility: z.string().trim().max(500).nullable(),
    owner: z.string().trim().max(120).nullable(),
    status: ResourceView.shape.status,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export type UpdateResourceRequest = z.infer<typeof UpdateResourceRequest>;
export const EscalationQueueItem = z.object({
  id: Id,
  ventureId: Id,
  ventureName: z.string(),
  category: EscalationCategory,
  priority: EscalationPriority,
  status: EscalationStatus,
  requestedRole: RequestedRole,
  assigneeId: Id.nullable(),
  dueAt: Timestamp.nullable(),
  createdAt: Timestamp,
  shared: z.boolean(),
});
export const EscalationQueueResponse = z.object({ items: z.array(EscalationQueueItem) });
export const RouteEscalationRequest = z.object({ assigneeId: Id, dueAt: Timestamp.nullable().default(null) });
/** `POST /program/escalations/:id/route` 200 body (queue metadata, never the packet). */
export const RouteEscalationResponse = EscalationQueueItem;
/** Roles that make a principal eligible to receive a routed escalation: EIRs and program staff (§4.2). */
export const EscalationAssigneeRole = PlatformRole.extract(['eir', 'program_lead']);
export type EscalationAssigneeRole = z.infer<typeof EscalationAssigneeRole>;
/**
 * `GET /program/assignees` item (program lead / platform admin): an active principal of the tenant who can
 * be chosen in `POST /program/escalations/:id/route`. Directory metadata only; `expertiseTags` come from
 * the person's active EIR profile, if any.
 */
export const EscalationAssignee = z.object({
  principal: PrincipalView,
  roles: z.array(EscalationAssigneeRole).min(1),
  expertiseTags: z.array(z.string()),
});
export type EscalationAssignee = z.infer<typeof EscalationAssignee>;
export const EscalationAssigneeListResponse = z.object({ items: z.array(EscalationAssignee) });

// Admin --------------------------------------------------------------------------------------------
export const AdminPrincipalRow = z.object({
  principal: PrincipalView,
  email: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  roles: z.array(PlatformRole),
  memberships: z.array(z.object({ ventureId: Id, ventureName: z.string(), role: MembershipRole })),
  activeAccessCodes: z.array(
    z.object({
      id: Id,
      prefix: z.string(),
      label: z.string(),
      createdAt: Timestamp,
      expiresAt: Timestamp.nullable(),
      lastUsedAt: Timestamp.nullable(),
    }),
  ),
});
export const AdminPrincipalListResponse = z.object({ items: z.array(AdminPrincipalRow) });
/** `POST /admin/principals` 201 body (the new principal as the admin list shows it; no access code). */
export const CreatePrincipalResponse = AdminPrincipalRow;
export const CreatePrincipalRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().nullable().default(null),
  title: z.string().trim().max(120).nullable().default(null),
  roles: z.array(PlatformRole).default([]),
});
/** `DELETE /admin/access-codes/:id` 200 body. */
export const RevokeAccessCodeResponse = z.object({ accessCodeId: Id, revokedAt: Timestamp });
export const IssueAccessCodeRequest = z.object({
  label: z.string().trim().min(1).max(80).default('access code'),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
});
export const PlatformSettingsView = z.object({
  aiEnabled: z.boolean(),
  dailyUsdCapGlobal: z.number().min(0).max(100),
  dailyUsdCapPerPrincipal: z.number().min(0).max(50),
  maxTurnsPerSession: z.number().int().min(1).max(200),
  groundingCoverageThreshold: z.number().min(0).max(1),
  portfolioMinGroupSize: z.number().int().min(2).max(20),
});
export type PlatformSettingsView = z.infer<typeof PlatformSettingsView>;
export const UpdateSettingsRequest = PlatformSettingsView.partial();
export const AuditEventView = z.object({
  id: z.number().int(),
  at: Timestamp,
  action: z.string(),
  outcome: z.string(),
  actorId: Id.nullable(),
  ventureId: Id.nullable(),
  objectType: z.string().nullable(),
  objectId: z.string().nullable(),
  policyReason: z.string().nullable(),
  requestId: z.string().nullable(),
  hash: z.string(),
});
export const AuditQuery = z.object({
  action: z.string().max(80).optional(),
  outcome: z.string().max(20).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const AuditListResponse = Page(AuditEventView);
export const UsageSummary = z.object({
  todayUsd: z.number(),
  last30DaysUsd: z.number(),
  capGlobalUsd: z.number(),
  byDay: z.array(z.object({ day: z.string(), usd: z.number(), turns: z.number().int() })),
  byModel: z.array(
    z.object({
      modelId: z.string(),
      usd: z.number(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
    }),
  ),
});
