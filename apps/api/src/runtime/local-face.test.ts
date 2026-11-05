import { describe, expect, it } from 'vitest';

import { HeygenLiveAvatarFace, LIVEAVATAR_SANDBOX_AVATAR } from '../adapters/heygen-liveavatar.js';
import { ConfigError, loadApiConfig } from '../config.js';
import {
  LAB_FACE_PROBE_TOKEN,
  LOCAL_FACE_KEY,
  PROBE_HEADER,
  fieldShape,
  localFaceFor,
  recordingFetch,
  vendorPath,
  type VendorCall,
} from './local-face.js';

const KEY = 'lab-test-key-not-a-real-one';
const TOKEN = 'p'.repeat(40);
const lab = {
  APP_ENV: 'development',
  MEDIA_FACE_PROVIDER: 'heygen-liveavatar',
  MEDIA_FACE_MODE: 'full',
  MEDIA_FACE_SANDBOX: 'true',
  MEDIA_FACE_AVATAR_ID: LIVEAVATAR_SANDBOX_AVATAR,
  MEDIA_FACE_AUDIENCE: 'admins',
  [LOCAL_FACE_KEY]: KEY,
};

function face(env: Record<string, string>, fetch?: typeof globalThis.fetch) {
  return localFaceFor(env, loadApiConfig(env, 'dev'), fetch === undefined ? {} : { fetch });
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A vendor that answers each path from `routes` (recorded-response shapes) and records every request. */
function vendor(routes: Record<string, { status: number; body: unknown }>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const impl = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    const route = routes[new URL(url).pathname];
    if (route === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status }));
  };
  return { fetch: impl, seen };
}

const sandboxRoutes = {
  '/v1/sessions/token': {
    status: 200,
    body: { code: 1000, data: { session_id: 's-1', session_token: 'session-token' }, message: 'ok' },
  },
  '/v1/sessions/start': {
    status: 201,
    body: {
      code: 1000,
      data: {
        session_id: 's-1',
        livekit_url: 'wss://heygen-feapbkvq.livekit.cloud',
        livekit_client_token: 'client-token',
        livekit_agent_token: 'agent-token',
        ws_url: 'wss://control.example/should-stay-on-the-server',
        max_session_duration: 60,
      },
    },
  },
  '/v1/sessions/stop': { status: 200, body: { code: 1000, data: null } },
  '/v1/users/credits': { status: 200, body: { code: 100, data: { credits_left: '10.00' } } },
  '/v1/sessions/s-1/transcript': {
    status: 200,
    body: {
      code: 100,
      data: {
        session_active: true,
        next_timestamp: null,
        transcript_data: [{ role: 'avatar', transcript: 'Hello there.', absolute_timestamp: 1700000000 }],
      },
    },
  },
};

