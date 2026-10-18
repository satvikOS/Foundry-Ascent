import { z } from 'zod';

import { CoachResponse, SessionRecap, SessionView, TurnView, ValidatorResults } from './coach.js';
import { PersonaKnowledgeSourceView, TurnChannel } from './knowledge.js';
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
  PersonaReleaseStatus,
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
/**
 * A venture name as written by people (create and rename): trimmed, 3–80 characters. The server also
 * requires it to be distinctive (not a common English word, at least 4 letters for a single word) and
 * unique within the tenant (case-insensitive), because other ventures' names feed the cross-venture guard;
 * a violation is 422 `validation_failed` on `name` (or 409 `conflict` for a duplicate).
 */
export const VentureName = z.string().trim().min(3).max(80);
export const UpdateVentureRequest = z
  .object({
    name: VentureName,
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
  /** Optional conversation title; the server derives one from the first message when absent. */
  title: z.string().trim().min(1).max(120).nullable().default(null),
  /*
   * Additive. What New chat greeted the person with, so the conversation opens with that same line: the `at` of
   * the `GET /ventures/:id/opener` preview it showed (the line is phrased as of then, within an hour), or null when
   * it showed no opener (the conversation then opens without one). Left out, the opener is chosen at creation.
   */
  openerShownAt: Timestamp.nullable().optional(),
});
export const UpdateSessionRequest = z
  .object({ title: z.string().trim().min(1).max(120).optional() })
  .refine((value) => value.title !== undefined, 'Nothing to update');
export const SessionListResponse = z.object({ items: z.array(SessionView) });
/**
 * `GET /sessions` query: the caller's conversations across their ventures, latest activity first (sidebar
 * recents). `mine`: conversations the caller started; `all`: every conversation the caller may open. Pass the
 * previous page's `nextCursor` as `cursor`.
 */
export const SessionListQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  ventureId: Id.optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type SessionListQuery = z.infer<typeof SessionListQuery>;
/** `GET /sessions` 200 body. */
export const SessionPageResponse = Page(SessionView);
/** `PATCH /sessions/:id` 200 body. */
export const UpdateSessionResponse = SessionView;
/** `POST /ventures/:id/sessions` 201 body. */
export const CreateSessionResponse = SessionView;
/**
 * `GET /ventures/:id/opener` 200 body: how the vEIR would open a new standard conversation of the caller now (the
 * line it stores as the conversation's first message, and a call says after introducing itself), so New chat and
 * the call screen can greet with it before anything is sent. `lastConversation` is the caller's latest earlier
 * conversation it picks up. Both null for a first conversation; a temporary chat opens with neither. The line
 * names when that conversation was ("about 3 minutes ago"), so a conversation created with `openerShownAt: at`
 * says it as it was shown, however long the person took to write.
 */
export const ConversationOpenerResponse = z.object({
  opener: z.string().nullable(),
  /** When the line was phrased (server time): sent back as `CreateSessionRequest.openerShownAt` once shown. */
  at: Timestamp,
  lastConversation: z
    .object({
      sessionId: Id,
      lastActivityAt: Timestamp,
      channel: z.enum(['call', 'chat']),
      /** Founder words (the first ordinary message, or the name a person gave it). */
      title: z.string().nullable(),
    })
    .nullable(),
});
export type ConversationOpenerResponse = z.infer<typeof ConversationOpenerResponse>;
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
  /** `voice` when the message was spoken during a call: the response then carries a short `spoken` form. */
  channel: TurnChannel.optional(),
  /** The live call this spoken turn belongs to (required by the server when `channel` is `voice`). */
  callId: Id.optional(),
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
  /** Page size (default 50, at most {@link MEMORY_PAGE_MAX}). */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** `nextCursor` of the previous page. */
  cursor: z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, 'Invalid cursor')
    .optional(),
});
/** Largest memory list page. */
export const MEMORY_PAGE_MAX = 100;
/** Characters of `content` a memory list item carries; `GET /memory/:id` returns the full text. */
export const MEMORY_LIST_EXCERPT_CHARS = 400;
/**
 * `GET /ventures/:id/memory` 200 body: one page of items whose `content` is an excerpt of at most
 * {@link MEMORY_LIST_EXCERPT_CHARS} characters (`contentLength` is the full length), so every response
 * (and every database result behind it) stays far below the RDS Data API's 1 MB limit. `nextCursor` is
 * null on the last page. Fetch `GET /memory/:id` for the full item.
 */
