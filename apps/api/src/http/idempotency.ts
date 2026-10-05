import { createHash } from 'node:crypto';

import { API_PREFIX, IDEMPOTENCY_HEADER } from '@foundry/contracts';
import { DomainError } from '@foundry/core';
import { type Db, idempotencyRepo } from '@foundry/db';
import { type MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

import { errorFields, type Logger } from '../logging.js';
import { httpError } from './problem.js';
import { type AppContext, type AppEnv } from './types.js';

/**
 * `Idempotency-Key` support (system design §3: every write honours it, 24 h window).
 *
 * Keys are scoped by principal and route template. A request first **reserves** its key (an in-progress
 * row, `status_code = 0`), so two concurrent requests with the same key cannot both execute; the winner
 * stores its 2xx response, and later retries with the same key and the same request (method, path and
 * body hash) get the stored response replayed with `Idempotency-Replayed: true`. Non-2xx outcomes release
 * the reservation so a retry runs again. Reusing a key for a different request is `409
 * idempotency_conflict`. Reservations of crashed requests are taken over after
 * {@link STALE_RESERVATION_SECONDS}.
 *
 * Responses are stored in `idempotency_keys` (owner role only, pruned after 24 h). One-time secrets are
 * never stored (see `IdempotencyMode` `secret`).
 */

/** Longer than the API Lambda timeout (60 s), so a live request is never taken over. */
export const STALE_RESERVATION_SECONDS = idempotencyRepo.STALE_RESERVATION_SECONDS;
const KEY_RE = /^[\x21-\x7E]{8,200}$/;
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

export interface IdempotencyScope {
  readonly principalId: string;
  /** `METHOD /route/:template` (relative to /api/v1). */
  readonly route: string;
  readonly key: string;
}

export type Reservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'replay'; readonly statusCode: number; readonly body: unknown }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'mismatch' };

export interface IdempotencyStore {
  reserve(scope: IdempotencyScope, requestHash: string): Promise<Reservation>;
  /** Stores the final response of a reservation this request holds. */
  complete(scope: IdempotencyScope, requestHash: string, statusCode: number, body: unknown): Promise<void>;
  /** Drops a reservation this request holds (non-2xx outcome) so a retry executes again. */
  release(scope: IdempotencyScope, requestHash: string): Promise<void>;
}

/**
 * Store on `idempotency_keys` through the owner-role executor (the table is closed to app_rls; keys are
 * scoped by the verified session's principal). The reservation statements live in `idempotencyRepo`.
 */
export function createDbIdempotencyStore(
  db: Pick<Db, 'system'>,
  random: () => number = Math.random,
): IdempotencyStore {
  return {
    async reserve(scope, requestHash) {
      const outcome = await db.system(
        (sx) =>
          idempotencyRepo.reserveIdempotencyKey(sx, {
            ...scope,
            requestHash,
            staleSeconds: STALE_RESERVATION_SECONDS,
          }),
        { transaction: false },
      );
      return outcome.kind === 'replay'
        ? { kind: 'replay', statusCode: outcome.statusCode, body: outcome.response }
        : outcome;
    },

    async complete(scope, requestHash, statusCode, body) {
      await db.system(
        async (sx) => {
          await idempotencyRepo.completeIdempotencyKey(sx, {
            ...scope,
            requestHash,
            statusCode,
            response: body,
          });
          // Housekeeping: expired keys are never read again.
          if (random() < 0.01) await idempotencyRepo.pruneIdempotencyKeys(sx);
        },
        { transaction: false },
      );
    },

    async release(scope, requestHash) {
      await db.system((sx) => idempotencyRepo.releaseIdempotencyKey(sx, { ...scope, requestHash }), {
        transaction: false,
      });
    },
  };
}

/** Hash of the exact request (method, path with ids, body bytes) bound to a key. */
export function requestHash(method: string, path: string, body: Uint8Array | undefined): string {
  const hash = createHash('sha256').update(`${method.toUpperCase()}\n${path}\n`);
  if (body !== undefined) hash.update(body);
  return hash.digest('hex');
}

/** The route template of the matched handler, relative to /api/v1 (`POST /ventures/:id/memory`). */
export function routeKey(c: AppContext): string {
  const template = routePath(c, -1);
  const relative = template.startsWith(API_PREFIX) ? template.slice(API_PREFIX.length) : template;
  return `${c.req.method.toUpperCase()} ${relative === '' ? '/' : relative}`;
}

/** The validated `Idempotency-Key` header, or null when absent. */
export function idempotencyKeyOf(c: AppContext): string | null {
  const raw = c.req.header(IDEMPOTENCY_HEADER);
  if (raw === undefined) return null;
  const key = raw.trim();
  if (!KEY_RE.test(key)) {
    throw httpError.badRequest(
      'Idempotency-Key must be 8–200 visible ASCII characters',
      'idempotency_key_format',
    );
  }
  return key;
}

export const KEY_REUSED = (): DomainError =>
  new DomainError('idempotency_conflict', 'This Idempotency-Key was already used for a different request', {
    reason: 'idempotency_key_reused',
  });
export const IN_FLIGHT = (): DomainError =>
  new DomainError('conflict', 'A request with this Idempotency-Key is still being processed', {
    reason: 'idempotency_in_progress',
    retryAfterSeconds: 2,
  });
export const SECRET_ALREADY_ISSUED = (): DomainError =>
  new DomainError(
    'idempotency_conflict',
    'This request already completed. A one-time access code cannot be shown again; revoke it and issue a new one if it was lost.',
    { reason: 'secret_not_replayable' },
  );

const REDACTED = { redacted: true } as const;

async function responseJson(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return null;
  const text = await res.clone().text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function replayResponse(c: AppContext, statusCode: number, body: unknown): Response {
  c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  if (statusCode === 204 || body === null) return c.body(null, statusCode as 204);
  return c.json(body, statusCode as 200);
}

/**
 * Route middleware for `standard` and `secret` routes (after `requireSession`). Requests without the
 * header run normally.
 */
export function idempotency(
  store: IdempotencyStore,
  mode: 'standard' | 'secret',
  logger: Logger,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = idempotencyKeyOf(c);
    const session = c.get('session');
    if (key === null || session === undefined) {
      await next();
      return;
    }
    const scope: IdempotencyScope = { principalId: session.principalId, route: routeKey(c), key };
    const hash = requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody'));
    const reservation = await store.reserve(scope, hash);
    switch (reservation.kind) {
      case 'mismatch':
        throw KEY_REUSED();
      case 'in_progress':
        throw IN_FLIGHT();
      case 'replay':
        if (mode === 'secret') throw SECRET_ALREADY_ISSUED();
        return replayResponse(c, reservation.statusCode, reservation.body);
      case 'reserved':
        break;
    }
    try {
      await next();
    } catch (err) {
      await store.release(scope, hash).catch(() => undefined);
      throw err;
    }
    const res = c.res;
    try {
      if (res.status >= 200 && res.status < 300) {
        const body = mode === 'secret' ? REDACTED : await responseJson(res);
        await store.complete(scope, hash, res.status, body);
      } else {
        await store.release(scope, hash);
      }
    } catch (err) {
      // The write itself succeeded; failing the response now would invite a duplicate retry.
      logger.warn('idempotency.store_failed', {
        requestId: c.get('requestId'),
        route: scope.route,
        ...errorFields(err),
      });
    }
    return undefined;
  };
}
