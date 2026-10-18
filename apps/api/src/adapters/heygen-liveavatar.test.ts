import { type VerifiedFaceAudio } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import fixtures from './fixtures/liveavatar.json' with { type: 'json' };
import { type FaceSocket, HeygenLiveAvatarFace, LIVEAVATAR_SANDBOX_AVATAR } from './heygen-liveavatar.js';

/** The error a promise rejects with (fails the test when it resolves). */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

interface Fixture {
  readonly status: number;
  readonly body: unknown;
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

/** A fetch answering each path with the next queued fixture, recording every request. */
function vendor(queue: Record<string, Fixture[]>) {
  const sent: Sent[] = [];
  const fetchFn = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const path = new URL(url).pathname;
    const next = queue[path]?.shift();
    if (next === undefined) return Promise.reject(new Error(`unexpected ${path}`));
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  }) as typeof fetch;
  return { fetchFn, sent };
}

/** A control channel that opens (or refuses) and records what was sent. */
function socket(options: { refuse?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  const opened: string[] = [];
  let closed = 0;
  const open = (url: string): FaceSocket => {
    opened.push(url);
    const listeners: Record<string, (() => void)[]> = {};
    queueMicrotask(() => {
      for (const fn of listeners[options.refuse ? 'error' : 'open'] ?? []) fn();
    });
    return {
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
      close: () => {
        closed += 1;
      },
      addEventListener: (type, listener) => {
        (listeners[type] ??= []).push(listener);
      },
    };
  };
  return { open, frames, opened, closed: () => closed };
}

const KEY = 'la-test-api-key';
const request = {
  callId: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  personaId: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
  avatarRef: 'avatar-of-corin',
  maxSeconds: 900,
  requestId: 'req-1',
};
const fx = fixtures as unknown as Record<string, Fixture>;
const f = (name: string): Fixture => {
  const fixture = fx[name];
  if (fixture === undefined) throw new Error(`no fixture ${name}`);
  return structuredClone(fixture);
};

function adapter(fetchFn: typeof fetch, open = socket().open, sandbox = false) {
  return new HeygenLiveAvatarFace({
    apiKey: () => Promise.resolve(KEY),
    apiOrigin: 'https://api.liveavatar.com',
    sandbox,
    usdPerMinute: 0.093,
    fetch: fetchFn,
    openSocket: open,
    ids: () => 'evt-1',
  });
}

describe('HeygenLiveAvatarFace: a LITE session', () => {
  it('asks for a LITE session of the persona’s avatar with the API key, then starts it with the session token', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/token': [f('token')],
      '/v1/sessions/start': [f('start')],
    });
    const started = await adapter(fetchFn).createSession(request);
    expect(sent[0]).toMatchObject({
      url: 'https://api.liveavatar.com/v1/sessions/token',
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: {
        mode: 'LITE',
        avatar_id: 'avatar-of-corin',
        max_session_duration: 900,
        video_settings: { quality: 'high', encoding: 'H264' },
      },
    });
    expect(sent[0]?.body).not.toHaveProperty('is_sandbox');
    // The start call carries the session token, never the API key.
    expect(sent[1]?.headers.authorization).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.session.token');
    expect(sent[1]?.headers['x-api-key']).toBeUndefined();
    // The browser gets the room and its client token; the speak channel stays here.
    expect(started.browser).toMatchObject({
      token: 'eyJhbGciOiJIUzI1NiJ9.client.token',
      url: 'wss://heygen-feapbkvq.livekit.cloud',
    });
    expect(JSON.stringify(started.browser)).not.toContain('secret-control');
    expect(started.control).toContain('secret-control');
    expect(started.sessionRef).toBe('6f9c1a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(Date.parse(started.browser.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('uses the sandbox avatar and flag in sandbox mode', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/token': [f('token')],
      '/v1/sessions/start': [f('start')],
    });
    await adapter(fetchFn, socket().open, true).createSession(request);
    expect(sent[0]?.body).toMatchObject({ avatar_id: LIVEAVATAR_SANDBOX_AVATAR, is_sandbox: true });
  });

  it('asks again without the session limit when the API does not take it there', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/token': [f('tokenUnknownField'), f('token')],
      '/v1/sessions/start': [f('start')],
    });
    await adapter(fetchFn).createSession(request);
    expect(sent[0]?.body).toHaveProperty('max_session_duration');
    expect(sent[1]?.body).not.toHaveProperty('max_session_duration');
  });

  it('fails without leaking the key or a token, and stops a session that started half-way', async () => {
    const bad = vendor({ '/v1/sessions/token': [f('tokenBadKey')] });
    const refused = await failure(adapter(bad.fetchFn).createSession(request));
    expect(refused).toMatchObject({ name: 'EmbodimentSessionError', message: 'liveavatar token 401' });
    expect(refused.message).not.toContain(KEY);

    const half = f('start');
    (half.body as { data: { ws_url?: string } }).data.ws_url = undefined;
    const partial = vendor({
      '/v1/sessions/token': [f('token')],
      '/v1/sessions/start': [half],
      '/v1/sessions/stop': [f('ok')],
    });
    await expect(adapter(partial.fetchFn).createSession(request)).rejects.toThrow(/liveavatar start/);
    expect(partial.sent.at(-1)).toMatchObject({
      url: 'https://api.liveavatar.com/v1/sessions/stop',
      headers: { 'x-api-key': KEY },
      body: { session_id: '6f9c1a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', reason: 'USER_CLOSED' },
    });

    const broke = vendor({ '/v1/sessions/token': [f('token')], '/v1/sessions/start': [f('startNoCredits')] });
    await expect(adapter(broke.fetchFn).createSession(request)).rejects.toThrow('liveavatar start 402');
    await expect(adapter(vendor({}).fetchFn).createSession({ ...request, avatarRef: null })).rejects.toThrow(
      /needs an avatar/,
    );
  });
});

