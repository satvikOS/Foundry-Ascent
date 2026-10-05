/**
 * Credentials, sessions, brute-force counters and platform keys. These tables grant nothing to
 * `app_rls`; every function requires the owner-role {@link SystemExecutor} (`db.system`).
 */
import { camelRow, col, type CamelRow } from '../columns.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryNumber, queryOne, queryRows } from './common.js';

// ------------------------------------------------------------------------------------------------
// Access codes
// ------------------------------------------------------------------------------------------------

const lookupShape = {
  id: col.uuid,
  principal_id: col.uuid,
  tenant_id: col.uuid,
  code_hash: col.text,
  expires_at: col.ts.nullable,
  revoked_at: col.ts.nullable,
  principal_status: col.enum(['active', 'disabled'] as const),
  tenant_status: col.enum(['active', 'suspended', 'archived'] as const),
};
const lookupCodec = camelRow(lookupShape);
/** Everything sign-in needs to verify a code (the caller compares the hash in constant time). */
export type AccessCodeLookup = CamelRow<typeof lookupShape>;

/** Looks an access code up by its public prefix (first group). Includes revoked/expired codes. */
export function findAccessCodeByPrefix(sx: SystemExecutor, prefix: string): Promise<AccessCodeLookup | null> {
  return queryFirst(
    sx,
    `SELECT c.id, c.principal_id, pr.tenant_id, c.code_hash, c.expires_at, c.revoked_at,
            pr.status AS principal_status, t.status AS tenant_status
     FROM access_codes c
     JOIN principals pr ON pr.id = c.principal_id
     JOIN tenants t ON t.id = pr.tenant_id
     WHERE c.code_prefix = :prefix`,
    { prefix: p.text(prefix) },
    (r) => lookupCodec.decode(r),
  );
}

/** True when the prefix is already taken (issuers retry with a new random code). */
export async function accessCodePrefixExists(sx: SystemExecutor, prefix: string): Promise<boolean> {
  return (
    (await queryNumber(sx, 'SELECT count(*) AS n FROM access_codes WHERE code_prefix = :prefix', {
      prefix: p.text(prefix),
    })) > 0
  );
}

export interface CreateAccessCodeInput {
  readonly id?: string;
  readonly principalId: string;
  readonly prefix: string;
  /** `scrypt$N=…$salt$key` — never the plaintext code. */
  readonly hash: string;
  readonly label?: string;
  readonly createdBy?: string | null;
  readonly expiresAt?: string | Date | null;
}

const accessCodeShape = {
  id: col.uuid,
  principal_id: col.uuid,
  code_prefix: col.text,
  label: col.text,
  created_by: col.uuid.nullable,
  created_at: col.ts,
  expires_at: col.ts.nullable,
  revoked_at: col.ts.nullable,
  last_used_at: col.ts.nullable,
};
const accessCodeCodec = camelRow(accessCodeShape);
/** Access code metadata (never the hash). */
export type AccessCodeRecord = CamelRow<typeof accessCodeShape>;
const ACCESS_CODE_COLUMNS =
  'id, principal_id, code_prefix, label, created_by, created_at, expires_at, revoked_at, last_used_at';