export const MemoryListResponse = z.object({
  items: z.array(MemoryObjectView),
  nextCursor: z.string().nullable().default(null),
});
/** `GET /memory/:id` 200 body: the full item (complete `content`). */
export const MemoryItemResponse = MemoryObjectView;
/** `POST /ventures/:id/memory` 201 body. */
export const CreateMemoryResponse = MemoryObjectView;
/** Largest serialised `attributes` object of a memory item (keeps list pages small). */
export const MEMORY_ATTRIBUTES_MAX_CHARS = 8000;
export const MemoryAttributes = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= MEMORY_ATTRIBUTES_MAX_CHARS,
    `Attributes are limited to ${MEMORY_ATTRIBUTES_MAX_CHARS} characters of JSON`,
  );
export const CreateMemoryRequest = z.object({
  type: MemoryType,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(8000),
  visibility: Visibility.default('venture'),
  attributes: MemoryAttributes.default({}),
  sourceRefs: z
    .array(SourceRef)
    .max(50)
    .default([{ kind: 'manual', id: 'founder' }]),
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
        attributes: MemoryAttributes,
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
/** `POST /ventures/:id/memory/batch`: approve or reject several pending proposals at once (the "To review" queue). */
export const BatchMemoryActionRequest = z.object({
  ids: z.array(Id).min(1).max(50),
  action: z.enum(['approve', 'reject']),
});
export type BatchMemoryActionRequest = z.infer<typeof BatchMemoryActionRequest>;
/** 200 body: the items that changed, and the ids that could not be (no longer pending, or not visible). */
export const BatchMemoryActionResponse = z.object({
  items: z.array(MemoryObjectView),
  skippedIds: z.array(Id),
});
export type BatchMemoryActionResponse = z.infer<typeof BatchMemoryActionResponse>;

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
/**
 * `POST /personas/:id/knowledge/uploads` 201 body: the persona knowledge source (`processing` once complete)
 * and a presigned PUT, exactly like a venture document upload. Body: `CreateDocumentRequest`.
 */
export const CreatePersonaUploadResponse = z.object({
  source: PersonaKnowledgeSourceView,
  upload: CreateDocumentResponse.shape.upload,
});
/** `POST /documents/:id/complete` body: 202 while ingestion runs (`status: processing`), else 200. */
export const CompleteDocumentResponse = DocumentView;
/**
 * `POST /documents/:id/upload` 200 body: a fresh presigned PUT for a document whose file never finished
 * uploading (`pending_upload`, or `failed` with `upload_incomplete` / `object_missing`), which is
 * `pending_upload` again. A retry reuses the document instead of registering another one.
 */
export const RenewDocumentUploadResponse = CreateDocumentResponse;
/**
 * `POST /documents/:id/abandon` 200 body: an upload that stopped (failed, or the person left) is marked
 * `failed` with `upload_incomplete`; a document already past `pending_upload` is returned as it is.
 */
export const AbandonDocumentUploadResponse = DocumentView;

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
export const TeamResponse = z.object({
  /**
   * The venture's id and name, for everyone who may list its team: program leads and platform admins open any
   * venture's team without reading the venture itself. Additive: older payloads parse as null.
   */
  venture: z.object({ id: Id, name: z.string() }).nullable().default(null),
  items: z.array(TeamMemberView),
});
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
/**
 * `POST /persona-releases/:id/withdraw` 200 body: a superseded release (or a draft) taken out of use, e.g. a
 * doctrine error found after the fact. Conversations still on it move to the active release at their next
 * message. The active release is never withdrawn (approve a corrected one, which supersedes it).
 */
export const WithdrawPersonaReleaseResponse = PersonaReleaseView;
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

/** An expertise tag as the registry keeps them: lower case, words joined by hyphens ("b2b-sales"). */
export const ExpertiseTag = z
  .string()
  .trim()
  .toLowerCase()
  .transform((tag) => tag.replace(/\s+/g, '-'))
  .pipe(
    z
      .string()
      .min(2, 'Use 2 to 40 characters for each area.')
      .max(40, 'Use 2 to 40 characters for each area.'),
  );
const ExpertiseTags = z
  .array(ExpertiseTag)
  .max(12, 'List at most 12 areas.')
  .transform((tags) => [...new Set(tags)]);
/** Optional text: trimmed, and empty means none. */
const OptionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullable()
    .transform((value) => (value === '' ? null : value));
const EirDisplayName = z
  .string()
  .trim()
  .min(2, 'Enter the person’s name.')
  .max(120, 'Use 120 characters or fewer.');
const EirTitle = OptionalText(120, 'Use 120 characters or fewer.');
const EirBio = OptionalText(2000, 'Use 2,000 characters or fewer.');

/**
 * `POST /eir/profiles` body (program lead or platform admin): the EIR a vEIR may be built from, linked to the
 * person's own account (`principalId`: someone of the tenant with the EIR role and no profile yet). It does not
 * record consent: that stays the person's own act, before any vEIR built from them can be released.
 * 201 body: `EirProfileView`.
 */
export const CreateEirProfileRequest = z.object({
  principalId: Id,
  displayName: EirDisplayName,
  title: EirTitle.default(null),
  expertiseTags: ExpertiseTags.default([]),
  bio: EirBio.default(null),
});
/** `PATCH /eir/profiles/:id` body (program lead or platform admin). 200 body: `EirProfileView`. */
export const UpdateEirProfileRequest = z
  .object({
    displayName: EirDisplayName.optional(),
    title: EirTitle.optional(),
    expertiseTags: ExpertiseTags.optional(),
    bio: EirBio.optional(),
  })
  .refine(
    (patch) =>
      patch.displayName !== undefined ||
      patch.title !== undefined ||
      patch.expertiseTags !== undefined ||
      patch.bio !== undefined,
    'Nothing to update',
  );
/**
 * `GET /eir/candidates` 200 body: people of the tenant with the EIR role and no EIR profile yet, whom a
 * profile can be linked to (program lead or platform admin).
 */
export const EirCandidateListResponse = z.object({ items: z.array(PrincipalView) });

/** Most earlier exchanges a test message carries (the client keeps the transcript; the server keeps none). */
export const TEST_TURN_MAX_HISTORY = 6;
/** One earlier exchange of a test conversation, as the client kept it. */
export const TestTurnExchange = z.object({
  text: z.string().trim().min(1).max(8000),
  /** The answer shown for it; null when it was blocked or failed. */
  answer: z.string().max(12_000).nullable(),
});
/**
 * `POST /personas/:id/test-turns` — the EIR studio test bench: one message to a release of the persona (its
 * active release or a draft), answered by the same pipeline as a founder's message (prompt from the release's
 * doctrine and style and the persona's common pool, identity guard, validators, crisis support) with no venture
 * attached. Nothing is stored: no conversation, turn, memory, notebook, escalation or review row. The client
 * keeps the transcript and sends the last few exchanges back. Curators only (program leads and the EIR the
 * persona is built from). Model calls are metered under purpose `test_bench`, within the daily caps.
 */
export const TestTurnRequest = z.object({
  releaseId: Id,
  text: z.string().trim().min(1).max(8000),
  /** A fixed mode (one the release allows); without it the vEIR picks one, as for founders. */
  mode: CoachMode.optional(),
  rehearsalCounterpart: z.string().trim().max(120).optional(),
  history: z.array(TestTurnExchange).max(TEST_TURN_MAX_HISTORY).default([]),
});
export type TestTurnRequest = z.input<typeof TestTurnRequest>;
/** `POST /personas/:id/test-turns` 200 body. */
export const TestTurnResponse = z.object({
  release: z.object({ id: Id, version: z.number().int(), status: PersonaReleaseStatus }),
  status: z.enum(['completed', 'blocked']),
  /** The validated response, exactly as a founder would see it; null when blocked. */
  response: CoachResponse.nullable(),
  /** The sources the answer could cite (the persona's common pool; no venture's). */
  evidence: z.array(EvidenceItem),
  /**
   * What the deterministic checks did. As in founder views, nothing says which names the cross-venture guard
   * knows (no cross-venture flag, category or note); such a block reads as `policy`.
   */
  validator: ValidatorResults,
  /** Why a founder would not see this answer, and the support offered instead (crisis lines). */
  blocked: z.object({ reason: z.string(), supportMessage: z.string().nullable() }).nullable(),
});
export type TestTurnResponse = z.infer<typeof TestTurnResponse>;

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
  /** The active assignment: its persona, its reviewing EIR and when it started. Additive. */
  personaId: Id.nullable().default(null),
  reviewingEir: z.object({ id: Id, displayName: z.string() }).nullable().default(null),
  assignedAt: Timestamp.nullable().default(null),
  createdAt: Timestamp,
});
export const ProgramVentureListResponse = z.object({ items: z.array(ProgramVentureRow) });
/** `POST /program/ventures` 201 body. */
export const CreateProgramVentureResponse = ProgramVentureRow;
/**
 * `PATCH /program/ventures/:id` body (program lead or platform admin of the tenant): renames any venture,
 * e.g. to undo a misleading rename by its team. 200 body: `ProgramVentureRow`.
 */
