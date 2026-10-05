import { SignJWT } from 'jose';
import { auditRepo, authRepo, p, principalsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCore } from '../core.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { ManualClock } from '../testing/fakes.js';
import { generateAccessCode } from './access-code.js';
import { hashViewerAttribute } from './keys.js';

let h: CoreHarness;
let ownerCode: string;

beforeAll(async () => {
  h = await createCoreHarness();
  if (!h.t.ownerAccessCode) throw new Error('owner code missing');
  ownerCode = h.t.ownerAccessCode;
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

const req = (n: number): string => `auth-test-${n}`;

describe('sign-in', () => {
  it('signs in the seeded owner (input normalised) and verifies the session with roles', async () => {
    const typed = `  ${ownerCode.toLowerCase()} `;
    const result = await h.core.auth.signIn({
      accessCode: typed,
      viewerIp: '198.51.100.7',
      userAgent: 'vitest',
      requestId: req(1),
    });
    expect(result.principalId).toBe(h.people.owner);
    expect(result.tenantId).toBe(h.seed.tenantId);
    expect(result.maxAgeSeconds).toBe(12 * 3600);
    expect(result.token.split('.')).toHaveLength(3);
    const ctx = await h.core.auth.verifySession(result.token, { requestId: req(2) });
    expect(ctx.principalId).toBe(h.people.owner);
    expect(ctx.sessionId).toBe(result.sessionId);
    expect([...ctx.roles].sort()).toEqual(['platform_admin', 'program_lead']);
    const me = await h.core.me.get(ctx);
    expect(me.principal.id).toBe(h.people.owner);
    expect(me.aiEnabled).toBe(true);

    // JWT claims: sub/sid/tid, HS256, 12 h.
    const payload = JSON.parse(
      Buffer.from(result.token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: h.people.owner, sid: result.sessionId, tid: h.seed.tenantId });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(12 * 3600);
    const lastUsed = await h.t.db.system((sx) =>
      sx.query('SELECT last_used_at FROM access_codes WHERE principal_id = :p', {
        p: p.uuid(h.people.owner),
      }),
    );
    expect(lastUsed.rows[0]?.last_used_at).not.toBeNull();
  });

  it('rejects wrong, unknown and malformed codes uniformly and never stores the code', async () => {
    const prefix = ownerCode.slice(3, 8);
    const wrongSecret = `FA-${prefix}-${generateAccessCode().slice(9)}`;
    const attempts = [wrongSecret, generateAccessCode(), 'not-a-code', ''];
    const messages = new Set<string>();
    for (const [i, code] of attempts.entries()) {
      const err = await h.core.auth
        .signIn({ accessCode: code, viewerIp: '203.0.113.50', requestId: req(10 + i) })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ code: 'invalid_access_code', status: 401 });
      messages.add((err as Error).message);
    }
    expect(messages.size).toBe(1);
    const audit = await h.t.db.system((sx) =>
      auditRepo.listAuditEvents(sx, { action: 'auth.sign_in', outcome: 'denied' }),
    );
    expect(JSON.stringify(audit.items)).not.toContain(wrongSecret);
    const attemptsRow = await h.t.db.system((sx) =>
      sx.query("SELECT subject_hash FROM auth_attempts WHERE subject_hash <> 'global'"),
    );
    for (const r of attemptsRow.rows) expect(String(r.subject_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(attemptsRow.rows)).not.toContain('203.0.113.50');
  });

  it('locks an IP out after 10 failures in 15 minutes, even for the right code; other IPs are unaffected', async () => {
    const ip = '192.0.2.99';
    for (let i = 0; i < 10; i += 1) {
      await expect(
        h.core.auth.signIn({ accessCode: generateAccessCode(), viewerIp: ip, requestId: req(100 + i) }),
      ).rejects.toMatchObject({ code: 'invalid_access_code' });
    }
    const locked = await h.core.auth
      .signIn({ accessCode: ownerCode, viewerIp: ip, requestId: req(120) })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(locked).toMatchObject({ code: 'locked_out', status: 429 });
    const retry = (locked as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);
    await expect(
      h.core.auth.signIn({ accessCode: ownerCode, viewerIp: '192.0.2.100', requestId: req(121) }),
    ).resolves.toMatchObject({
      principalId: h.people.owner,
    });
  });

  it('concurrent attempts from one IP cannot slip past the lockout (exactly 10 are evaluated)', async () => {
    const ip = '192.0.2.150';
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        h.core.auth.signIn({ accessCode: generateAccessCode(), viewerIp: ip, requestId: req(150 + i) }).then(
          () => 'signed_in',
          (e: unknown) => (e as { code?: string }).code ?? 'unknown',
        ),
      ),
    );
    // Exactly the first 10 are verified (and fail); the rest are refused without being counted.
    expect(results.filter((c) => c === 'invalid_access_code')).toHaveLength(10);
    expect(results.filter((c) => c === 'locked_out')).toHaveLength(6);
    await expect(
      h.core.auth.signIn({ accessCode: ownerCode, viewerIp: ip, requestId: req(170) }),
    ).rejects.toMatchObject({ code: 'locked_out' });
    const salt = await h.t.db.system((sx) => authRepo.getActivePlatformKey(sx, 'ip_hash_salt'));
    const subjectHash = hashViewerAttribute(
      new Uint8Array(Buffer.from(salt?.keyBase64 ?? '', 'base64')),
      'ip',
      ip,
    );
    const window = await h.t.db.system((sx) =>
      authRepo.authFailureWindow(sx, { subjectHash, windowSeconds: 900 }),
    );
    expect(window.failures).toBe(10);
  });

  it('counts IPv6 viewers per /64, so rotating addresses inside one prefix does not escape the lockout', async () => {
    for (let i = 0; i < 10; i += 1) {
      await expect(
        h.core.auth.signIn({
          accessCode: generateAccessCode(),
          viewerIp: `2001:db8:77:1::${(i + 1).toString(16)}`,
          requestId: req(400 + i),
        }),
      ).rejects.toMatchObject({ code: 'invalid_access_code' });
    }
    await expect(
      h.core.auth.signIn({ accessCode: ownerCode, viewerIp: '2001:db8:77:1:abcd::99', requestId: req(420) }),
    ).rejects.toMatchObject({ code: 'locked_out' });
    await expect(
      h.core.auth.signIn({ accessCode: ownerCode, viewerIp: '2001:db8:77:2::1', requestId: req(421) }),
    ).resolves.toMatchObject({ principalId: h.people.owner });
  });

  it('records one attempt per successful sign-in and never counts it as a failure', async () => {
    const ip = '192.0.2.160';
    await h.core.auth.signIn({ accessCode: ownerCode, viewerIp: ip, requestId: req(190) });
    const salt = await h.t.db.system((sx) => authRepo.getActivePlatformKey(sx, 'ip_hash_salt'));
    const subjectHash = hashViewerAttribute(
      new Uint8Array(Buffer.from(salt?.keyBase64 ?? '', 'base64')),
      'ip',
      ip,
    );
    const rows = await h.t.db.system((sx) =>
      sx.query('SELECT succeeded FROM auth_attempts WHERE subject_hash = :s', { s: p.text(subjectHash) }),
    );
    expect(rows.rows).toEqual([{ succeeded: true }]);
  });

  it('global soft limit throttles viewers that already failed, not fresh viewers', async () => {
    const strict = h.withConfig({ signIn: { globalSoftLimit: 1 } });
    await expect(
      strict.auth.signIn({ accessCode: generateAccessCode(), viewerIp: '198.18.0.1', requestId: req(200) }),
    ).rejects.toMatchObject({ code: 'invalid_access_code' });
    await expect(
      strict.auth.signIn({ accessCode: ownerCode, viewerIp: '198.18.0.1', requestId: req(201) }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(
      strict.auth.signIn({ accessCode: ownerCode, viewerIp: '198.18.0.2', requestId: req(202) }),
    ).resolves.toBeTruthy();
  });
});

describe('sessions and revocation', () => {
  it('sign-out revokes the session immediately', async () => {
    const result = await h.core.auth.signIn({
      accessCode: ownerCode,
      viewerIp: '198.51.100.20',
      requestId: req(300),
    });
    const ctx = await h.core.auth.verifySession(result.token, { requestId: req(301) });
    await h.core.auth.signOut(ctx);
    await expect(h.core.auth.verifySession(result.token, { requestId: req(302) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('invited members sign in with their one-time code; revoking the code ends their sessions', async () => {
    const lead = await h.ctxFor(h.people.lead);
    const issued = await h.core.team.invite(lead, h.ventures.benchtally.id, {
      displayName: 'Rae Invited',
      role: 'team',
      expiresInDays: 30,
    });
    expect(issued.accessCode).toMatch(/^FA-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    const stored = await h.t.db.system((sx) =>
      authRepo.findAccessCodeByPrefix(sx, issued.accessCode.slice(3, 8)),
    );
    expect(stored?.codeHash).toMatch(/^scrypt\$N=32768,r=8,p=1\$/);
    expect(stored?.codeHash).not.toContain(issued.accessCode);

    const signIn = await h.core.auth.signIn({
      accessCode: issued.accessCode,
      viewerIp: '198.51.100.30',
      requestId: req(400),
    });
    const ctx = await h.core.auth.verifySession(signIn.token, { requestId: req(401) });
    await expect(h.core.ventures.get(ctx, h.ventures.benchtally.id)).resolves.toMatchObject({
      myRole: 'team',
    });
    await expect(h.core.ventures.get(ctx, h.ventures.quietquad.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    const owner = await h.ctxFor(h.people.owner);
    await h.core.admin.revokeAccessCode(owner, issued.accessCodeId);
    await expect(h.core.auth.verifySession(signIn.token, { requestId: req(402) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(
      h.core.auth.signIn({ accessCode: issued.accessCode, viewerIp: '198.51.100.31', requestId: req(403) }),
    ).rejects.toMatchObject({ code: 'invalid_access_code' });
  });

  it('caches revocation state for up to the configured TTL in other containers', async () => {
    const cached = h.withConfig({ session: { revocationCacheSeconds: 60 } });
    const uncached = h.withConfig({ session: { revocationCacheSeconds: 0 } });
    const result = await cached.auth.signIn({
      accessCode: ownerCode,
      viewerIp: '198.51.100.40',
      requestId: req(500),
    });
    await cached.auth.verifySession(result.token, { requestId: req(501) });
    await h.t.db.system((sx) => authRepo.revokeAuthSession(sx, result.sessionId));
    await expect(cached.auth.verifySession(result.token, { requestId: req(502) })).resolves.toMatchObject({
      sessionId: result.sessionId,
    });
    await expect(uncached.auth.verifySession(result.token, { requestId: req(503) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rejects tampered, foreign-key and expired tokens', async () => {
    const result = await h.core.auth.signIn({
      accessCode: ownerCode,
      viewerIp: '198.51.100.50',
      requestId: req(600),
    });
    const [header, , signature] = result.token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: h.people.maya,
        sid: result.sessionId,
        tid: h.seed.tenantId,
        iat: 1,
        exp: 4_000_000_000,
      }),
    ).toString('base64url');
    await expect(
      h.core.auth.verifySession(`${header}.${forged}.${signature}`, { requestId: req(601) }),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const foreign = await new SignJWT({ sid: result.sessionId, tid: h.seed.tenantId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(h.people.owner)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new Uint8Array(32).fill(7));
    await expect(h.core.auth.verifySession(foreign, { requestId: req(602) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });

    const clock = new ManualClock();
    const timed = createCore({
      db: h.t.db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      clock,
    });
    const fresh = await timed.auth.signIn({
      accessCode: ownerCode,
      viewerIp: '198.51.100.51',
      requestId: req(603),
    });
    clock.advance(12 * 3600 * 1000 + 60_000);
    await expect(timed.auth.verifySession(fresh.token, { requestId: req(604) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('disabled principals cannot sign in and lose existing sessions', async () => {
    const owner = await h.ctxFor(h.people.owner);
    const issued = await h.core.admin.issueAccessCode(owner, h.people.ines, {
      label: 'temp',
      expiresInDays: 1,
    });
    const strict = h.withConfig({ session: { revocationCacheSeconds: 0 } });
    const result = await strict.auth.signIn({
      accessCode: issued.accessCode,
      viewerIp: '198.51.100.60',
      requestId: req(700),
    });
    await h.t.db.system((sx) => principalsRepo.updatePrincipal(sx, h.people.ines, { status: 'disabled' }));
    try {
      await expect(strict.auth.verifySession(result.token, { requestId: req(701) })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
      await expect(
        strict.auth.signIn({ accessCode: issued.accessCode, viewerIp: '198.51.100.61', requestId: req(702) }),
      ).rejects.toMatchObject({ code: 'invalid_access_code' });
    } finally {
      await h.t.db.system((sx) => principalsRepo.updatePrincipal(sx, h.people.ines, { status: 'active' }));
    }
  });

  it('expired codes are rejected', async () => {
    const owner = await h.ctxFor(h.people.owner);
    const issued = await h.core.admin.issueAccessCode(owner, h.people.jonah, {
      label: 'short',
      expiresInDays: 1,
    });
    await h.t.db.system((sx) =>
      sx.query(`UPDATE access_codes SET expires_at = now() - interval '1 minute' WHERE id = :id`, {
        id: p.uuid(issued.accessCodeId),
      }),
    );
    await expect(
      h.core.auth.signIn({ accessCode: issued.accessCode, viewerIp: '198.51.100.70', requestId: req(800) }),
    ).rejects.toMatchObject({ code: 'invalid_access_code' });
  });
});
