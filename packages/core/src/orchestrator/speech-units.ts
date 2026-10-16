import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { type SessionSigningKey } from '../auth/session-token.js';

/**
 * Signed speech units (ADR-0010, docs/architecture/calls.md).
 *
 * A call speaks only text the validators approved. The turn engine streams each validated unit of the spoken
 * reply as a `turn.speech` event signed over `sessionId|turnId|seq|text`; `POST /speech` voices a unit only
 * when its signature verifies. The call intro (the notebook opener) is signed the same way with a null turn.
 *
 * The HMAC key is derived (HKDF-SHA256) from the platform session-signing key with its own label, so a speech
 * signature can never stand in for a session token and vice versa. Signatures carry the signing key's id so
 * verification keeps working through a key rotation (the grace window of the session keys).
 */

const HKDF_INFO = 'foundry-ascent/speech-unit/v1';
const SIG_VERSION = 'su1';

export interface SpeechUnitClaims {
  readonly sessionId: string;
  /** Null only for the call intro. */
  readonly turnId: string | null;
  readonly seq: number;
  readonly text: string;
}

function unitKey(key: SessionSigningKey): Buffer {
  return Buffer.from(hkdfSync('sha256', key.bytes, new Uint8Array(0), HKDF_INFO, 32));
}

function message(claims: SpeechUnitClaims): string {
  return [claims.sessionId, claims.turnId ?? 'intro', String(claims.seq), claims.text.normalize('NFC')].join(
    '|',
  );
}

function mac(key: SessionSigningKey, claims: SpeechUnitClaims): Buffer {
  return createHmac('sha256', unitKey(key)).update(message(claims), 'utf8').digest();
}

/** Signs one speech unit: `su1.<keyId>.<base64url hmac>`. */
export function signSpeechUnit(key: SessionSigningKey, claims: SpeechUnitClaims): string {
  return `${SIG_VERSION}.${key.id}.${mac(key, claims).toString('base64url')}`;
}

/**
 * Verifies a unit signature against the current verification keys (active key plus keys in their grace
 * window). Returns false for any malformed, unknown-key or mismatched signature; never throws.
 */
export function verifySpeechUnit(
  keys: readonly SessionSigningKey[],
  claims: SpeechUnitClaims,
  sig: string,
): boolean {
  if (sig.length > 200) return false;
  const parts = sig.split('.');
  if (parts.length !== 3 || parts[0] !== SIG_VERSION) return false;
  const [, keyId, encoded] = parts as [string, string, string];
  const key = keys.find((candidate) => candidate.id === keyId);
  if (key === undefined) return false;
  let given: Buffer;
  try {
    given = Buffer.from(encoded, 'base64url');
  } catch {
    return false;
  }
  const expected = mac(key, claims);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
