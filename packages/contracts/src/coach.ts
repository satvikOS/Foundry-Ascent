import { z } from 'zod';

import {
  CoachMode,
  EscalationCategory,
  EscalationPriority,
  EvidenceItem,
  Id,
  MemoryType,
  PersonaKind,
  RequestedRole,
  RiskCategory,
  Timestamp,
} from './domain.js';
import { ConversationDigest, TurnChannel } from './knowledge.js';

/**
 * The structured response contract the reasoning model must return before anything is shown
 * (blueprint 03 §5 "Response contract"). Every field is required and optional values are `null`
 * so the schema is valid for strict JSON-schema structured outputs.
 */
export const ClaimKind = z.enum(['fact', 'inference', 'hypothesis', 'recommendation']);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Claim = z.object({
  text: z.string(),
  kind: ClaimKind,
  evidence_ids: z.array(z.string()),
});
export type Claim = z.infer<typeof Claim>;

export const UncertaintyItem = z.object({
  item: z.string(),
  level: z.enum(['low', 'medium', 'high']),
});

export const NextAction = z.object({
  owner: z.string(),
  action: z.string(),
  target_date: z.string().nullable(), // ISO date (YYYY-MM-DD) or null
});
export type NextAction = z.infer<typeof NextAction>;

export const EscalationProposal = z.object({
  required: z.boolean(),
  category: EscalationCategory.nullable(),
  priority: EscalationPriority.nullable(),
  reason: z.string().nullable(),
  requested_role: RequestedRole.nullable(),
});
export type EscalationProposal = z.infer<typeof EscalationProposal>;

