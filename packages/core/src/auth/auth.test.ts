import { ACCESS_CODE_PATTERN } from '@foundry/contracts';
import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  CROCKFORD_ALPHABET,
  accessCodePrefix,
  generateAccessCode,
  hashAccessCode,
  isAccessCodeHash,
  isWellFormedAccessCode,
  timingDummyHash,
  verifyAccessCode,
} from './access-code.js';
import { hashViewerAttribute } from './keys.js';
import { SessionCache } from './session-cache.js';
import { viewerNetwork } from './viewer-network.js';
import {
  MAX_TOKEN_LENGTH,
  signSessionToken,
  verifySessionToken,
  type SessionSigningKey,
} from './session-token.js';

const SUB = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const TID = '33333333-3333-4333-8333-333333333333';
const key = (id: string, fill: number): SessionSigningKey => ({ id, bytes: new Uint8Array(32).fill(fill) });

describe('access codes (runtime contract)', () => {
  it('generates FA-XXXXX-XXXXX-XXXXX-XXXXX in Crockford base32 with a public prefix', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateAccessCode();
      expect(code).toMatch(ACCESS_CODE_PATTERN);
      for (const ch of code.replace(/^FA-|-/g, '')) expect(CROCKFORD_ALPHABET).toContain(ch);
      expect(accessCodePrefix(code)).toBe(code.slice(3, 8));
      seen.add(code);
    }
    expect(seen.size).toBe(200);
    expect(CROCKFORD_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('hashes with scrypt N=32768,r=8,p=1 and verifies case-insensitively in constant time', async () => {
    const code = generateAccessCode();
    const hash = await hashAccessCode(code);
    expect(hash).toMatch(/^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(isAccessCodeHash(hash)).toBe(true);
    expect(hash).not.toContain(code);
    await expect(verifyAccessCode(code, hash)).resolves.toBe(true);
    await expect(verifyAccessCode(` ${code.toLowerCase()} `, hash)).resolves.toBe(true);
    await expect(verifyAccessCode(generateAccessCode(), hash)).resolves.toBe(false);
    await expect(verifyAccessCode(code, 'scrypt$N=1$bad')).resolves.toBe(false);
    await expect(verifyAccessCode(code, await timingDummyHash())).resolves.toBe(false);
    expect(await timingDummyHash()).toBe(await timingDummyHash());
  });

  it('validates input shape', () => {
    expect(isWellFormedAccessCode('fa-abcde-fghjk-mnpqr-stvwx')).toBe(true);
    expect(isWellFormedAccessCode('FA-ABCDE-FGHJK-MNPQR-STVWI')).toBe(false); // I is not Crockford
    expect(isWellFormedAccessCode('FA-ABCDE')).toBe(false);
    expect(() => accessCodePrefix('nope')).toThrow();
  });
});

describe('session tokens', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  it('round-trips sub/sid/tid with a 12 h expiry', async () => {
    const { token, claims } = await signSessionToken(
      key('k1', 1),
      { sub: SUB, sid: SID, tid: TID },
      { now, ttlSeconds: 43_200 },
    );
    expect(claims.exp - claims.iat).toBe(43_200);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(header).toMatchObject({ alg: 'HS256', kid: 'k1' });
    await expect(verifySessionToken(token, [key('k1', 1)], { now })).resolves.toMatchObject({
      sub: SUB,
      sid: SID,
      tid: TID,
    });
  });

  it('accepts tokens signed with a retired key during the grace period (kid lookup)', async () => {
    const { token } = await signSessionToken(
      key('old', 9),
      { sub: SUB, sid: SID, tid: TID },
      { now, ttlSeconds: 60 },
    );
    await expect(verifySessionToken(token, [key('new', 1), key('old', 9)], { now })).resolves.not.toBeNull();
    await expect(verifySessionToken(token, [key('new', 1)], { now })).resolves.toBeNull();
  });

  it('rejects expired, tampered, unsigned, malformed and oversized tokens', async () => {
    const { token } = await signSessionToken(
      key('k1', 1),
      { sub: SUB, sid: SID, tid: TID },
      { now, ttlSeconds: 60 },
    );
    await expect(
      verifySessionToken(token, [key('k1', 1)], { now: new Date(now.getTime() + 120_000) }),
    ).resolves.toBeNull();
    const [h, , s] = token.split('.');
    const payload = Buffer.from(
      JSON.stringify({ sub: SID, sid: SID, tid: TID, iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    await expect(verifySessionToken(`${h}.${payload}.${s}`, [key('k1', 1)], { now })).resolves.toBeNull();
    const unsigned = new UnsecuredJWT({ sid: SID, tid: TID })
      .setSubject(SUB)
      .setIssuedAt()
      .setExpirationTime('1h')
      .encode();
    await expect(verifySessionToken(unsigned, [key('k1', 1)], { now: new Date() })).resolves.toBeNull();
    const badClaims = await new SignJWT({ sid: 'not-a-uuid', tid: TID })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(SUB)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key('k1', 1).bytes);
    await expect(verifySessionToken(badClaims, [key('k1', 1)], { now: new Date() })).resolves.toBeNull();
    await expect(verifySessionToken('a.b', [key('k1', 1)], { now })).resolves.toBeNull();
    await expect(
      verifySessionToken('x'.repeat(MAX_TOKEN_LENGTH + 1), [key('k1', 1)], { now }),
    ).resolves.toBeNull();
  });
});

describe('session cache', () => {
  const entry = (sessionId: string, principalId: string, checkedAtMs: number) => ({
    sessionId,
    principalId,
    tenantId: TID,
    roles: [],
    valid: true,
    expiresAtMs: checkedAtMs + 3_600_000,
    checkedAtMs,
  });

  it('expires entries after the TTL and evicts the least recently used', () => {
    const cache = new SessionCache(60_000, 2);
    cache.set(entry('a', SUB, 0));
    cache.set(entry('b', SUB, 0));
    expect(cache.get('a', 59_999)).not.toBeNull();
    cache.set(entry('c', SUB, 0)); // evicts b (a was just used)
    expect(cache.get('b', 1)).toBeNull();
    expect(cache.get('a', 60_000)).toBeNull();
    expect(cache.size).toBe(1);
  });

  it('invalidates by session and by principal; TTL 0 disables caching', () => {
    const cache = new SessionCache(60_000, 10);
    cache.set(entry('a', SUB, 0));
    cache.set(entry('b', SID, 0));
    cache.invalidatePrincipal(SUB);
    expect(cache.get('a', 1)).toBeNull();
    cache.invalidate('b');
    expect(cache.get('b', 1)).toBeNull();
    const off = new SessionCache(0, 10);
    off.set(entry('a', SUB, 0));
    expect(off.get('a', 0)).toBeNull();
  });
});

describe('viewer hashing', () => {
  it('is salted, normalised and never contains the raw value', () => {
    const salt = new Uint8Array(32).fill(3);
    const a = hashViewerAttribute(salt, 'ip', '203.0.113.9');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashViewerAttribute(salt, 'ip', ' 203.0.113.9 ')).toBe(a);
    expect(hashViewerAttribute(new Uint8Array(32).fill(4), 'ip', '203.0.113.9')).not.toBe(a);
    expect(hashViewerAttribute(salt, 'ua', '203.0.113.9')).not.toBe(a);
    expect(hashViewerAttribute(salt, 'ip', null)).toBe(hashViewerAttribute(salt, 'ip', ''));
  });
});

describe('viewerNetwork (lockout key)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
  ])('%s → %s', (ip, network) => {
    expect(viewerNetwork(ip)).toBe(network);
  });

  it('puts rotating addresses of one /64 in one bucket, other prefixes in others', () => {
    const a = viewerNetwork('2001:db8:aa:bb:1111:2222:3333:4444');
    expect(viewerNetwork('2001:db8:aa:bb::ffff')).toBe(a);
    expect(viewerNetwork('2001:db8:aa:bc::1')).not.toBe(a);
    expect(viewerNetwork(null)).toBeNull();
    expect(viewerNetwork('')).toBeNull();
  });
});
