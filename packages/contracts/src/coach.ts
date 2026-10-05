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

/** Deterministic validator outcomes attached to every turn (blueprint 03 §5 guards). */
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
  }),
]);
export type TurnStreamEvent = z.infer<typeof TurnStreamEvent>;

/** Persistent synthetic-identity disclosure (blueprint 01 F-09). Shown in every session and export. */
export const DEFAULT_DISCLOSURE =
  'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.';
