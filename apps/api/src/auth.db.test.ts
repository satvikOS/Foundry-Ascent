import { createHash } from 'node:crypto';

import { HealthResponse, Me, ProblemDetails } from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, buildRequest, createApiHarness, sessionTokenFrom } from './testing/api-harness.js';

let api: ApiHarness;

beforeAll(async () => {
  api = await createApiHarness();
});
afterAll(async () => {
  await api.cleanup();
});

async function problem(res: Response): Promise<ProblemDetails> {
  expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  const body = ProblemDetails.parse(await res.json());
  expect(body.status).toBe(res.status);
  expect(body.requestId).toBe(res.headers.get('x-request-id'));
  return body;
}

describe('health', () => {
  it('is public liveness with the deployed version (no database probe)', async () => {
    const res = await api.request('/health');
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', version: 'test-version' });
    expect(body).not.toHaveProperty('db');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('echoes a well-formed x-request-id and replaces a malformed one', async () => {
    const good = await api.request('/health', { headers: { 'x-request-id': 'req-1234567890abcdef' } });
    expect(good.headers.get('x-request-id')).toBe('req-1234567890abcdef');
    const bad = await api.request('/health', { headers: { 'x-request-id': 'no spaces <allowed>' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown endpoints with a problem document', async () => {
    const res = await api.request('/no-such-endpoint');
    expect(res.status).toBe(404);
    expect((await problem(res)).code).toBe('not_found');
  });
});

describe('sign-in', () => {
  it('sets the session cookie with the required flags and returns the principal', async () => {
    const code = api.h.t.ownerAccessCode;
    if (code === null) throw new Error('missing owner code');
    // Lower-case and padded input is normalised by core.
    const res = await api.request('/auth/sign-in', {
      body: { accessCode: `  ${code.toLowerCase()} ` },
      headers: { 'x-fa-viewer-ip': '203.0.113.10' },
    });
    expect(res.status).toBe(200);
    const me = Me.parse(await res.json());
    expect(me.principal.id).toBe(api.h.people.owner);
    expect(me.roles).toEqual(expect.arrayContaining(['platform_admin', 'program_lead']));
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0] ?? '';
    expect(cookie).toMatch(/^fa_session=[A-Za-z0-9._-]+;/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api', 'Max-Age=43200']) {
      expect(cookie).toContain(flag);
    }
    // The session works for authenticated endpoints.
    const token = sessionTokenFrom(res);
    const meAgain = await api.request('/me', { cookie: token ?? '' });
    expect(meAgain.status).toBe(200);
    expect(Me.parse(await meAgain.json()).principal.id).toBe(api.h.people.owner);
  });

  it('rejects an invalid code with a uniform 401 and never logs the code', async () => {
    const attempt = 'FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
    const res = await api.request('/auth/sign-in', {
      body: { accessCode: attempt },
      headers: { 'x-fa-viewer-ip': '203.0.113.20' },
    });
    expect(res.status).toBe(401);
    const body = await problem(res);
    expect(body.code).toBe('invalid_access_code');
    expect(res.headers.getSetCookie()).toHaveLength(0);
    // Malformed input gets the same answer (no format oracle).
    const malformed = await api.request('/auth/sign-in', {
      body: { accessCode: 'hello' },
      headers: { 'x-fa-viewer-ip': '203.0.113.20' },
    });
    expect(malformed.status).toBe(401);
    expect((await problem(malformed)).code).toBe('invalid_access_code');
    expect(api.logs.join('\n')).not.toContain(attempt);
  });

  it('locks a viewer IP out after 10 failures (429 + Retry-After), per IP', async () => {
    const ip = '203.0.113.99';
    for (let i = 0; i < 10; i += 1) {
      const res = await api.request('/auth/sign-in', {
        body: { accessCode: 'FA-00000-00000-00000-00000' },
        headers: { 'x-fa-viewer-ip': ip },
      });
      expect(res.status).toBe(401);
    }
    const code = api.h.t.ownerAccessCode ?? '';
    const locked = await api.request('/auth/sign-in', {
      body: { accessCode: code },
      headers: { 'x-fa-viewer-ip': ip },
    });
    expect(locked.status).toBe(429);
    const body = await problem(locked);
    expect(body.code).toBe('locked_out');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBe(Number(locked.headers.get('retry-after')));
    // A client-chosen x-forwarded-for (or CloudFront-Viewer-Address) cannot move the attempt to a fresh
    // bucket: only the CloudFront-set x-fa-viewer-ip counts outside development.
    const spoofed = await api.request('/auth/sign-in', {
      body: { accessCode: code },
      headers: {
        'x-fa-viewer-ip': ip,
        'x-forwarded-for': '198.51.100.123, 10.0.0.1',
        'cloudfront-viewer-address': '198.51.100.124:443',
      },
    });
    expect(spoofed.status).toBe(429);
    // Another viewer is not locked.
    const other = await api.request('/auth/sign-in', {
      body: { accessCode: code },
      headers: { 'x-fa-viewer-ip': '203.0.113.100' },
    });
    expect(other.status).toBe(200);
  });

  it('ignores x-forwarded-for outside development (no header: one shared bucket that fails closed)', async () => {
    const bucket = await createApiHarness();
    try {
      for (let i = 0; i < 10; i += 1) {
        const res = await bucket.request('/auth/sign-in', {
          body: { accessCode: 'FA-00000-00000-00000-00000' },
          // A different "client IP" each time: rotating it must not reset the counter.
          headers: { 'x-forwarded-for': `198.51.100.${String(i + 1)}` },
        });
        expect(res.status).toBe(401);
      }
      const locked = await bucket.request('/auth/sign-in', {
        body: { accessCode: bucket.h.t.ownerAccessCode ?? '' },
        headers: { 'x-forwarded-for': '198.51.100.200' },
      });
      expect(locked.status).toBe(429);
      // Development (Vite proxy / dev server) is the only place x-forwarded-for is believed.
      const dev = bucket.appWith({ appEnv: 'development' });
      const devSignIn = await dev.request(
        buildRequest('/auth/sign-in', {
          body: { accessCode: bucket.h.t.ownerAccessCode ?? '' },
          headers: { 'x-forwarded-for': '198.51.100.201, 127.0.0.1' },
        }),
      );
      expect(devSignIn.status).toBe(200);
    } finally {
      await bucket.cleanup();
    }
  });

  it('validates the body shape (422 with field errors) and JSON syntax (400)', async () => {
    const missing = await api.request('/auth/sign-in', { body: {} });
    expect(missing.status).toBe(422);
    const body = await problem(missing);
    expect(body.code).toBe('validation_failed');
    expect(body.errors?.[0]?.path).toBe('accessCode');

    const broken = await api.request('/auth/sign-in', { body: '{"accessCode": ' });
    expect(broken.status).toBe(400);
    expect((await problem(broken)).code).toBe('bad_request');

    const form = await api.request('/auth/sign-in', {
      body: 'accessCode=FA-1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(415);
    expect((await problem(form)).code).toBe('unsupported_media_type');
  });
});

describe('CSRF and body integrity', () => {
  it('rejects non-GET requests without X-Requested-With: foundry-ascent (403)', async () => {
    const res = await api.request('/auth/sign-in', { body: { accessCode: 'x' }, csrf: false });
    expect(res.status).toBe(403);
    expect((await problem(res)).code).toBe('forbidden');

    const token = await api.ownerToken();
    const wrong = await api.request('/program/ventures', {
      body: { name: 'Nope' },
      cookie: token,
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(wrong.status).toBe(403);
  });

  it('does not require x-amz-content-sha256 locally, but rejects a mismatching one', async () => {
    const token = await api.ownerToken();
    const body = JSON.stringify({ name: 'Hash Check Venture' });
    const none = await api.request('/program/ventures', { body, cookie: token });
    expect(none.status).toBe(201);

    const wrong = await api.request('/program/ventures', {
      body,
      cookie: token,
      headers: { 'x-amz-content-sha256': createHash('sha256').update('something else').digest('hex') },
    });
    expect(wrong.status).toBe(400);
    expect((await problem(wrong)).code).toBe('bad_request');

    const right = await api.request('/program/ventures', {
      body: JSON.stringify({ name: 'Hash Check Venture Two' }),
      cookie: token,
      headers: {
        'x-amz-content-sha256': createHash('sha256')
          .update(JSON.stringify({ name: 'Hash Check Venture Two' }))
          .digest('hex'),
      },
    });
    expect(right.status).toBe(201);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await api.request('/auth/sign-in', { body: { accessCode: 'x'.repeat(1024 * 1024 + 10) } });
    expect(res.status).toBe(413);
    expect((await problem(res)).code).toBe('upload_too_large');
  });
});

describe('sessions', () => {
  it('rejects anonymous requests on every authenticated endpoint (401 problem)', async () => {
    const authenticated = api.app.routeTable.filter((r) => r.auth === 'session');
    expect(authenticated.length).toBeGreaterThanOrEqual(50);
    for (const route of authenticated) {
      const path = route.path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await api.app.request(
        buildRequest(path, {
          method: route.method === 'PUT' ? 'POST' : route.method,
          ...(route.method === 'GET' ? {} : { body: {} }),
        }),
      );
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
      expect((await problem(res)).code).toBe('unauthenticated');
    }
  });

  it('rejects a forged or garbage cookie and clears it', async () => {
    const res = await api.request('/me', { cookie: 'eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl' });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join(';')).toMatch(/fa_session=; Max-Age=0/);
  });

  it('signs out: the session stops working and the cookie is cleared', async () => {
    const token = await api.signInAs(api.h.people.maya);
    expect((await api.request('/me', { cookie: token })).status).toBe(200);
    const out = await api.request('/auth/sign-out', { method: 'POST', cookie: token });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join(';')).toMatch(/fa_session=; Max-Age=0/);
    const after = await api.request('/me', { cookie: token });
    expect(after.status).toBe(401);
    // Signing out without a session is harmless.
    expect((await api.request('/auth/sign-out', { method: 'POST' })).status).toBe(204);
  });

  it('logs one structured line per request without content', async () => {
    const before = api.logs.length;
    const token = await api.signInAs(api.h.people.jonah);
    await api.request('/me', { cookie: token });
    const lines = api.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    const access = lines.filter((l) => l.event === 'http.request');
    const me = access.find((l) => l.route === '/api/v1/me');
    expect(me).toMatchObject({ method: 'GET', status: 200 });
    expect(me?.principal).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof me?.latencyMs).toBe('number');
    expect(typeof me?.requestId).toBe('string');
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(JSON.stringify(lines)).not.toContain(api.h.people.jonah);
  });
});
