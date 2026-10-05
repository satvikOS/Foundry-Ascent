import {
  API_PREFIX,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  IDEMPOTENCY_HEADER,
  REQUEST_ID_HEADER,
} from '@foundry/contracts';
import type { z } from 'zod';

import { ApiError, errorFromResponse, isAbortError } from './errors';
import { resumingStore, type ResumeLease } from './resuming';
import { sha256Hex } from './sha256';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

export const CONTENT_SHA256_HEADER = 'x-amz-content-sha256';

/** Longest we keep retrying `503 database_resuming` before surfacing the error (Aurora resumes in ~15 s). */
export const RESUME_MAX_WAIT_MS = 45_000;
const RESUME_BASE_DELAY_MS = 1_000;
const RESUME_MAX_DELAY_MS = 8_000;

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** JSON-serialisable request body. `undefined` sends no body (the SHA-256 header is then the empty hash). */
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal | undefined;
  /** Sent as `Idempotency-Key`; reuse the same key when retrying the same user intent. */
  idempotencyKey?: string | undefined;
  headers?: Record<string, string>;
  /** Transparently wait while the database resumes (default true). */
  waitForResume?: boolean;
  accept?: string;
}

/** Encode path parameters: path`/ventures/${id}/memory`. */
export function path(strings: TemplateStringsArray, ...params: (string | number)[]): string {
  return strings.reduce((out, segment, i) => {
    const param = i < params.length ? encodeURIComponent(String(params[i])) : '';
    return out + segment + param;
  }, '');
}

