import { z } from 'zod';

import {
  CoachMode,
  EscalationCategory,
  EscalationPriority,
  EvidenceItem,
  Id,
  MemoryType,
  RequestedRole,
  RiskCategory,
  Timestamp,
} from './domain.js';

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
});

/**
 * Known `reason` values of a blocked turn (`turn.blocked` events and `TurnView.blocked`). The field stays a
 * string on the wire so a new reason never breaks an older client. Founders and teams see `policy` where
 * the server recorded `cross_venture` (a privacy or safety check held the answer back); the specific
 * reason is only in staff views and the audit log.
 */
export const TURN_BLOCK_REASONS = ['crisis_support', 'policy', 'identity', 'invalid_schema'] as const;
/** Staff-only block reason (the founder/team-facing reason is `policy`). */
export const STAFF_ONLY_BLOCK_REASONS = ['cross_venture'] as const;

/**
 * Why a turn was blocked and what the founder is offered instead: the same fields as the `turn.blocked`
 * event, so a reloaded session shows the same support message and request as the live stream did.
 * `supportMessage` is set for crisis support (human resources and crisis lines, Markdown); `escalationId`
 * is the support request drafted for the turn, if any. It never repeats the founder's text or blocked
 * model output.
 */
export const TurnBlockedDetail = z.object({
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
