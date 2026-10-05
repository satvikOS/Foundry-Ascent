import { type ErrorCode, type ProblemDetails, REQUEST_ID_HEADER } from '@foundry/contracts';
import { DomainError, isDomainError, toDomainError } from '@foundry/core';

import { type AppContext } from './types.js';

/** RFC 9457 media type for every error response. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Problem type URIs are stable identifiers (not dereferenceable): `urn:foundry-ascent:problem:<code>`. */
export function problemType(code: ErrorCode): string {
  return `urn:foundry-ascent:problem:${code}`;
}

const TITLES: Readonly<Record<ErrorCode, string>> = {
  bad_request: 'Bad request',
  validation_failed: 'Validation failed',
  unauthenticated: 'Authentication required',
  invalid_access_code: 'Invalid access code',
  rate_limited: 'Too many requests',
  locked_out: 'Too many failed attempts',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  idempotency_conflict: 'Idempotency key reused',
  persona_suspended: 'Coach suspended',
  assignment_inactive: 'Coaching assignment inactive',
  ai_disabled: 'AI coaching paused',
  spend_cap_reached: 'Daily AI budget reached',
  session_ended: 'Session ended',
  session_turn_limit: 'Session turn limit reached',
  database_resuming: 'Workspace waking up',
  model_unavailable: 'Coaching model unavailable',
  upload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  internal: 'Internal error',
};

/** Safe, generic message for unexpected failures: no class names, messages or stack traces. */
export const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred. Please try again.';

export interface ClassifiedError {
  readonly error: DomainError;
  /** True when the original error was not a known domain/infrastructure error (log it as a bug). */
  readonly unexpected: boolean;
}

/**
 * Maps anything thrown by a handler to a DomainError: DomainErrors as-is, infrastructure errors through
 * core's `toDomainError` (DatabaseResumingError → 503 database_resuming, SQLSTATEs, model errors), and
 * everything else to a generic 500 `internal`.
 */
export function classifyError(err: unknown): ClassifiedError {
  const mapped = toDomainError(err);
  if (isDomainError(mapped)) return { error: mapped, unexpected: false };
  return {
    error: new DomainError('internal', INTERNAL_ERROR_MESSAGE, { reason: 'unexpected_error' }),
    unexpected: true,
  };
}

/**
 * Codes that always tell the client when to retry: `Retry-After` and `retryAfterSeconds` are sent even
 * if the error was raised without a value (these are the fallbacks).
 */
export const DEFAULT_RETRY_AFTER_SECONDS: Readonly<Partial<Record<ErrorCode, number>>> = {
  database_resuming: 10,
  locked_out: 15 * 60,
  rate_limited: 60,
  spend_cap_reached: 60 * 60,
};

export function problemDetails(error: DomainError, requestId: string): ProblemDetails {
  const body: ProblemDetails = {
    type: problemType(error.code),
    title: TITLES[error.code],
    status: error.status,
    // DomainError messages are written to be shown (never content); unknown errors never get here.
    detail: error.message,
    code: error.code,
    requestId,
  };
  const retry = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS[error.code];
  if (retry !== undefined) body.retryAfterSeconds = retryAfter(retry);
  if (error.errors !== undefined && error.errors.length > 0) {
    body.errors = error.errors.map((e) => ({ path: e.path, message: e.message }));
  }
  return body;
}

function retryAfter(seconds: number): number {
  return Math.max(1, Math.ceil(seconds));
}

/** Writes the problem+json response (with Retry-After when the error carries one). */
export function problemResponse(c: AppContext, error: DomainError): Response {
  const requestId = c.get('requestId');
  c.set('errorCode', error.code);
  const body = problemDetails(error, requestId);
  c.header('content-type', PROBLEM_CONTENT_TYPE);
  c.header(REQUEST_ID_HEADER, requestId);
  if (body.retryAfterSeconds !== undefined) c.header('retry-after', String(body.retryAfterSeconds));
  return c.body(JSON.stringify(body), error.status as 400);
}

/** Shorthand for API-originated errors. */
export const httpError = {
  badRequest: (message: string, reason: string): DomainError =>
    new DomainError('bad_request', message, { reason }),
  forbidden: (message: string, reason: string): DomainError =>
    new DomainError('forbidden', message, { reason }),
  notFound: (message = 'Resource not found', reason = 'route_not_found'): DomainError =>
    new DomainError('not_found', message, { reason }),
  tooLarge: (message: string): DomainError =>
    new DomainError('upload_too_large', message, { reason: 'body_too_large' }),
  unsupportedMediaType: (message: string): DomainError =>
    new DomainError('unsupported_media_type', message, { reason: 'content_type' }),
};