describe('localFaceFor (the dev server, the conversation lab face suite)', () => {
  it('wires the vendor face from the local key, configured by the same MEDIA_FACE_* variables', () => {
    const wired = face(lab);
    expect(wired.embodiment).toBeInstanceOf(HeygenLiveAvatarFace);
    expect(wired.embodiment).toMatchObject({
      mode: 'full',
      voicing: 'text',
      sandbox: true,
      adminsOnly: true,
      likeness: false,
    });
    expect(wired.probe).toBeUndefined();
    expect(face({ ...lab, MEDIA_FACE_MODE: 'lite' }).embodiment).toMatchObject({
      mode: 'lite',
      voicing: 'audio',
    });
  });

  it('is off unless asked for', () => {
    expect(face({ APP_ENV: 'development' })).toEqual({});
    expect(face({ APP_ENV: 'development', [LOCAL_FACE_KEY]: '  ' })).toEqual({});
  });

  it('refuses the key outside development, and production at configuration already', () => {
    expect(() => loadApiConfig({ ...lab, APP_ENV: 'production' }, 'dev')).toThrow(ConfigError);
    expect(() => loadApiConfig({ ...lab, APP_ENV: 'test' }, 'dev')).toThrow(/local development server only/);
    expect(() => loadApiConfig({ ...lab, APP_ENV: 'production' }, 'dev')).not.toThrow(new RegExp(KEY));
    const config = loadApiConfig({ ...lab, [LOCAL_FACE_KEY]: '' }, 'dev');
    expect(() => localFaceFor({ ...lab, APP_ENV: 'production' }, config)).toThrow(/development server only/);
  });

  it('refuses a half configuration and the stand-in alongside, never naming the key', () => {
    const attempts = [
      { ...lab, [LOCAL_FACE_KEY]: '' },
      { ...lab, MEDIA_FACE_PROVIDER: 'none' },
      { ...lab, EMBODIMENT_PROVIDER: 'fake' },
      { ...lab, [LAB_FACE_PROBE_TOKEN]: 'short' },
      { ...lab, MEDIA_FACE_SANDBOX: 'false', [LAB_FACE_PROBE_TOKEN]: TOKEN },
    ];
    for (const env of attempts) {
      let message = '';
      try {
        face(env);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, JSON.stringify(Object.keys(env))).not.toBe('');
      expect(message).not.toContain(KEY);
    }
  });

  it('keeps the dev server face in the free sandbox and to admins, with or without the probe', async () => {
    // Without MEDIA_FACE_SANDBOX the key would buy real vendor minutes from a dev server; with audience
    // `everyone` every founder of the local stack would be offered the owner's face. Neither is lab testing.
    const outside = [
      { ...lab, MEDIA_FACE_SANDBOX: 'false' },
      { ...lab, MEDIA_FACE_AUDIENCE: 'everyone' },
      { ...lab, MEDIA_FACE_SANDBOX: 'false', MEDIA_FACE_AUDIENCE: 'everyone' },
    ];
    for (const env of outside) {
      const withoutSandbox = { ...env } as Record<string, string>;
      delete withoutSandbox.MEDIA_FACE_SANDBOX;
      for (const attempt of [env, withoutSandbox]) {
        let message = '';
        const { fetch, seen } = vendor(sandboxRoutes);
        try {
          await face(attempt, fetch).embodiment?.createSession({
            callId: 'c',
            personaId: 'p',
            avatarRef: null,
            maxSeconds: 60,
            requestId: 'r',
          });
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message, JSON.stringify(attempt)).not.toBe('');
        expect(message).not.toContain(KEY);
        expect(seen, 'no vendor call was made').toEqual([]);
      }
    }
  });

  it('sends the key to the vendor only, and records each call by path, status and code', async () => {
    const { fetch, seen } = vendor(sandboxRoutes);
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, fetch);
    await wired.embodiment?.createSession({
      callId: 'c',
      personaId: 'p',
      avatarRef: null,
      maxSeconds: 60,
      requestId: 'r',
    });
    expect(seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(seen[0]?.body).toMatchObject({
      mode: 'FULL',
      is_sandbox: true,
      avatar_id: LIVEAVATAR_SANDBOX_AVATAR,
    });
    const calls = await (await probe(wired, 'GET', 'vendor-calls')).json();
    expect(calls).toEqual({
      items: [
        expect.objectContaining({ method: 'POST', path: '/v1/sessions/token', status: 200, code: 1000 }),
        expect.objectContaining({ method: 'POST', path: '/v1/sessions/start', status: 201, code: 1000 }),
      ],
    });
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(JSON.stringify(calls)).not.toContain('session-token');
  });
});