describe('HeygenLiveAvatarFace: the server-held control channel', () => {
  const handle = { sessionRef: 'sess-1', control: 'wss://control.test.invalid/ws?t=1', requestId: 'req-2' };
  const audio = (bytes: number, last: boolean) =>
    ({
      pcm: new Uint8Array(bytes).fill(1),
      utterance: 'intro',
      first: true,
      last,
    }) as unknown as VerifiedFaceAudio;

  it('speaks a unit as 20 ms agent.speak events under one event id, then agent.speak_end', async () => {
    const control = socket();
    await adapter(vendor({}).fetchFn, control.open).speak(handle, audio(2500, true));
    expect(control.opened).toEqual([handle.control]);
    const speak = control.frames.filter((frame) => frame.type === 'agent.speak');
    expect(speak).toHaveLength(3);
    expect(speak.every((frame) => frame.event_id === 'evt-1')).toBe(true);
    expect(Buffer.from(String(speak[0]?.audio), 'base64')).toHaveLength(960);
    expect(Buffer.from(String(speak[2]?.audio), 'base64')).toHaveLength(580);
    expect(control.frames.at(-1)).toEqual({ type: 'agent.speak_end', event_id: 'evt-1' });
    expect(control.closed()).toBe(1);
  });

  it('leaves the utterance open on a part that is not the last, and interrupts on barge-in', async () => {
    const control = socket();
    const face = adapter(vendor({}).fetchFn, control.open);
    await face.speak(handle, audio(960, false));
    expect(control.frames.map((frame) => frame.type)).toEqual(['agent.speak']);
    await face.interrupt(handle);
    expect(control.frames.at(-1)).toEqual({ type: 'agent.interrupt', event_id: 'evt-1' });
  });

  it('fails when the channel refuses, or there is none', async () => {
    await expect(
      adapter(vendor({}).fetchFn, socket({ refuse: true }).open).speak(handle, audio(960, true)),
    ).rejects.toThrow(/control channel refused/);
    await expect(
      adapter(vendor({}).fetchFn).speak({ ...handle, control: null }, audio(960, true)),
    ).rejects.toThrow(/no control channel/);
  });

  it('keeps the session alive and ends it with the API key; a session already gone is not an error', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/keep-alive': [f('ok')],
      '/v1/sessions/stop': [f('stopGone')],
    });
    const face = adapter(fetchFn);
    await face.keepAlive(handle);
    await face.end(handle);
    expect(sent.map((s) => [s.url, s.headers['x-api-key'], s.body?.session_id])).toEqual([
      ['https://api.liveavatar.com/v1/sessions/keep-alive', KEY, 'sess-1'],
      ['https://api.liveavatar.com/v1/sessions/stop', KEY, 'sess-1'],
    ]);
  });
});
