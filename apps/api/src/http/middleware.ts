import { createHash, timingSafeEqual } from 'node:crypto';

import {
  API_PREFIX,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  REQUEST_ID_HEADER,
  SESSION_COOKIE,
} from '@foundry/contracts';
import { type AuthService, DomainError, isDomainError } from '@foundry/core';
import { type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { routePath } from 'hono/route';

import { errorFields, type Logger, principalHash } from '../logging.js';
import { classifyError, httpError, problemResponse } from './problem.js';
import { clearedSessionCookie, resolveRequestId } from './request-meta.js';
import { type AppContext, type AppEnv } from './types.js';

/** Path prefix of the development-only local upload target (presigned-URL semantics, no session). */
export const LOCAL_UPLOAD_PREFIX = `${API_PREFIX}/_local/uploads/`;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CONTENT_SHA256_HEADER = 'x-amz-content-sha256';
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

function isLocalUpload(c: AppContext): boolean {
  return c.req.path.startsWith(LOCAL_UPLOAD_PREFIX);
}

/** Response headers on every API response (CloudFront adds the site-wide policy on top). */
export function applySecurityHeaders(headers: Headers): void {
  headers.set('cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}

export interface RequestLogOptions {
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * Outermost middleware: request id (accepted or generated, echoed as `x-request-id`), security headers
 * and one structured access-log line per request with the route template, status, latency, a hash of the
 * principal id and the error code — never bodies, query strings or headers.
 */
export function requestContext({
  logger,
  now = () => performance.now(),
}: RequestLogOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = now();
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set('requestId', requestId);
    c.set('session', undefined);
    c.set('rawBody', undefined);
    c.set('errorCode', undefined);
    await next();
    const res = c.res;
    res.headers.set(REQUEST_ID_HEADER, requestId);
    applySecurityHeaders(res.headers);
    const session = c.get('session');
    const status = res.status;
    const fields = {
      requestId,
      method: c.req.method,
      route: routePath(c, -1),
      status,
      latencyMs: Math.round(now() - started),
      principal: session === undefined ? undefined : principalHash(session.principalId),
      code: c.get('errorCode'),
      streaming: res.headers.get('content-type')?.startsWith('text/event-stream') === true ? true : undefined,
    };
    if (status >= 500) logger.error('http.request', fields);
    else if (status >= 400) logger.warn('http.request', fields);
    else logger.info('http.request', fields);
  };
}

/** Error boundary: DomainError → problem+json; unknown errors → 500 `internal` (logged by name/stack). */
export function errorHandler(logger: Logger): (err: Error, c: AppContext) => Response {
  return (err, c) => {
    const { error, unexpected } = classifyError(err);
    if (unexpected || error.code === 'internal') {
      logger.error('http.unhandled_error', {
        requestId: c.get('requestId'),
        route: routePath(c, -1),
        reason: error.reason,
        ...errorFields(isDomainError(err) && err.cause !== undefined ? err.cause : err),
      });
    }
    return problemResponse(c, error);
  };
}

/**
 * CSRF defence in depth (system design §4.1): every non-GET request must carry
 * `X-Requested-With: foundry-ascent` (a header cross-site forms cannot set) on top of SameSite=Strict.
 */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && !isLocalUpload(c)) {
      if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
        throw httpError.forbidden('Missing or invalid X-Requested-With header', 'csrf_header');
      }
    }
    await next();
  };
}

function sha256Matches(body: Uint8Array, declared: string): boolean {
  if (!HEX_SHA256.test(declared)) return false;
  const actual = createHash('sha256').update(body).digest();
  return timingSafeEqual(actual, Buffer.from(declared, 'hex'));
}

/**
 * Reads non-GET bodies once (bounded) into `rawBody`. When `x-amz-content-sha256` is present it must be
 * the hex SHA-256 of the body: behind CloudFront the OAC signature already depends on it (the edge
 * rejects requests without it), and locally a mismatch reveals a client bug. It is not required locally.
 */
export function bodyReader(maxBytes: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || isLocalUpload(c)) {
      await next();
      return;
    }
    const declaredLength = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw httpError.tooLarge(`Request bodies are limited to ${String(maxBytes)} bytes`);
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw httpError.tooLarge(`Request bodies are limited to ${String(maxBytes)} bytes`);
    }
    const declared = c.req.header(CONTENT_SHA256_HEADER);
    if (declared !== undefined && !sha256Matches(body, declared.trim())) {
      throw httpError.badRequest(
        'x-amz-content-sha256 does not match the request body',
        'content_sha256_mismatch',
      );
    }
    c.set('rawBody', body);
    await next();
  };
}

/**
 * Resolves the `fa_session` cookie into a verified SessionContext (core.auth.verifySession: signature,
 * expiry, revocation with a 60 s cache). Rejected sessions also clear the cookie.
 */
export function requireSession(auth: Pick<AuthService, 'verifySession'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token === undefined || token === '') {
      throw new DomainError('unauthenticated', 'Please sign in.', { reason: 'no_session_cookie' });
    }
    try {
      c.set('session', await auth.verifySession(token, { requestId: c.get('requestId') }));
    } catch (err) {
      if (isDomainError(err) && err.code === 'unauthenticated') {
        c.header('set-cookie', clearedSessionCookie(), { append: true });
      }
      throw err;
    }
    await next();
  };
}