export const RenameVentureRequest = z.object({ name: VentureName });
export const RenameVentureResponse = ProgramVentureRow;
export const CreateVentureRequest = z.object({
  name: VentureName,
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
  /** Documents one person may start uploading per UTC day (checked when the upload URL is issued). */
  dailyUploadDocumentsPerPrincipal: z.number().int().min(0).max(1000),
  /** Bytes one person may start uploading per UTC day (sum of the declared document sizes). */
  dailyUploadBytesPerPrincipal: z
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024 * 1024),
  /** Longest voice call in minutes. Additive: older APIs send none. */
  maxCallMinutes: z.number().int().min(1).max(240).optional(),
  /** Voice-call minutes one person may use per UTC day. Additive: older APIs send none. */
  dailyCallMinutesPerPrincipal: z.number().int().min(0).max(1440).optional(),
  /** Kill switch for streamed replies (`turn.delta`); off means whole replies only. Additive. */
  streamingEnabled: z.boolean().optional(),
  /** Kill switch for voice calls (new calls refused, live calls end at the next heartbeat). Additive. */
  callsEnabled: z.boolean().optional(),
  /**
   * The vEIR's video face on calls (a vendor avatar of the EIR, under likeness consent). Off: every call shows
   * the presence, and a live face ends at the next heartbeat. Additive (absent: off).
   */
  facesEnabled: z.boolean().optional(),
  /**
   * The EIR's cloned voice on calls (under voice consent). Off: calls speak with the persona's stock voice.
   * Additive (absent: off).
   */
  clonedVoiceEnabled: z.boolean().optional(),
  /** Video minutes (a face on calls) one person may use per calendar month (UTC). Additive. */
  faceMinutesPerPrincipalMonth: z.number().int().min(0).max(10_000).optional(),
  /** Video minutes one call may use (the vendor session's own limit). Additive. */
  faceMinutesPerCall: z.number().int().min(1).max(240).optional(),
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
  /**
   * Totals per ledger purpose (turn, recap, distill, speech, …), last 30 days, most expensive first. For
   * `speech`, `inputTokens` counts the characters synthesized. Additive: older APIs send none.
   */
  byPurpose: z
    .array(
      z.object({
        purpose: z.string(),
        usd: z.number(),
        calls: z.number().int(),
        inputTokens: z.number().int(),
        outputTokens: z.number().int(),
      }),
    )
    .default([]),
});

