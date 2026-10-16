import { z } from 'zod';

import { NextAction } from './coach.js';
import { Id, Timestamp } from './domain.js';
import { AvatarProviderId } from './knowledge.js';

/**
 * vEIR calls (ADR-0010 revision, docs/architecture/calls.md).
 *
 * A call is a mode of a conversation: spoken turns are ordinary turns with `channel: 'voice'`, so the
 * orchestrator, validators, evidence, memory proposals, escalation and spend caps all apply. Speech-to-text
 * runs browser → Amazon Transcribe over a short-lived presigned WebSocket (audio never passes through our
 * API). The vEIR's reply is streamed as validated `turn.speech` units, each signed so `POST /speech` only
 * ever voices text the validators approved.
 */

/** How the founder's speech becomes text. `typed` is the always-available fallback. */
export const CallInputMode = z.enum(['transcribe', 'typed']);
export type CallInputMode = z.infer<typeof CallInputMode>;

export const CallStatus = z.enum(['live', 'ended']);
export type CallStatus = z.infer<typeof CallStatus>;

export const CallEndReason = z.enum(['user', 'timeout', 'budget', 'disabled', 'error', 'navigated']);
export type CallEndReason = z.infer<typeof CallEndReason>;

export const CallView = z.object({
  id: Id,
  sessionId: Id,
  ventureId: Id,
  personaId: Id,
  status: CallStatus,
  provider: AvatarProviderId,
  inputMode: CallInputMode,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  endReason: CallEndReason.nullable(),
  /** Hard limit for this call (the smaller of the per-call cap and today's remaining minutes). */
  maxSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(0).nullable(),
});
export type CallView = z.infer<typeof CallView>;

/**
 * Presigned Amazon Transcribe streaming URL for the browser. It only opens the stream and expires within
 * seconds (`expiresAt`); a stream already open keeps running. Ask for a fresh one to reconnect.
 */
export const SttGrant = z.object({
  url: z.url(),
  expiresAt: Timestamp,
  languageCode: z.string(),
  sampleRateHertz: z.number().int(),
  mediaEncoding: z.literal('pcm'),
});
export type SttGrant = z.infer<typeof SttGrant>;

/** A validated unit the vEIR may speak, with the server's signature over (turnId|null, seq, text). */
export const SpeechUnit = z.object({
  text: z.string().min(1).max(600),
  sig: z.string().min(16).max(200),
});
export type SpeechUnit = z.infer<typeof SpeechUnit>;

/** `POST /sessions/:id/calls` */
export const StartCallRequest = z.object({
  inputMode: CallInputMode.default('transcribe'),
  /**
   * End the caller's live call in another conversation (as `navigated`) instead of answering 409. Without it,
   * a live call elsewhere refuses the start.
   */
  replace: z.boolean().optional(),
});
export type StartCallRequest = z.infer<typeof StartCallRequest>;

export const StartCallResponse = z.object({
  call: CallView,
  /** Null when `inputMode` is `typed` or speech-to-text is unavailable in this environment. */
  sttGrant: SttGrant.nullable(),
  /** Short pre-approved greeting the vEIR speaks first (from the notebook opener), signed like a unit. */
  intro: SpeechUnit.nullable(),
});
export type StartCallResponse = z.infer<typeof StartCallResponse>;

/** `POST /calls/:id/stt-grant` — re-mint the Transcribe URL on reconnect or unmute. */
export const SttGrantResponse = SttGrant;

export const CallState = z.enum(['listening', 'thinking', 'speaking', 'idle', 'muted', 'reconnecting']);
export type CallState = z.infer<typeof CallState>;

/** `POST /calls/:id/heartbeat` — every 15 s; carries the kill switch and budget without websockets. */
export const CallHeartbeatRequest = z.object({
  state: CallState,
  micOpenSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600),
});
export const CallHeartbeatResponse = z.object({
  remainingSeconds: z.number().int().min(0),
  action: z.enum(['continue', 'terminate']),
  reason: CallEndReason.nullable(),
});
export type CallHeartbeatResponse = z.infer<typeof CallHeartbeatResponse>;

/** `POST /calls/:id/end` — idempotent. Client stats are numbers only (no content). */
export const EndCallRequest = z.object({
  reason: CallEndReason,
  clientStats: z
    .object({
      firstAudioMsP50: z.number().int().min(0).max(120_000).nullable(),
      firstAudioMsP95: z.number().int().min(0).max(120_000).nullable(),
      bargeIns: z.number().int().min(0).max(10_000),
      reconnects: z.number().int().min(0).max(10_000),
    })
    .optional(),
});
export type EndCallRequest = z.infer<typeof EndCallRequest>;

export const CallSummary = z.object({
  turnCount: z.number().int().min(0),
  durationSeconds: z.number().int().min(0),
  memoryProposalIds: z.array(Id),
  nextActions: z.array(NextAction),
  escalationIds: z.array(Id),
});
export type CallSummary = z.infer<typeof CallSummary>;

export const EndCallResponse = z.object({ call: CallView, summary: CallSummary });
export type EndCallResponse = z.infer<typeof EndCallResponse>;

export const CallDetailResponse = z.object({ call: CallView, summary: CallSummary.nullable() });

/** A unit the founder heard to its end, as played: streamed units carry their `turn.speech` signature. */
export const HeardUnit = z.object({
  seq: z.number().int().min(0).max(10_000),
  text: z.string().trim().min(1).max(600),
  sig: z.string().min(16).max(200).optional(),
});
export type HeardUnit = z.infer<typeof HeardUnit>;

/** `POST /turns/:id/interrupt` — barge-in: the founder spoke over the vEIR. */
export const InterruptTurnRequest = z.object({
  callId: Id,
  /** The last speech unit the founder actually heard (-1 when none). */
  heardSeq: z.number().int().min(-1),
  /**
   * Units 0…`heardSeq` in order, as played. The server verifies them (signatures, or whole sentences of the
   * stored spoken reply) and replays only their words in the conversation history. Without them, the reply is
   * left out of the history.
   */
  heard: z.array(HeardUnit).max(64).optional(),
});
export type InterruptTurnRequest = z.infer<typeof InterruptTurnRequest>;
