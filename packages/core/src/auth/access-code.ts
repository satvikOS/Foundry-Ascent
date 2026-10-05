/**
 * Access codes (runtime contract):
 *   code   FA-AAAAA-BBBBB-CCCCC-DDDDD — Crockford base32 (0123456789ABCDEFGHJKMNPQRSTVWXYZ), crypto random
 *   prefix first group, stored in access_codes.code_prefix (public lookup key)
 *   hash   scrypt$N=32768,r=8,p=1$<salt base64url>$<32-byte key base64url> of the full uppercase code
 *          (node:crypto scrypt, maxmem 64 MiB), compared with timingSafeEqual.
 *
 * The implementation is shared with the seed (single source of truth in @foundry/db) so the owner code
 * bound at deploy time and codes issued in the product verify identically.
 */
import { randomBytes } from 'node:crypto';

import { ACCESS_CODE_PATTERN } from '@foundry/contracts';
import {
  ACCESS_CODE_RE,
  CROCKFORD_ALPHABET,
  accessCodePrefix,
  generateAccessCode,
  hashAccessCode,
  isAccessCodeHash,
  normalizeAccessCode,
  verifyAccessCode,
} from '@foundry/db';

export {
  ACCESS_CODE_RE,
  CROCKFORD_ALPHABET,
  accessCodePrefix,
  generateAccessCode,
  hashAccessCode,
  isAccessCodeHash,
  normalizeAccessCode,
  verifyAccessCode,
};

/** True when `code` (after trim/uppercase) has the contract format. */
export function isWellFormedAccessCode(code: string): boolean {
  const normalized = normalizeAccessCode(code);
  return ACCESS_CODE_RE.test(normalized) && ACCESS_CODE_PATTERN.test(normalized);
}

let dummyHash: Promise<string> | null = null;

/**
 * A hash of a random code, verified when the presented prefix is unknown or malformed so every
 * sign-in attempt costs one scrypt evaluation (uniform timing).
 */
export function timingDummyHash(): Promise<string> {
  dummyHash ??= hashAccessCode(generateAccessCode(), randomBytes(16));
  return dummyHash;
}