function probe(
  wired: ReturnType<typeof face>,
  method: string,
  route: string,
  options: { token?: string | null; body?: unknown } = {},
): Promise<Response> {
  const token = options.token === undefined ? TOKEN : options.token;
  const request = new Request(`http://localhost:8787/api/v1/_lab/face/${route}`, {
    method,
    headers: token === null ? {} : { [PROBE_HEADER]: token },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const answer = wired.probe?.handle(request);
  if (answer === null || answer === undefined) throw new Error('not a probe path');
  return answer;
}

describe('the lab probe (vendor checks with the key kept in the dev server)', () => {
  it('answers only its own paths, and only with the run token', async () => {
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, vendor(sandboxRoutes).fetch);
    expect(wired.probe?.handle(new Request('http://localhost:8787/api/v1/health'))).toBeNull();
    expect((await probe(wired, 'GET', 'credits', { token: null })).status).toBe(404);
    expect((await probe(wired, 'GET', 'credits', { token: 'q'.repeat(40) })).status).toBe(404);
    expect((await probe(wired, 'GET', 'nothing-here')).status).toBe(404);
  });

  it('reads the credits: status, code and the balance only', async () => {
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, vendor(sandboxRoutes).fetch);
    expect(await (await probe(wired, 'GET', 'credits')).json()).toEqual({
      status: 200,
      code: 100,
      creditsLeft: '10.00',
    });
  });

  it('opens raw sandbox sessions (never the LITE control channel), reads their transcript and stops them', async () => {
    const { fetch, seen } = vendor(sandboxRoutes);
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, fetch);
    const opened = await probe(wired, 'POST', 'sessions', { body: { mode: 'lite', maxSeconds: 30 } });
    expect(opened.status).toBe(201);
    const session = (await opened.json()) as Record<string, unknown>;
    expect(session).toMatchObject({
      sessionId: 's-1',
      url: 'wss://heygen-feapbkvq.livekit.cloud',
      token: 'client-token',
    });
    expect(JSON.stringify(session)).not.toContain('control.example');
    expect(seen[0]?.body).toMatchObject({
      mode: 'LITE',
      is_sandbox: true,
      avatar_id: LIVEAVATAR_SANDBOX_AVATAR,
    });
    const transcript = await (await probe(wired, 'GET', 'sessions/s-1/transcript')).json();
    expect(transcript).toEqual({
      complete: true,
      lines: [{ role: 'avatar', text: 'Hello there.', at: 1700000000 }],
    });
    expect((await probe(wired, 'POST', 'sessions/s-1/stop')).status).toBe(200);
    expect((await probe(wired, 'POST', 'sessions/s-1/stop')).status).toBe(404);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', body: { session_id: 's-1', reason: 'USER_CLOSED' } });
  });

  it('refuses a session outside the sandbox limits, and a vendor failure as its class name only', async () => {
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, vendor({}).fetch);
    for (const body of [{ mode: 'full', maxSeconds: 5 }, { mode: 'full', maxSeconds: 3600 }, { mode: 'x' }]) {
      expect((await probe(wired, 'POST', 'sessions', { body })).status).toBe(400);
    }
    const failed = await probe(wired, 'POST', 'sessions', { body: { mode: 'full', maxSeconds: 30 } });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'EmbodimentSessionError' });
  });
});

