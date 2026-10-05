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
  MembershipRole,
  MemoryEventView,
  MemoryObjectView,
  MemoryStatus,
  MemoryType,
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
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  db: z.enum(['awake', 'resuming', 'unavailable']),
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
export const SessionDetailResponse = z.object({ session: SessionView, turns: z.array(TurnView) });
export const CreateTurnRequest = z.object({
  text: z.string().trim().min(1).max(8000),
  mode: CoachMode.optional(),
  rehearsalCounterpart: z.string().trim().max(120).optional(),
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
  pinned: z.coerce.boolean().optional(),
});
export const MemoryListResponse = z.object({ items: z.array(MemoryObjectView) });
export const CreateMemoryRequest = z.object({
  type: MemoryType,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(8000),
  visibility: Visibility.default('venture'),
  attributes: z.record(z.string(), z.unknown()).default({}),
  sourceRefs: z.array(SourceRef).default([{ kind: 'manual', id: 'founder' }]),
});
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
  upload: z.object({ url: z.url(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: Timestamp }),
});
export const DocumentListResponse = z.object({ items: z.array(DocumentView) });

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
    resolution: z.object({ summary: z.string().trim().min(1).max(4000), nextSteps: z.array(z.string().max(500)).max(10) }),
  }),
  z.object({ action: z.literal('decline'), reason: z.string().trim().min(1).max(1000) }),
]);
export type EscalationAction = z.infer<typeof EscalationAction>;

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
export const CreateVentureRequest = z.object({
  name: z.string().trim().min(1).max(120),
  oneLiner: z.string().trim().max(280).default(''),
  stage: VentureStage.default('idea'),
  domain: VentureDomain.default('general'),
  cohort: z.string().trim().max(60).nullable().default(null),
});
export const ResourceListResponse = z.object({ items: z.array(ResourceView) });
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

// Admin --------------------------------------------------------------------------------------------
export const AdminPrincipalRow = z.object({
  principal: PrincipalView,
  email: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  roles: z.array(PlatformRole),
  memberships: z.array(z.object({ ventureId: Id, ventureName: z.string(), role: MembershipRole })),
  activeAccessCodes: z.array(
    z.object({ id: Id, prefix: z.string(), label: z.string(), createdAt: Timestamp, expiresAt: Timestamp.nullable(), lastUsedAt: Timestamp.nullable() }),
  ),
});
export const AdminPrincipalListResponse = z.object({ items: z.array(AdminPrincipalRow) });
export const CreatePrincipalRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().nullable().default(null),
  title: z.string().trim().max(120).nullable().default(null),
  roles: z.array(PlatformRole).default([]),
});
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
  byModel: z.array(z.object({ modelId: z.string(), usd: z.number(), inputTokens: z.number().int(), outputTokens: z.number().int() })),
});
