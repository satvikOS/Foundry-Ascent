import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { type SessionSigningKey } from '../auth/session-token.js';
import { type VerifiedSpeechUnit } from '../ports.js';

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
 *
 * A unit the turn engine admitted to the call's live FULL face as it signed it (face pre-approval,
 * docs/architecture/calls.md §4) carries `face: true`, and its signature covers that flag (`|face` after the
 * text): nobody without the key can mark a unit as admitted to the face, and the same words signed without the
 * flag do not verify with it. Requests that hand a unit back (`POST /speech`, `face/say`, the heard units) do
 * not say which form they hold, so with `face` left out either form verifies: a pre-approval grants nothing on
 * the server, whose record of what a face may say is the admitted units (`call_face_texts`).
 */

const HKDF_INFO = 'foundry-ascent/speech-unit/v1';
const SIG_VERSION = 'su1';

export interface SpeechUnitClaims {
  readonly sessionId: string;
  /** Null only for the call intro. */
  readonly turnId: string | null;
  readonly seq: number;
  readonly text: string;
  /**
   * Admitted to the call's FULL face as it was signed. Signing: covered by the signature when true. Verifying:
   * true or false accepts only that form; left out, either.
   */
  readonly face?: boolean;
}

function unitKey(key: SessionSigningKey): Buffer {
  return Buffer.from(hkdfSync('sha256', key.bytes, new Uint8Array(0), HKDF_INFO, 32));
}

function message(claims: SpeechUnitClaims): string {
  const parts = [
    claims.sessionId,
    claims.turnId ?? 'intro',
    String(claims.seq),
    claims.text.normalize('NFC'),
  ];
  if (claims.face === true) parts.push('face');
  return parts.join('|');
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
  const forms = claims.face === undefined ? [false, true] : [claims.face];
  let ok = false;
  for (const face of forms) {
    const expected = mac(key, { ...claims, face });
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}

/**
 * The unit as a {@link VerifiedSpeechUnit} when its signature verifies, else null. The only way to make one: the
 * cloned voice and the face are handed nothing else (docs/architecture/calls.md §4).
 */
export function verifiedSpeechUnit(
  keys: readonly SessionSigningKey[],
  claims: SpeechUnitClaims,
  sig: string | undefined,
): VerifiedSpeechUnit | null {
  if (sig === undefined || !verifySpeechUnit(keys, claims, sig)) return null;
  return {
    sessionId: claims.sessionId,
    turnId: claims.turnId,
    seq: claims.seq,
    text: claims.text,
    sig,
  } as unknown as VerifiedSpeechUnit;
}