export function buildUrl(pathname: string, query?: QueryParams): string {
  const url = `${API_PREFIX}${pathname}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values: readonly QueryValue[] = Array.isArray(raw)
      ? (raw as readonly QueryValue[])
      : [raw as QueryValue];
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** A fresh Idempotency-Key for one user intent (keep it for retries of that intent). */
export function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export interface PreparedRequest {
  url: string;
  init: RequestInit;
  requestId: string;
}

/**
 * Build the fetch request. Non-GET requests carry the CSRF header and `x-amz-content-sha256` computed
 * over the exact bytes that are sent (the body is encoded once and those bytes are both hashed and sent).
 */
export async function prepareRequest(
  pathname: string,
  options: ApiRequestOptions = {},
): Promise<PreparedRequest> {
  const method = options.method ?? 'GET';
  const requestId = createRequestId();
  const headers = new Headers(options.headers);
  headers.set('accept', options.accept ?? 'application/json, application/problem+json');
  headers.set(REQUEST_ID_HEADER, requestId);

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== 'GET') {
    if (options.body !== undefined) {
      body = new TextEncoder().encode(JSON.stringify(options.body));
      headers.set('content-type', 'application/json');
    }
    headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    headers.set(CONTENT_SHA256_HEADER, await sha256Hex(body ?? new Uint8Array(0)));
    if (options.idempotencyKey) headers.set(IDEMPOTENCY_HEADER, options.idempotencyKey);
  }

  return {
    url: buildUrl(pathname, options.query),
    requestId,
    init: {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal ?? null,
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signals: (AbortSignal | undefined)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const active = signals.filter((s): s is AbortSignal => s !== undefined);
    const aborted = active.find((s) => s.aborted);
    if (aborted) {
      reject(abortReason(aborted));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      for (const s of active) s.removeEventListener('abort', onAbort);
    };
    const onAbort = (event: Event) => {
      cleanup();
      reject(abortReason(event.target as AbortSignal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    for (const s of active) s.addEventListener('abort', onAbort, { once: true });
  });
}

export function resumeDelay(
  attempt: number,
  retryAfterSeconds: number | undefined,
  random = Math.random,
): number {
  const exponential = Math.min(RESUME_BASE_DELAY_MS * 2 ** attempt, RESUME_MAX_DELAY_MS);
  const hinted = retryAfterSeconds === undefined ? 0 : Math.min(retryAfterSeconds * 1000, 10_000);
  const base = Math.max(exponential, hinted);
  const jitter = 0.8 + random() * 0.4; // ±20 %
  return Math.round(base * jitter);
}

async function fetchOnce(pathname: string, options: ApiRequestOptions): Promise<Response> {
  const prepared = await prepareRequest(pathname, options);
  let response: Response;
  try {
    response = await fetch(prepared.url, prepared.init);
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    throw new ApiError({
      status: 0,
      code: 'network_error',
      title: 'Network error',
      requestId: prepared.requestId,
      cause: error,
    });
  }
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (error.requestId) throw error;
    throw new ApiError({
      status: error.status,
      code: error.code,
      title: error.title,
      detail: error.detail,
      requestId: prepared.requestId,
      retryAfter: error.retryAfter,
      fieldErrors: error.fieldErrors,
    });
  }
  return response;
}

/**
 * Send a request and return the successful Response. Non-2xx responses throw ApiError.
 * `503 database_resuming` is retried with exponential backoff (≈1, 2, 4, 8, 8… s, honouring
 * Retry-After) for up to RESUME_MAX_WAIT_MS while the shared waking banner is shown.
 */
export async function sendRequest(pathname: string, options: ApiRequestOptions = {}): Promise<Response> {
  const waitForResume = options.waitForResume ?? true;
  const deadline = Date.now() + RESUME_MAX_WAIT_MS;
  let lease: ResumeLease | null = null;
  let resumed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchOnce(pathname, options);
        resumed = true;
        return response;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'database_resuming' || !waitForResume) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        lease ??= resumingStore.begin();
        try {
          await sleep(Math.min(resumeDelay(attempt, error.retryAfter), remaining), [
            options.signal,
            lease.signal,
          ]);
        } catch (sleepError) {
          // The caller aborted: propagate the abort. The person pressed Cancel: surface the 503.
          if (options.signal?.aborted) throw sleepError;
          throw error;
        }
      }
    }
  } finally {
    lease?.end(resumed);
  }
}

const DEV = import.meta.env.DEV;

/** Minimal, content-free summary of contract violations (paths and codes only — never values). */
function describeIssues(issues: readonly z.core.$ZodIssue[]): { path: string; code: string }[] {
  return issues
    .slice(0, 10)
    .map((issue) => ({ path: issue.path.map(String).join('.') || '(root)', code: issue.code }));
}

export function validateResponse<S extends z.ZodType>(
  schema: S,
  data: unknown,
  context: { method: string; path: string },
): z.output<S> {
  if (!DEV) return data as z.output<S>;
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = describeIssues(result.error.issues);
  console.error(`[api] ${context.method} ${context.path} response does not match the contract`, issues);
  throw new ApiError({
    status: 200,
    code: 'contract_mismatch',
    title: 'Response did not match the API contract',
    detail: `${context.method} ${context.path}: ${issues.map((i) => `${i.path} (${i.code})`).join(', ')}`,
  });
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ApiError({
      status: response.status,
      code: 'invalid_response',
      title: 'Invalid JSON response',
      requestId: response.headers.get(REQUEST_ID_HEADER) ?? undefined,
      cause,
    });
  }
}

/**
 * Typed JSON request. The response is validated against `schema` in development (contract drift fails
 * loudly with `contract_mismatch`) and trusted in production builds.
 */
export async function apiRequest<S extends z.ZodType>(
  pathname: string,
  options: ApiRequestOptions & { schema: S },
): Promise<z.output<S>> {
  const response = await sendRequest(pathname, options);
  const data = await readJson(response);
  return validateResponse(options.schema, data, { method: options.method ?? 'GET', path: pathname });
}

/**
 * Typed JSON request for endpoints that answer some requests with `204 No Content` (e.g.
 * `PATCH /memory/:id` with `delete`): an empty response resolves to `null`; any body is validated like
 * `apiRequest`.
 */
export async function apiRequestOrEmpty<S extends z.ZodType>(
  pathname: string,
  options: ApiRequestOptions & { schema: S },
): Promise<z.output<S> | null> {
  const response = await sendRequest(pathname, options);
  const data = await readJson(response);
  if (data === undefined) return null;
  return validateResponse(options.schema, data, { method: options.method ?? 'GET', path: pathname });
}

/** Request whose response body is ignored (204 or an acknowledgement). */
export async function apiSend(pathname: string, options: ApiRequestOptions = {}): Promise<void> {
  const response = await sendRequest(pathname, options);
  // Drain the body so the connection can be reused; content is not needed.
  await response.text().catch(() => undefined);
}

export const api = {
  get: <S extends z.ZodType>(
    pathname: string,
    schema: S,
    options: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ) => apiRequest(pathname, { ...options, method: 'GET', schema }),
  post: <S extends z.ZodType>(
    pathname: string,
    schema: S,
    body?: unknown,
    options: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ) => apiRequest(pathname, { ...options, method: 'POST', body, schema }),
  patch: <S extends z.ZodType>(
    pathname: string,
    schema: S,
    body?: unknown,
    options: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ) => apiRequest(pathname, { ...options, method: 'PATCH', body, schema }),
  delete: (pathname: string, options: Omit<ApiRequestOptions, 'method'> = {}) =>
    apiSend(pathname, { ...options, method: 'DELETE' }),
};
