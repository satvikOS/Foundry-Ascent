import { z } from 'zod';

/** Stable machine-readable error codes. HTTP status is carried separately in the problem document. */
export const ErrorCode = z.enum([
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'invalid_access_code',
  'rate_limited',
  'locked_out',
  'forbidden',
  'not_found',
  'conflict',
  'idempotency_conflict',
  'persona_suspended',
  'assignment_inactive',
  'ai_disabled',
  'spend_cap_reached',
  'session_ended',
  'session_turn_limit',
  'database_resuming',
  'model_unavailable',
  'upload_too_large',
  'unsupported_media_type',
  'speech_unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * Reasons a client acts on, sent as a problem's `reason` next to its `code`: one code covers several
 * refusals (a 429 `rate_limited` is also the call's speech budget), and the call screen answers each its own
 * way. Every other reason a service records stays in the audit log.
 */
export const PUBLIC_PROBLEM_REASONS = [
  /** POST /speech, 429 `rate_limited`: the call's speech budget is used up for now. */
  'call_speech_limit',
  /** POST /speech, 429 `rate_limited`: the person's speech for today is used up. */
  'daily_speech_limit',
  /** POST /speech, 409 `conflict`: this unit (or the intro) was already voiced for this call. */
  'speech_already_played',
  /** POST /speech, 409 `conflict`: the crisis support line already played as often as it may. */
  'crisis_speech_limit',
  /** POST /calls/:id/face/*, 409 `conflict`: the call's face has ended (the call goes on with the presence). */
  'face_not_active',
] as const;
export type PublicProblemReason = (typeof PUBLIC_PROBLEM_REASONS)[number];

/** RFC 9457 problem details. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: ErrorCode,
  /**
   * Which refusal of `code` this is, when a client acts on it (PUBLIC_PROBLEM_REASONS). Any string is
   * accepted, so a reason added later never makes the whole problem unreadable to an older client.
   */
  reason: z.string().max(64).optional(),
  requestId: z.string(),
  retryAfterSeconds: z.number().int().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  invalid_access_code: 401,
  rate_limited: 429,
  locked_out: 429,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  persona_suspended: 423,
  assignment_inactive: 423,
  ai_disabled: 503,
  spend_cap_reached: 429,
  session_ended: 409,
  session_turn_limit: 409,
  database_resuming: 503,
  model_unavailable: 503,
  upload_too_large: 413,
  unsupported_media_type: 415,
  /** Server-side speech synthesis is not configured here (local development): the client speaks itself. */
  speech_unavailable: 501,
  internal: 500,
};
