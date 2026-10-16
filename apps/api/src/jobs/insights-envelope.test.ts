import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_ALGORITHM,
  keyId,
  open,
  parseRecipientKey,
  RecipientKeyError,
  SealedEnvelope,
  seal,
} from './insights-envelope.js';

/** RSA keys are slow to generate: one 3072-bit pair (the smallest accepted) per file, plus a second for refusals. */
const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const publicB64 = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

describe('insights envelopes', () => {
  it('round-trips JSON sealed to a base64 DER key and a PEM key', () => {
    const value = { conversations: [{ founderText: 'Where do we start? ✓', n: 3 }] };
    for (const recipient of [publicB64, publicPem]) {
      const envelope = seal(value, parseRecipientKey(recipient));
      expect(SealedEnvelope.parse(envelope)).toEqual(envelope);
      expect(envelope.alg).toBe(ENVELOPE_ALGORITHM);
      expect(envelope.kid).toBe(keyId(pair.publicKey));
      expect(open(envelope, privatePem)).toEqual(value);
    }
  });

  it('carries no plaintext: the content never appears in the envelope', () => {
    const secret = 'the founder said something private';
    const envelope = seal({ text: secret }, parseRecipientKey(publicB64));
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('founder');
    expect(Buffer.from(envelope.data, 'base64').toString('latin1')).not.toContain('founder');
  });

  it('refuses another key, and a tampered ciphertext or key id', () => {
    const envelope = seal({ a: 1 }, parseRecipientKey(publicB64));
    const otherPem = other.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => open(envelope, otherPem)).toThrow(RecipientKeyError);
    const data = Buffer.from(envelope.data, 'base64');
    data[0] = (data[0] ?? 0) ^ 1;
    expect(() => open({ ...envelope, data: data.toString('base64') }, privatePem)).toThrow();
    // An envelope relabelled for another key is refused.
    const otherKid = keyId(other.publicKey);
    expect(() => open({ ...envelope, kid: otherKid }, privatePem)).toThrow(RecipientKeyError);
  });

  it('accepts only RSA keys of at least 3072 bits', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
    expect(() => parseRecipientKey(small.export({ format: 'der', type: 'spki' }).toString('base64'))).toThrow(
      /3072/,
    );
    expect(() => parseRecipientKey(ec.export({ format: 'pem', type: 'spki' }).toString())).toThrow(/RSA/);
    expect(() => parseRecipientKey('not a key at all')).toThrow(RecipientKeyError);
    expect(() => parseRecipientKey('QUJD')).toThrow(RecipientKeyError);
  });
});