describe('the LITE protocol probe (lite-sessions: the lab drives ws_url itself)', () => {
  it('opens a LITE sandbox session with the control socket and the responses as field names and types only', async () => {
    const { fetch, seen } = vendor(sandboxRoutes);
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, fetch);
    const opened = await probe(wired, 'POST', 'lite-sessions', { body: { maxSeconds: 60 } });
    expect(opened.status).toBe(201);
    const session = (await opened.json()) as Record<string, unknown>;
    expect(session).toMatchObject({
      sessionId: 's-1',
      url: 'wss://heygen-feapbkvq.livekit.cloud',
      token: 'client-token',
      controlUrl: 'wss://control.example/should-stay-on-the-server',
      agentToken: 'agent-token',
      shape: {
        token: { status: 200, code: 1000, fields: { session_id: 'string', session_token: 'string' } },
        start: {
          status: 201,
          code: 1000,
          maxSessionDuration: 60,
          fields: {
            session_id: 'string',
            livekit_url: 'string',
            livekit_client_token: 'string',
            ws_url: 'string',
            max_session_duration: 'number',
          },
        },
      },
    });
    // The shape never carries a value: not the session token, which only the probe itself uses.
    expect(JSON.stringify(session.shape)).not.toContain('session-token');
    expect(JSON.stringify(session.shape)).not.toContain('control.example');
    expect(JSON.stringify(session.shape)).not.toContain('agent-token');
    expect(seen[0]?.url.endsWith('/v1/sessions/token')).toBe(true);
    expect(seen[0]).toMatchObject({
      headers: { 'x-api-key': KEY },
      body: {
        mode: 'LITE',
        is_sandbox: true,
        avatar_id: LIVEAVATAR_SANDBOX_AVATAR,
        max_session_duration: 60,
      },
    });
    expect(seen[1]).toMatchObject({ headers: { authorization: 'Bearer session-token' } });
    expect(seen[1]?.headers['x-api-key']).toBeUndefined();
    // Stopped like any probe session.
    expect((await probe(wired, 'POST', 'sessions/s-1/stop')).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ body: { session_id: 's-1', reason: 'USER_CLOSED' } });
  });

  it('refuses a length outside the sandbox, and stops a started session that came back without ws_url', async () => {
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, vendor(sandboxRoutes).fetch);
    for (const body of [{ maxSeconds: 5 }, { maxSeconds: 61 }, { maxSeconds: '30' }]) {
      expect((await probe(wired, 'POST', 'lite-sessions', { body })).status).toBe(400);
    }
    const start = sandboxRoutes['/v1/sessions/start'];
    const withoutWs = {
      ...sandboxRoutes,
      '/v1/sessions/start': {
        status: 201,
        body: { ...start.body, data: { ...start.body.data, ws_url: undefined } },
      },
    };
    const { fetch, seen } = vendor(withoutWs);
    const broken = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, fetch);
    const failed = await probe(broken, 'POST', 'lite-sessions', { body: { maxSeconds: 30 } });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      error: 'start',
      shape: { start: { status: 201, code: 1000 } },
    });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/v1/sessions/token',
      '/v1/sessions/start',
      '/v1/sessions/stop',
    ]);
    const refused = await probe(
      face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, vendor({}).fetch),
      'POST',
      'lite-sessions',
      {
        body: { maxSeconds: 30 },
      },
    );
    expect(refused.status).toBe(502);
    const answer = (await refused.json()) as { error: string; shape: { token: Record<string, unknown> } };
    expect(answer.error).toBe('token');
    expect(Object.keys(answer.shape)).toEqual(['token']);
    expect(answer.shape.token).toMatchObject({ status: 404, code: null, fields: {} });
    expect(typeof answer.shape.token.ms).toBe('number');
  });

  it('hands over a null agent token when the vendor gave none', async () => {
    const start = sandboxRoutes['/v1/sessions/start'];
    const withoutAgent = {
      ...sandboxRoutes,
      '/v1/sessions/start': {
        status: 201,
        body: { ...start.body, data: { ...start.body.data, livekit_agent_token: undefined } },
      },
    };
    const wired = face({ ...lab, [LAB_FACE_PROBE_TOKEN]: TOKEN }, vendor(withoutAgent).fetch);
    const opened = await probe(wired, 'POST', 'lite-sessions', { body: { maxSeconds: 60 } });
    expect(opened.status).toBe(201);
    expect(((await opened.json()) as { agentToken: unknown }).agentToken).toBeNull();
  });

  it('reduces a response to field names and JSON types', () => {
    expect(
      fieldShape({ a: 'x', b: 1, c: null, d: [1], e: { f: 1 }, g: true, 'bad name': 'x', ünï: 1 }),
    ).toEqual({ a: 'string', b: 'number', c: 'null', d: 'array', e: 'object', g: 'boolean' });
    expect(fieldShape(null)).toEqual({});
    expect(fieldShape(['a'])).toEqual({});
    expect(fieldShape('text')).toEqual({});
    expect(
      Object.keys(fieldShape(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])))),
    ).toHaveLength(40);
  });
});

describe('vendor call records', () => {
  it('name the path without ids or query strings', () => {
    expect(vendorPath('https://api.liveavatar.com/v1/sessions/token')).toBe('/v1/sessions/token');
    expect(vendorPath('https://api.liveavatar.com/v1/sessions/keep-alive')).toBe('/v1/sessions/keep-alive');
    expect(vendorPath('https://api.liveavatar.com/v1/sessions/abc-123/transcript?start_timestamp=9')).toBe(
      '/v1/sessions/{id}/transcript',
    );
  });

  it('keep the status and envelope code, and a network failure as no status', async () => {
    const calls: VendorCall[] = [];
    const ok = recordingFetch(() => Promise.resolve(new Response('{"code":100}', { status: 200 })), calls);
    await ok('https://api.liveavatar.com/v1/sessions/stop', { method: 'POST' });
    const broken = recordingFetch(() => Promise.reject(new TypeError('offline')), calls);
    await expect(broken('https://api.liveavatar.com/v1/users/credits')).rejects.toThrow(TypeError);
    expect(calls.map(({ method, path, status, code }) => ({ method, path, status, code }))).toEqual([
      { method: 'POST', path: '/v1/sessions/stop', status: 200, code: 100 },
      { method: 'GET', path: '/v1/users/credits', status: null, code: null },
    ]);
  });
});
