/**
 * Sealed envelopes for the operator insights export: content leaves the insights function only encrypted to
 * an RSA public key the operator generated locally (whose private key never leaves the operator's machine).
 *
 * Hybrid encryption, Node's built-in crypto only: the JSON is gzipped, encrypted with a random AES-256-GCM key
 * (12-byte IV, 16-byte tag, the version and key id as additional data), and that key is wrapped with
 * RSA-OAEP (SHA-256) for the recipient. The key id is the first 16 hex characters of the SHA-256 of the
 * recipient's DER SubjectPublicKeyInfo, so the operator can tell which key a file needs without trying.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { z } from 'zod';

export const ENVELOPE_ALGORITHM = 'RSA-OAEP-256+A256GCM+gzip';
/** Smallest RSA modulus accepted for the recipient key. */
export const MIN_RSA_BITS = 3072;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const Base64 = z.string().min(1).max(16_000_000).regex(B64);

export const SealedEnvelope = z
  .object({
    v: z.literal(1),
    alg: z.literal(ENVELOPE_ALGORITHM),
    kid: z.string().regex(/^[0-9a-f]{16}$/),
    key: Base64,
    iv: Base64,
    tag: Base64,
    data: Base64,
  })
  .strict();
export type SealedEnvelope = z.infer<typeof SealedEnvelope>;

export class RecipientKeyError extends Error {
  override readonly name = 'RecipientKeyError';
}

/**
 * The recipient's RSA public key from a PEM `PUBLIC KEY` block or the base64 of its DER SubjectPublicKeyInfo
 * (one line, as a workflow input carries it). Refuses anything but RSA of at least {@link MIN_RSA_BITS} bits.
 */
export function parseRecipientKey(text: string): KeyObject {
  const trimmed = text.trim();
  let key: KeyObject;
  try {
    if (trimmed.startsWith('-----BEGIN PUBLIC KEY-----')) {
      key = createPublicKey({ key: trimmed, format: 'pem' });
    } else {
      const compact = trimmed.replace(/\s+/g, '');
      if (!B64.test(compact)) throw new RecipientKeyError('not base64');
      key = createPublicKey({ key: Buffer.from(compact, 'base64'), format: 'der', type: 'spki' });
    }
  } catch {
    throw new RecipientKeyError('the public key could not be read');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new RecipientKeyError('the public key must be RSA');
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) {
    throw new RecipientKeyError(`the public key must have at least ${String(MIN_RSA_BITS)} bits`);
  }
  return key;
}

/** First 16 hex characters of the SHA-256 of the key's DER SubjectPublicKeyInfo. */
export function keyId(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function aad(kid: string): Buffer {
  return Buffer.from(`foundry-insights:v1:${kid}`, 'utf8');
}

/** Gzips and encrypts `value` (JSON) for `recipient`. */
export function seal(value: unknown, recipient: KeyObject): SealedEnvelope {
  const kid = keyId(recipient);
  const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
  cipher.setAAD(aad(kid));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const key = publicEncrypt(
    { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    contentKey,
  );
  contentKey.fill(0);
  return {
    v: 1,
    alg: ENVELOPE_ALGORITHM,
    kid,
    key: key.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

/** Decrypts an envelope with the recipient's private key (PEM). Throws when it is not for this key. */
export function open(envelope: SealedEnvelope, privateKeyPem: string): unknown {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const kid = keyId(privateKey);
  if (envelope.kid !== kid) throw new RecipientKeyError('the envelope was sealed for another key');
  const contentKey = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(aad(kid));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(gunzipSync(plain).toString('utf8')) as unknown;
}
