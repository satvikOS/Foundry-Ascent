import { isUuid } from '@foundry/db';
import { SignJWT, jwtVerify } from 'jose';

/** Claims of the `fa_session` cookie JWT (HS256). */
export interface SessionClaims {
  /** Principal id. */
  readonly sub: string;
  /** auth_sessions.id (revocation handle). */
  readonly sid: string;
  /** Tenant id. */
  readonly tid: string;
  /** Issued at (seconds since epoch). */
  readonly iat: number;
  /** Expiry (seconds since epoch). */
  readonly exp: number;
}

export interface SessionSigningKey {
  /** platform_keys.id, sent as the JWT `kid` header. */
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** Tokens longer than this are rejected before any cryptography. */
export const MAX_TOKEN_LENGTH = 4_096;
const ALGORITHM = 'HS256';
const CLOCK_TOLERANCE_SECONDS = 5;

/** Signs a session token valid for `ttlSeconds` from `now`. */
export async function signSessionToken(
  key: SessionSigningKey,
  claims: { readonly sub: string; readonly sid: string; readonly tid: string },
  options: { readonly now: Date; readonly ttlSeconds: number },
): Promise<{ token: string; claims: SessionClaims }> {
  const iat = Math.floor(options.now.getTime() / 1000);
  const exp = iat + options.ttlSeconds;
  const token = await new SignJWT({ sid: claims.sid, tid: claims.tid })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT', kid: key.id })
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key.bytes);
  return { token, claims: { sub: claims.sub, sid: claims.sid, tid: claims.tid, iat, exp } };
}

function kidOf(token: string): string | null {
  const header = token.split('.')[0];
  if (header === undefined || header.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'kid' in parsed && typeof parsed.kid === 'string') {
      return parsed.kid;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Verifies signature (HS256 only), expiry and claim shapes. Tries the key named by `kid` first, then the
 * other verification keys (rotation grace). Returns null for any invalid token — callers report a
 * uniform `unauthenticated`.
 */
export async function verifySessionToken(
  token: string,
  keys: readonly SessionSigningKey[],
  options: { readonly now: Date },
): Promise<SessionClaims | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) return null;
  const kid = kidOf(token);
  const ordered = [...keys].sort((a, b) => Number(b.id === kid) - Number(a.id === kid));
  for (const key of ordered) {
    try {
      const { payload } = await jwtVerify(token, key.bytes, {
        algorithms: [ALGORITHM],
        currentDate: options.now,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'sid', 'tid', 'iat', 'exp'],
      });
      const { sub, sid, tid, iat, exp } = payload;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        typeof tid !== 'string' ||
        typeof iat !== 'number' ||
        typeof exp !== 'number' ||
        !isUuid(sub) ||
        !isUuid(sid) ||
        !isUuid(tid)
      ) {
        return null;
      }
      return { sub: sub.toLowerCase(), sid: sid.toLowerCase(), tid: tid.toLowerCase(), iat, exp };
    } catch {
      // Wrong key, bad signature, expired or malformed: try the next key, then fail closed.
    }
  }
  return null;
}