/**
 * Admin → Usage → Insights (platform admin, the admin's tenant, last `days` days): how conversations, calls and
 * the vEIR's knowledge are doing, as counts and timings only. No conversation content.
 */
export const AdminInsights = z.object({
  days: z.number().int(),
  /** Conversations active in the window per channel (`voice`: at least one turn spoken in a call). */
  conversations: z.array(
    z.object({
      channel: TurnChannel,
      conversations: z.number().int(),
      turns: z.number().int(),
      averageTurns: z.number(),
    }),
  ),
  /** Temporary (private) conversations: never distilled, by design. */
  privateConversations: z.number().int(),
  calls: z.object({ calls: z.number().int(), minutes: z.number() }),
  /** Standard conversations with answered turns, by where their distillation stands. */
  distillation: z.object({
    upToDate: z.number().int(),
    /** Turns no digest covers yet (waiting for the delayed job, the end of the conversation or the daily run). */
    pending: z.number().int(),
    running: z.number().int(),
    /** Recorded without a digest in the window (nothing worth keeping, or the model gave no usable answer). */
    dropped: z.number().int(),
    failed: z.number().int(),
  }),
  memory: z.array(
    z.object({
      ventureId: Id,
      ventureName: z.string(),
      digests: z.number().int(),
      proposed: z.number().int(),
      confirmed: z.number().int(),
      /** Rejected, expired, deleted, disputed or superseded. */
      other: z.number().int(),
    }),
  ),
  /** Server time from a turn's admission to its answer, and to the first words shown (streamed turns). */
  latency: z.array(
    z.object({
      channel: TurnChannel,
      turns: z.number().int(),
      p50Ms: z.number().int().nullable(),
      p95Ms: z.number().int().nullable(),
      firstWordsP50Ms: z.number().int().nullable(),
      firstWordsP95Ms: z.number().int().nullable(),
    }),
  ),
});
