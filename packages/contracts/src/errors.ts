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
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 problem details. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: ErrorCode,
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
  internal: 500,
};
