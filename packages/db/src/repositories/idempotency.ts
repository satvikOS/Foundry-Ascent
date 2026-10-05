/**
 * Idempotency-Key storage (24 h window). No `app_rls` privileges: SystemExecutor only. Keys are scoped by
 * principal and route; `requestHash` detects reuse of a key with a different request body.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst } from './common.js';

export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;

export interface IdempotencyKey {
  readonly principalId: string;
  /** Route template, e.g. `POST /ventures/:id/memory`. */
  readonly route: string;
  readonly key: string;
}

export interface IdempotencyRecord {
  readonly requestHash: string | null;
  readonly statusCode: number;
  readonly response: unknown;
  readonly createdAt: string;
}

/** The stored response for a key within the window, or null. */
export function getIdempotencyRecord(
  sx: SystemExecutor,
  args: IdempotencyKey & { windowSeconds?: number },
): Promise<IdempotencyRecord | null> {
  return queryFirst(
    sx,
    `SELECT request_hash, status_code, response, created_at FROM idempotency_keys
     WHERE principal_id = :principalId AND route = :route AND key = :key
       AND created_at > now() - make_interval(secs => :window)`,
    {
      principalId: p.uuid(args.principalId),
      route: p.text(args.route),
      key: p.text(args.key),
      window: p.num(args.windowSeconds ?? IDEMPOTENCY_WINDOW_SECONDS),
    },
    (r) => ({
      requestHash: col.text.nullable.decode(r.request_hash, 'request_hash'),
      statusCode: col.int.decode(r.status_code, 'status_code'),
      response: col.json().decode(r.response, 'response'),
      createdAt: col.ts.decode(r.created_at, 'created_at'),
    }),
  );
}

/**
 * Stores a response. Returns false when a live record for the key already exists (a concurrent request
 * won); an expired record is replaced.
 */
export async function saveIdempotencyRecord(
  sx: SystemExecutor,
  args: IdempotencyKey & { requestHash: string; statusCode: number; response: unknown },
): Promise<boolean> {
  const result = await sx.query(
    `INSERT INTO idempotency_keys (key, principal_id, route, response, status_code, request_hash)
     VALUES (:key, :principalId, :route, :response, :statusCode, :requestHash)
     ON CONFLICT (principal_id, route, key) DO UPDATE
       SET response = EXCLUDED.response, status_code = EXCLUDED.status_code, request_hash = EXCLUDED.request_hash,
           created_at = now()
       WHERE idempotency_keys.created_at <= now() - make_interval(secs => :window)`,
    {
      key: p.text(args.key),
      principalId: p.uuid(args.principalId),
      route: p.text(args.route),
      response: p.json(args.response),
      statusCode: p.int(args.statusCode),
      requestHash: p.text(args.requestHash),
      window: p.num(IDEMPOTENCY_WINDOW_SECONDS),
    },
  );
  return result.rowCount > 0;
}

/**
 * `status_code` of a reservation: the request holding it is still running (no response stored yet).
 * Completed records always carry the HTTP status (2xx) of the stored response.
 */
export const IN_PROGRESS_STATUS = 0;

/** Longer than the API Lambda timeout (60 s), so a reservation of a live request is never taken over. */
export const STALE_RESERVATION_SECONDS = 120;

export type ReservationOutcome =
  /** The caller holds the key and must `complete` or `release` it. */
  | { readonly kind: 'reserved' }
  /** A completed request with the same hash: replay its stored response. */
  | { readonly kind: 'replay'; readonly statusCode: number; readonly response: unknown }
  /** Another request with the same hash still holds the key. */
  | { readonly kind: 'in_progress' }
  /** The key was used for a different request (hash mismatch). */
  | { readonly kind: 'mismatch' };

function scopeParams(args: IdempotencyKey & { requestHash: string }) {
  return {
    principalId: p.uuid(args.principalId),
    route: p.text(args.route),
    key: p.text(args.key),
    requestHash: p.text(args.requestHash),
  };
}

/**
 * Reserves a key before the request executes, so two concurrent requests with the same key cannot both
 * run: inserts an in-progress record (or replaces an expired one); otherwise reports the live record
 * (replay / in progress / mismatch). An in-progress reservation older than `staleSeconds` (its request
 * crashed or timed out) is taken over by a request with the same hash. Autocommit statements only.
 */
export async function reserveIdempotencyKey(
  sx: SystemExecutor,
  args: IdempotencyKey & { requestHash: string; staleSeconds?: number },
): Promise<ReservationOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const saved = await saveIdempotencyRecord(sx, {
      ...args,
      statusCode: IN_PROGRESS_STATUS,
      response: { state: 'in_progress' },
    });
    if (saved) return { kind: 'reserved' };
    const record = await getIdempotencyRecord(sx, args);
    if (record === null) continue; // expired between the two statements: insert again
    if (record.requestHash !== args.requestHash) return { kind: 'mismatch' };
    if (record.statusCode !== IN_PROGRESS_STATUS) {
      return { kind: 'replay', statusCode: record.statusCode, response: record.response };
    }
    const takeover = await sx.query(
      `UPDATE idempotency_keys SET created_at = now()
       WHERE principal_id = :principalId AND route = :route AND key = :key
         AND status_code = 0 AND request_hash = :requestHash
         AND created_at <= now() - make_interval(secs => :stale)`,
      { ...scopeParams(args), stale: p.num(args.staleSeconds ?? STALE_RESERVATION_SECONDS) },
    );
    return takeover.rowCount > 0 ? { kind: 'reserved' } : { kind: 'in_progress' };
  }
  return { kind: 'in_progress' };
}

/**
 * Stores the final (2xx) response of a reservation the caller holds. Returns false when the reservation
 * is gone (taken over or pruned), in which case nothing is written.
 */
export async function completeIdempotencyKey(
  sx: SystemExecutor,
  args: IdempotencyKey & { requestHash: string; statusCode: number; response: unknown },
): Promise<boolean> {
  if (!Number.isInteger(args.statusCode) || args.statusCode < 200 || args.statusCode > 299) {
    throw new SqlUsageError('completeIdempotencyKey stores 2xx responses only');
  }
  const result = await sx.query(
    `UPDATE idempotency_keys SET status_code = :statusCode, response = :response
     WHERE principal_id = :principalId AND route = :route AND key = :key
       AND status_code = 0 AND request_hash = :requestHash`,
    { ...scopeParams(args), statusCode: p.int(args.statusCode), response: p.json(args.response) },
  );
  return result.rowCount > 0;
}

/** Drops a reservation the caller holds (the request failed), so a retry with the key executes again. */
export async function releaseIdempotencyKey(
  sx: SystemExecutor,
  args: IdempotencyKey & { requestHash: string },
): Promise<boolean> {
  const result = await sx.query(
    `DELETE FROM idempotency_keys
     WHERE principal_id = :principalId AND route = :route AND key = :key
       AND status_code = 0 AND request_hash = :requestHash`,
    scopeParams(args),
  );
  return result.rowCount > 0;
}

/** Deletes records older than the window. */
export async function pruneIdempotencyKeys(
  sx: SystemExecutor,
  olderThanSeconds = IDEMPOTENCY_WINDOW_SECONDS,
): Promise<number> {
  const result = await sx.query(
    'DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(secs => :age)',
    {
      age: p.num(olderThanSeconds),
    },
  );
  return result.rowCount;
}
