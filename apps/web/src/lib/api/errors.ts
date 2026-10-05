import { ErrorCode, ProblemDetails } from '@foundry/contracts';

/** Server error codes plus failures that only exist on the client. */
export type ClientErrorCode =
  ErrorCode | 'network_error' | 'invalid_response' | 'stream_interrupted' | 'contract_mismatch';

export interface FieldError {
  path: string;
  message: string;
}

interface ApiErrorInit {
  status: number;
  code: ClientErrorCode;
  title: string;
  detail?: string | undefined;
  requestId?: string | undefined;
  retryAfter?: number | undefined;
  fieldErrors?: FieldError[] | undefined;
  cause?: unknown;
}

/**
 * Every failed API call surfaces as an ApiError (RFC 9457 problem+json mapped to a class). Aborted
 * requests are NOT converted: they keep rejecting with the platform `AbortError` DOMException so
 * TanStack Query and callers can treat cancellation as cancellation.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly title: string;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  /** Seconds to wait before retrying (from the problem document or the Retry-After header). */
  readonly retryAfter: number | undefined;
  readonly fieldErrors: FieldError[];

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.fieldErrors = init.fieldErrors ?? [];
  }

  /** Transient failures worth an automatic retry by the query layer. */
  get isTransient(): boolean {
    return (
      this.code === 'network_error' ||
      this.code === 'stream_interrupted' ||
      this.code === 'model_unavailable' ||
      this.status === 502 ||
      this.status === 504
    );
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 && this.code === 'unauthenticated';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into whole seconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

const STATUS_FALLBACK: Record<number, ClientErrorCode> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'upload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
};

function fallbackCode(status: number): ClientErrorCode {
  return STATUS_FALLBACK[status] ?? (status >= 500 ? 'internal' : 'bad_request');
}

/**
 * Convert a non-2xx response into an ApiError. Reads the body once. Non-JSON bodies (e.g. a CDN error
 * page) map to a code derived from the status; their content is never surfaced to the UI or logs.
 */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get('x-request-id') ?? undefined;
  const headerRetryAfter = parseRetryAfter(response.headers.get('retry-after'));
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('json')) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = ProblemDetails.safeParse(body);
    if (parsed.success) {
      const problem = parsed.data;
      return new ApiError({
        status: response.status,
        code: problem.code,
        title: problem.title,
        detail: problem.detail,
        requestId: problem.requestId || headerRequestId,
        retryAfter: problem.retryAfterSeconds ?? headerRetryAfter,
        fieldErrors: problem.errors,
      });
    }
    // JSON but not a recognised problem document: keep a known code if one is present.
    const loose = body as { code?: unknown; title?: unknown } | undefined;
    const code = ErrorCode.safeParse(loose?.code);
    return new ApiError({
      status: response.status,
      code: code.success ? code.data : fallbackCode(response.status),
      title: typeof loose?.title === 'string' ? loose.title : response.statusText || 'Request failed',
      requestId: headerRequestId,
      retryAfter: headerRetryAfter,
    });
  }

  return new ApiError({
    status: response.status,
    code: fallbackCode(response.status),
    title: response.statusText || 'Request failed',
    requestId: headerRequestId,
    retryAfter: headerRetryAfter,
  });
}

function minutes(seconds: number | undefined): string {
  if (!seconds || seconds <= 60) return 'a minute';
  const m = Math.ceil(seconds / 60);
  return `${m} minutes`;
}

/** Plain-language message for an error, suitable for toasts, alerts and error states. */
export function errorMessage(error: unknown): string {
  if (isAbortError(error)) return 'The request was cancelled.';
  if (!isApiError(error)) return 'Something went wrong. Please try again.';
  switch (error.code) {
    case 'network_error':
      return 'Can’t reach Foundry Ascent. Check your connection and try again.';
    case 'unauthenticated':
      return 'Your session has ended. Sign in again to continue.';
    case 'invalid_access_code':
      return 'That access code isn’t valid. Check it for typos or ask your program lead for a new one.';
    case 'locked_out':
      return `Too many sign-in attempts from this network. Try again in ${minutes(error.retryAfter)}.`;
    case 'rate_limited':
      return `You’re going a little fast. Try again in ${minutes(error.retryAfter)}.`;
    case 'forbidden':
      return 'You don’t have access to this. Ask a program lead if you think you should.';
    case 'not_found':
      return 'We couldn’t find that. It may have been removed, or you may not have access.';
    case 'validation_failed':
      return error.detail ?? 'Some fields need attention.';
    case 'conflict':
    case 'idempotency_conflict':
      return 'This changed since you loaded it. Refresh and try again.';
    case 'persona_suspended':
      return 'The coach for this venture is paused by a human reviewer. You can still read past sessions.';
    case 'assignment_inactive':
      return 'This venture doesn’t have an active coaching assignment. Contact your program lead.';
    case 'ai_disabled':
      return 'AI coaching is temporarily turned off by an administrator. Your workspace is still available.';
    case 'spend_cap_reached':
      return 'Today’s AI usage limit has been reached. Coaching resumes tomorrow.';
    case 'session_ended':
      return 'This session has ended. Start a new session to continue.';
    case 'session_turn_limit':
      return 'This session reached its turn limit. End it to save a recap, then start a new one.';
    case 'database_resuming':
      return 'Your workspace is still waking up. Try again in a few seconds.';
    case 'model_unavailable':
      return 'The coach is temporarily unavailable. Try again shortly.';
    case 'upload_too_large':
      return 'That file is too large. The limit is 10 MB.';
    case 'unsupported_media_type':
      return 'That file type isn’t supported. Upload a PDF, DOCX, TXT or Markdown file.';
    case 'stream_interrupted':
      return 'The response was interrupted. Try sending again.';
    case 'invalid_response':
    case 'contract_mismatch':
      return 'We received an unexpected response. Please try again.';
    case 'bad_request':
      return error.detail ?? 'The request couldn’t be processed.';
    case 'internal':
      return 'Something went wrong on our side. Please try again.';
  }
}