export const MemoryCandidate = z.object({
  type: MemoryType,
  title: z.string(),
  content: z.string(),
  evidence_ids: z.array(z.string()),
  confidence: z.number(),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const RehearsalBlock = z.object({
  counterpart: z.string(),
  line: z.string(),
  scores: z.array(z.object({ criterion: z.string(), score: z.number(), note: z.string() })),
  critique: z.string(),
});

export const CoachResponse = z.object({
  mode: CoachMode,
  answer: z.string(),
  claims: z.array(Claim),
  uncertainty: z.array(UncertaintyItem),
  challenge: z.string().nullable(),
  next_actions: z.array(NextAction),
  escalation: EscalationProposal,
  memory_candidates: z.array(MemoryCandidate),
  follow_up_questions: z.array(z.string()),
  rehearsal: RehearsalBlock.nullable(),
  /*
   * What a call speaks aloud: at most 70 words of plain sentences (no Markdown, no citation keys),
   * null for typed turns. `answer` stays the full transcript text. Additive: optional so responses
   * stored before calls existed still parse; the strict model schema still lists it as a required,
   * nullable property (`toStrictJsonSchema`), and the validator always sets it (null or text).
   */
  spoken: z.string().nullable().optional(),
});
export type CoachResponse = z.infer<typeof CoachResponse>;

/**
 * Deterministic validator outcomes attached to every turn (blueprint 03 §5 guards). In founder/team views
 * (session detail, turn events) `riskCategories` is always empty, `crossVentureViolation` false and the
 * notes carry no category or cross-venture codes: which names the cross-venture guard knows would reveal
 * other ventures and their members. The full values stay server-side (audit) and in staff views (EIR
 * calibration review).
 */
export const ValidatorResults = z.object({
  unknownEvidenceIdsRemoved: z.number().int(),
  factsDowngraded: z.number().int(),
  groundingCoverage: z.number().min(0).max(1).nullable(),
  narrowed: z.boolean(),
  escalationForced: z.boolean(),
  identityViolation: z.boolean(),
  crossVentureViolation: z.boolean(),
  riskCategories: z.array(RiskCategory),
  notes: z.array(z.string()),
});
export type ValidatorResults = z.infer<typeof ValidatorResults>;

export const TurnUsage = z.object({
  modelId: z.string(),
  fallbackUsed: z.boolean(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  latencyMs: z.number().int(),
  /**
   * Streamed turns: milliseconds from the turn request to the first validated sentence shown; null for whole
   * replies. Additive.
   */
  firstTokenMs: z.number().int().min(0).nullable().optional(),
});

/**
 * Why a turn was blocked and what the founder is offered instead: the same fields as the `turn.blocked`
 * event, so a reloaded session shows the same support message and request as the live stream did.
 * `supportMessage` is set for crisis support (human resources and crisis lines, Markdown); `escalationId`
 * is the support request drafted for the turn, if any. It never repeats the founder's text or blocked
 * model output.
 */
export const TurnBlockedDetail = z.object({
  /**
   * `crisis_support`, `policy`, `identity` or `invalid_schema`; a plain string so a new reason never breaks
   * an older client. Founders and teams see `policy` where the server recorded `cross_venture` (staff views
   * and the audit log keep the specific reason).
   */
  reason: z.string(),
  supportMessage: z.string().nullable(),
  escalationId: Id.nullable(),
});
export type TurnBlockedDetail = z.infer<typeof TurnBlockedDetail>;

export const TurnView = z.object({
  id: Id,
  sessionId: Id,
  ordinal: z.number().int(),
  mode: CoachMode,
  founderText: z.string(),
  status: z.enum(['pending', 'completed', 'blocked', 'failed']),
  response: CoachResponse.nullable(),
  evidence: z.array(EvidenceItem),
  validator: ValidatorResults.nullable(),
  usage: TurnUsage.nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
  /**
   * Set when `status` is `blocked`, null otherwise. Additive: a payload without it (an older API) parses as
   * null.
   */
  blocked: TurnBlockedDetail.nullable().default(null),
  /** Typed in chat or spoken during a call. Additive: older payloads parse as `text`. */
  channel: TurnChannel.default('text'),
  /**
   * Who wrote the message (a founder or team member; any of them may write in a venture's conversation). Null
   * where the viewer is not shown it (staff reviews) or in older payloads. Additive.
   */
  author: z.object({ id: Id, displayName: z.string() }).nullable().default(null),
  /**
   * The viewer's own rating of the answer (1–5; the thumbs send 5 and 1), so a rating survives a reload. Null
   * when they have not rated it, or in older payloads. Additive.
   */
  myFeedback: z
    .object({ rating: z.number().int().min(1).max(5) })
    .nullable()
    .default(null),
});
export type TurnView = z.infer<typeof TurnView>;

/** The five visible objects every substantive session ends with (blueprint 02 §3 session contract). */
export const SessionRecap = z.object({
  diagnosis: z.object({
    stage: z.string(),
    immediate_constraint: z.string(),
    riskiest_assumption: z.string(),
  }),
  evidence: z.array(z.object({ evidence_key: z.string(), title: z.string(), note: z.string() })),
  challenge: z.string(),
  next_actions: z.array(NextAction),
  escalation: EscalationProposal,
  memory_candidate_ids: z.array(Id),
  generated_at: Timestamp,
});
export type SessionRecap = z.infer<typeof SessionRecap>;

export const SessionView = z.object({
  id: Id,
  ventureId: Id,
  mode: CoachMode,
  privacy: z.enum(['standard', 'ephemeral']),
  goal: z.string().nullable(),
  status: z.enum(['active', 'ended', 'suspended']),
  personaName: z.string(),
  personaVersion: z.number().int(),
  disclosure: z.string(),
  startedBy: z.object({ id: Id, displayName: z.string() }),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  turnCount: z.number().int(),
  recap: SessionRecap.nullable(),
  /** Conversation title (from the first message, refined by distillation). Additive. */
  title: z.string().nullable().default(null),
  /** The vEIR persona of this conversation. Additive. */
  personaId: Id.nullable().default(null),
  /**
   * Its kind, so a conversation with a persona the venture no longer has is named after that persona (a guide
   * keeps its own name). Additive: older payloads parse as null.
   */
  personaKind: PersonaKind.nullable().default(null),
  /** Time of the latest turn, or the start time. Additive. */
  lastActivityAt: Timestamp.nullable().default(null),
  /** Whether any turn of this conversation was spoken during a call. Additive. */
  hasCalls: z.boolean().default(false),
  /** Conversation digest (never for temporary chats). Additive. */
  digest: ConversationDigest.nullable().default(null),
  /**
   * The digest was deleted by a founder or team member; distillation never writes it again. Lets a reloaded
   * page say so instead of waiting for a summary. Additive: older payloads parse as false.
   */
  digestDeleted: z.boolean().default(false),
  /**
   * The vEIR's opening line, stored at create from the notebook's `nextOpener`. Shown as the vEIR's first
   * message and replayed into the model's history. Additive.
   */
  opener: z.string().max(300).nullable().default(null),
});
export type SessionView = z.infer<typeof SessionView>;

// --------------------------------------------------------------------------------------------------
// Server-sent events for POST /sessions/:id/turns
// --------------------------------------------------------------------------------------------------

export const TurnStatusPhase = z.enum(['classifying', 'retrieving', 'reasoning', 'validating']);

export const TurnStreamEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('turn.accepted'), turnId: Id, ordinal: z.number().int() }),
  z.object({
    event: z.literal('turn.status'),
    phase: TurnStatusPhase,
    detail: z.string().nullable(),
    evidenceCount: z.number().int().nullable(),
  }),
  /**
   * A validated unit of the answer prose (sentence-gated: identity, cross-venture and markdown checks ran
   * on it), streamed before the turn completes. `turn.completed` stays authoritative and replaces the
   * streamed text. Additive: older clients ignore it.
   */
  z.object({
    event: z.literal('turn.delta'),
    turnId: Id,
    seq: z.number().int().min(0),
    text: z.string(),
  }),
  /**
   * Voice channel only: a validated unit the vEIR may speak, signed by the server so `POST /speech` voices
   * nothing else. Additive.
   */
  z.object({
    event: z.literal('turn.speech'),
    turnId: Id,
    seq: z.number().int().min(0),
    text: z.string().min(1).max(600),
    sig: z.string().min(16).max(200),
    /**
     * The turn's last unit, when that is known as it is sent: the end of a reply said whole (the crisis support
     * message, a reply written whole, including one written whole after its stream was given up). A streamed
     * reply's units are sent the moment each is validated and nothing is said after them, so none of them is
     * marked final: `turn.completed` ends the turn.
     */
    final: z.boolean(),
  }),
  z.object({ event: z.literal('turn.completed'), turn: TurnView }),
  z.object({
    event: z.literal('turn.blocked'),
    turnId: Id,
    reason: z.string(),
    escalationId: Id.nullable(),
    supportMessage: z.string().nullable(),
  }),
  z.object({
    event: z.literal('turn.error'),
    turnId: Id.nullable(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    /**
     * Seconds to wait before trying again. Set when the server knows: a retried message whose original
     * turn is still being answered (`conflict`; resend with the same Idempotency-Key to replay it), a
     * model that is temporarily unavailable. Optional (additive).
     */
    retryAfterSeconds: z.number().int().min(1).optional(),
    /** The request that produced the event (the response's `x-request-id`), for support. Optional (additive). */
    requestId: z.string().min(1).optional(),
  }),
]);
export type TurnStreamEvent = z.infer<typeof TurnStreamEvent>;

/** Persistent synthetic-identity disclosure (blueprint 01 F-09). Shown in every session and export. */
export const DEFAULT_DISCLOSURE =
  'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.';