export function createAccessCode(
  sx: SystemExecutor,
  input: CreateAccessCodeInput,
): Promise<AccessCodeRecord> {
  return queryOne(
    sx,
    `INSERT INTO access_codes (id, principal_id, code_prefix, code_hash, label, created_by, expires_at)
     VALUES (coalesce(:id, gen_random_uuid()), :principalId, :prefix, :hash, coalesce(:label, 'access code'), :createdBy, :expiresAt)
     RETURNING ${ACCESS_CODE_COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      principalId: p.uuid(input.principalId),
      prefix: p.text(input.prefix),
      hash: p.text(input.hash),
      label: p.nullable.text(input.label),
      createdBy: p.nullable.uuid(input.createdBy),
      expiresAt: p.nullable.ts(input.expiresAt),
    },
    (r) => accessCodeCodec.decode(r),
    'createAccessCode',
  );
}

export async function markAccessCodeUsed(sx: SystemExecutor, id: string): Promise<void> {
  await sx.query('UPDATE access_codes SET last_used_at = now() WHERE id = :id', { id: p.uuid(id) });
}

/** Revokes a code and every auth session created with it. Returns the code (null when unknown). */
export async function revokeAccessCode(sx: SystemExecutor, id: string): Promise<AccessCodeRecord | null> {
  const code = await queryFirst(
    sx,
    `UPDATE access_codes SET revoked_at = coalesce(revoked_at, now()) WHERE id = :id RETURNING ${ACCESS_CODE_COLUMNS}`,
    { id: p.uuid(id) },
    (r) => accessCodeCodec.decode(r),
  );
  if (code) {
    await sx.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE access_code_id = :id AND revoked_at IS NULL',
      {
        id: p.uuid(id),
      },
    );
  }
  return code;
}

export function getAccessCode(sx: SystemExecutor, id: string): Promise<AccessCodeRecord | null> {
  return queryFirst(
    sx,
    `SELECT ${ACCESS_CODE_COLUMNS} FROM access_codes WHERE id = :id`,
    { id: p.uuid(id) },
    (r) => accessCodeCodec.decode(r),
  );
}

/** Whether the principal has ever held an access code (issuing another one is a re-issue). */
export async function principalHasAccessCode(sx: SystemExecutor, principalId: string): Promise<boolean> {
  return (
    (await queryNumber(sx, 'SELECT count(*) AS n FROM access_codes WHERE principal_id = :principalId', {
      principalId: p.uuid(principalId),
    })) > 0
  );
}

/**
 * When codes were re-issued for the principal by someone else (an earlier code existed and `created_by` is
 * another principal) after the principal's previous sign-in, i.e. the latest auth session created before
 * `currentSessionId`. Newest first, at most 5. Feeds the "a new access code was issued" notice.
 */
export function reissuedCodesSincePreviousSignIn(
  sx: SystemExecutor,
  args: { principalId: string; currentSessionId: string },
): Promise<string[]> {
  return queryRows(
    sx,
    `WITH previous AS (
       SELECT max(s.created_at) AS at FROM auth_sessions s
       WHERE s.principal_id = :principalId AND s.id <> :sessionId
         AND s.created_at <= (SELECT cs.created_at FROM auth_sessions cs WHERE cs.id = :sessionId))
     SELECT c.created_at FROM access_codes c, previous
     WHERE c.principal_id = :principalId
       AND c.created_by IS NOT NULL AND c.created_by <> :principalId
       AND (previous.at IS NULL OR c.created_at > previous.at)
       AND EXISTS (SELECT 1 FROM access_codes e WHERE e.principal_id = c.principal_id AND e.created_at < c.created_at)
     ORDER BY c.created_at DESC
     LIMIT 5`,
    { principalId: p.uuid(args.principalId), sessionId: p.uuid(args.currentSessionId) },
    (r) => col.ts.decode(r.created_at, 'created_at'),
  );
}

/** Active (not revoked, not expired) codes of the given principals, newest first. */
export function listActiveAccessCodes(
  sx: SystemExecutor,
  principalIds: readonly string[],
): Promise<AccessCodeRecord[]> {
  return queryRows(
    sx,
    `SELECT ${ACCESS_CODE_COLUMNS} FROM access_codes
     WHERE principal_id = ANY (:ids) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC, id`,
    { ids: p.uuidArray(principalIds) },
    (r) => accessCodeCodec.decode(r),
  );
}

// ------------------------------------------------------------------------------------------------
// Auth sessions
// ------------------------------------------------------------------------------------------------

const authSessionShape = {
  id: col.uuid,
  principal_id: col.uuid,
  tenant_id: col.uuid,
  access_code_id: col.uuid.nullable,
  created_at: col.ts,
  expires_at: col.ts,
  revoked_at: col.ts.nullable,
  principal_status: col.enum(['active', 'disabled'] as const),
  tenant_status: col.enum(['active', 'suspended', 'archived'] as const),
  access_code_revoked_at: col.ts.nullable,
};
const authSessionCodec = camelRow(authSessionShape);
export type AuthSessionRecord = CamelRow<typeof authSessionShape>;

export interface CreateAuthSessionInput {
  readonly id?: string;
  readonly principalId: string;
  readonly accessCodeId?: string | null;
  readonly expiresAt: string | Date;
  readonly userAgentHash?: string | null;
}

export async function createAuthSession(
  sx: SystemExecutor,
  input: CreateAuthSessionInput,
): Promise<AuthSessionRecord> {
  const id = await queryOne(
    sx,
    `INSERT INTO auth_sessions (id, principal_id, access_code_id, expires_at, user_agent_hash)
     VALUES (coalesce(:id, gen_random_uuid()), :principalId, :accessCodeId, :expiresAt, :uaHash)
     RETURNING id`,
    {
      id: p.nullable.uuid(input.id),
      principalId: p.uuid(input.principalId),
      accessCodeId: p.nullable.uuid(input.accessCodeId),
      expiresAt: p.ts(input.expiresAt),
      uaHash: p.nullable.text(input.userAgentHash),
    },
    (r) => col.uuid.decode(r.id, 'id'),
    'createAuthSession',
  );
  const session = await getAuthSession(sx, id);
  if (!session) throw new Error('auth session vanished after insert');
  return session;
}

/**
 * The session with its principal's and tenant's status and the issuing code's revocation (for the 60 s
 * revocation cache: a disabled principal, a suspended tenant or a revoked code ends the session).
 */
export function getAuthSession(sx: SystemExecutor, id: string): Promise<AuthSessionRecord | null> {
  return queryFirst(
    sx,
    `SELECT s.id, s.principal_id, pr.tenant_id, s.access_code_id, s.created_at, s.expires_at, s.revoked_at,
            pr.status AS principal_status, t.status AS tenant_status, c.revoked_at AS access_code_revoked_at
     FROM auth_sessions s
     JOIN principals pr ON pr.id = s.principal_id
     JOIN tenants t ON t.id = pr.tenant_id
     LEFT JOIN access_codes c ON c.id = s.access_code_id
     WHERE s.id = :id`,
    { id: p.uuid(id) },
    (r) => authSessionCodec.decode(r),
  );
}

export async function revokeAuthSession(sx: SystemExecutor, id: string): Promise<boolean> {
  const result = await sx.query(
    'UPDATE auth_sessions SET revoked_at = now() WHERE id = :id AND revoked_at IS NULL',
    {
      id: p.uuid(id),
    },
  );
  return result.rowCount > 0;
}

export async function revokeAuthSessionsForPrincipal(
  sx: SystemExecutor,
  principalId: string,
): Promise<number> {
  const result = await sx.query(
    'UPDATE auth_sessions SET revoked_at = now() WHERE principal_id = :principalId AND revoked_at IS NULL',
    { principalId: p.uuid(principalId) },
  );
  return result.rowCount;
}

// ------------------------------------------------------------------------------------------------
// Brute-force counters
// ------------------------------------------------------------------------------------------------

/** Records one attempt and returns its id. `subjectHash` is a salted hash of the viewer IP, or 'global'. */
export async function recordAuthAttempt(
  sx: SystemExecutor,
  args: { subjectHash: string; succeeded: boolean },
): Promise<number> {
  return queryOne(
    sx,
    'INSERT INTO auth_attempts (subject_hash, succeeded) VALUES (:subject, :ok) RETURNING id',
    { subject: p.text(args.subjectHash), ok: p.bool(args.succeeded) },
    (r) => col.int.decode(r.id, 'id'),
    'recordAuthAttempt',
  );
}

/** Advisory-lock namespace for per-subject sign-in reservations (two-key form: never clashes with 7012025/6). */
export const AUTH_ATTEMPT_LOCK_NAMESPACE = 7_012_027;

export interface AttemptReservation {
  /** The attempt, recorded as failed until marked succeeded; null when the subject is locked out. */
  readonly attemptId: number | null;
  /** Failures of the subject inside the window *before* this attempt. */
  readonly failures: number;
  /** Most recent of those failures (null when none). */
  readonly lastFailureAt: string | null;
}

/**
 * Admits one sign-in attempt for a subject, or reports that it is locked out. Under a per-subject
 * advisory lock it counts the failures inside the window and, below `failureLimit`, records this attempt
 * as **failed** before any credential work (flip it with {@link markAuthAttemptSucceeded} on success, or
 * drop it with {@link deleteAuthAttempt}). Concurrent attempts of one subject therefore serialise here
 * and at most `failureLimit` of them per window ever reach verification.
 *
 * Must run inside a transaction (`db.system(fn)` with the default `transaction: true`): the lock is held
 * until commit, which comes right after the insert.
 */
export async function reserveAuthAttempt(
  sx: SystemExecutor,
  args: { subjectHash: string; windowSeconds: number; failureLimit: number },
): Promise<AttemptReservation> {
  // Wrapped so the result column is an integer, not `void` (which the Data API need not serialise).
  await sx.query(
    'SELECT count(*) AS n FROM (SELECT pg_advisory_xact_lock(:namespace, hashtext(:subject))) AS l',
    {
      namespace: p.int(AUTH_ATTEMPT_LOCK_NAMESPACE),
      subject: p.text(args.subjectHash),
    },
  );
  const window = await authFailureWindow(sx, args);
  if (window.failures >= args.failureLimit) return { attemptId: null, ...window };
  const attemptId = await recordAuthAttempt(sx, { subjectHash: args.subjectHash, succeeded: false });
  return { attemptId, ...window };
}

/** Marks a recorded attempt as successful (it no longer counts towards the lockout). */
export async function markAuthAttemptSucceeded(sx: SystemExecutor, attemptId: number): Promise<boolean> {
  const result = await sx.query('UPDATE auth_attempts SET succeeded = true WHERE id = :id', {
    id: p.bigint(attemptId),
  });
  return result.rowCount > 0;
}

/** Removes a recorded attempt (one refused by the lockout itself, so hammering does not extend it). */
export async function deleteAuthAttempt(sx: SystemExecutor, attemptId: number): Promise<boolean> {
  const result = await sx.query('DELETE FROM auth_attempts WHERE id = :id', { id: p.bigint(attemptId) });
  return result.rowCount > 0;
}

export interface AuthFailureWindow {
  /** Failures inside the window. */
  readonly failures: number;
  /** Most recent failure inside the window (null when none). */
  readonly lastFailureAt: string | null;
}

/** Failed attempts for a subject within the last `windowSeconds`. */
export async function authFailureWindow(
  sx: SystemExecutor,
  args: { subjectHash: string; windowSeconds: number },
): Promise<AuthFailureWindow> {
  const row = await queryFirst(
    sx,
    `SELECT count(*) AS failures, max(attempted_at) AS last_failure_at
     FROM auth_attempts
     WHERE subject_hash = :subject AND NOT succeeded
       AND attempted_at > now() - make_interval(secs => :window)`,
    { subject: p.text(args.subjectHash), window: p.num(args.windowSeconds) },
    (r) => ({
      failures: col.int.decode(r.failures, 'failures'),
      lastFailureAt: col.ts.nullable.decode(r.last_failure_at, 'last_failure_at'),
    }),
  );
  return row ?? { failures: 0, lastFailureAt: null };
}

/** Deletes attempts older than `olderThanSeconds`. */
export async function pruneAuthAttempts(sx: SystemExecutor, olderThanSeconds: number): Promise<number> {
  const result = await sx.query(
    'DELETE FROM auth_attempts WHERE attempted_at < now() - make_interval(secs => :age)',
    {
      age: p.num(olderThanSeconds),
    },
  );
  return result.rowCount;
}

// ------------------------------------------------------------------------------------------------
// Platform keys
// ------------------------------------------------------------------------------------------------

export type PlatformKeyPurpose = 'session_signing' | 'ip_hash_salt';

const keyShape = {
  id: col.uuid,
  purpose: col.enum(['session_signing', 'ip_hash_salt'] as const),
  key_base64: col.text,
  created_at: col.ts,
  retired_at: col.ts.nullable,
};
const keyCodec = camelRow(keyShape);
/** Key material is returned base64-encoded (portable across drivers); decode with Buffer.from(…, 'base64'). */
export type PlatformKeyRecord = CamelRow<typeof keyShape>;
const KEY_COLUMNS = "id, purpose, encode(key_bytes, 'base64') AS key_base64, created_at, retired_at";

/** The active key for a purpose (created by migration 0001). */
export function getActivePlatformKey(
  sx: SystemExecutor,
  purpose: PlatformKeyPurpose,
): Promise<PlatformKeyRecord | null> {
  return queryFirst(
    sx,
    `SELECT ${KEY_COLUMNS} FROM platform_keys WHERE purpose = :purpose AND retired_at IS NULL`,
    { purpose: p.text(purpose) },
    (r) => keyCodec.decode(r),
  );
}

/**
 * Keys usable for verification: the active key plus keys retired within `graceSeconds` (so tokens
 * signed just before a rotation stay valid until they expire). Newest first.
 */
export function listVerificationKeys(
  sx: SystemExecutor,
  args: { purpose: PlatformKeyPurpose; graceSeconds: number },
): Promise<PlatformKeyRecord[]> {
  return queryRows(
    sx,
    `SELECT ${KEY_COLUMNS} FROM platform_keys
     WHERE purpose = :purpose AND (retired_at IS NULL OR retired_at > now() - make_interval(secs => :grace))
     ORDER BY created_at DESC`,
    { purpose: p.text(args.purpose), grace: p.num(args.graceSeconds) },
    (r) => keyCodec.decode(r),
  );
}

/** Retires the active key and creates a new random 32-byte key. Returns the new key. */
export async function rotatePlatformKey(
  sx: SystemExecutor,
  purpose: PlatformKeyPurpose,
): Promise<PlatformKeyRecord> {
  await sx.query(
    'UPDATE platform_keys SET retired_at = now() WHERE purpose = :purpose AND retired_at IS NULL',
    {
      purpose: p.text(purpose),
    },
  );
  return queryOne(
    sx,
    `INSERT INTO platform_keys (purpose, key_bytes) VALUES (:purpose, gen_random_bytes(32)) RETURNING ${KEY_COLUMNS}`,
    { purpose: p.text(purpose) },
    (r) => keyCodec.decode(r),
    'rotatePlatformKey',
  );
}
