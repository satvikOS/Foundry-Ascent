/**
 * Access-code format and hashing shared by the seed and local tooling (runtime contract):
 *   code  FA-AAAAA-BBBBB-CCCCC-DDDDD  (Crockford base32, 4 × 5 chars = 100 random bits)
 *   prefix = first group (public lookup key, access_codes.code_prefix)
 *   hash  scrypt$N=32768,r=8,p=1$<salt base64url>$<32-byte key base64url> of the full uppercase code
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ACCESS_CODE_RE = /^FA-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;
const HASH_PREFIX = `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$`;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Normalises user input (trim + uppercase). */
export function normalizeAccessCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Generates a fresh random access code (100 bits of entropy). */
export function generateAccessCode(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(20);
  const chars: string[] = [];
  for (let i = 0; i < 20; i += 1) chars.push(CROCKFORD_ALPHABET[(bytes[i] ?? 0) & 31] ?? '0');
  const groups = [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join(''));
  return `FA-${groups.join('-')}`;
}

/** Public lookup prefix (first group) of a well-formed code. */
export function accessCodePrefix(code: string): string {
  const normalized = normalizeAccessCode(code);
  if (!ACCESS_CODE_RE.test(normalized)) throw new Error('malformed access code');
  return normalized.slice(3, 8);
}

/** `scrypt$N=32768,r=8,p=1$<salt>$<key>` of the normalised code. */
export async function hashAccessCode(code: string, salt: Buffer = randomBytes(16)): Promise<string> {
  const key = await scrypt(normalizeAccessCode(code), salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `${HASH_PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time verification of a code against a stored hash (false for malformed hashes). */
export async function verifyAccessCode(code: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(HASH_PREFIX)) return false;
  const [saltText, keyText] = stored.slice(HASH_PREFIX.length).split('$');
  if (!saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  if (expected.length !== SCRYPT.keyLength) return false;
  const actual = await scrypt(
    normalizeAccessCode(code),
    Buffer.from(saltText, 'base64url'),
    SCRYPT.keyLength,
    {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: SCRYPT.maxmem,
    },
  );
  return timingSafeEqual(actual, expected);
}

/** True when `hash` has the runtime-contract shape (used to validate OWNER_ACCESS_CODE_HASH). */
export function isAccessCodeHash(hash: string): boolean {
  return /^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(hash);
}
