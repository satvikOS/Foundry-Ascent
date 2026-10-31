import { type VerifiedFaceAudio } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import fixtures from './fixtures/liveavatar.json' with { type: 'json' };
import {
  vendorDetailOf,
  type FaceSocket,
  HeygenLiveAvatarFace,
  LIVEAVATAR_SANDBOX_AVATAR,
} from './heygen-liveavatar.js';

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

type Frame = Record<string, unknown>;

/** The vendor's acknowledgement of each command (docs.liveavatar.com, LITE mode events). */
const ACKS: Record<string, string> = {
  'agent.speak': 'agent.audio_buffer_appended',
  'agent.speak_end': 'agent.audio_buffer_committed',
  'agent.interrupt': 'agent.audio_buffer_cleared',
};

/**
 * A control channel that behaves like LiveAvatar's: it opens (or refuses), reports the session `connected`
 * (at once, or when the test says), acknowledges each command with `source_event_id` (unless `reply` answers
 * otherwise, or holds it), and records what was sent and when it was closed.
 */
function socket(
  options: {
    refuse?: boolean;
    connect?: 'auto' | 'manual';
    /** Server events for a command: undefined for the usual acknowledgement, [] to hold it. */
    reply?: (frame: Frame) => Frame[] | undefined;
  } = {},
) {
  const frames: Frame[] = [];
  const opened: string[] = [];
  let closed = 0;
  let sentBeforeConnected = 0;
  let isConnected = false;
  let emit: (event: Frame) => void = () => undefined;
  let emitClose: () => void = () => undefined;
  const open = (url: string): FaceSocket => {
    opened.push(url);
    const listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};
    const fire = (type: string, data?: unknown) => {
      for (const fn of listeners[type] ?? []) fn({ data });
    };
    emit = (event) => {
      if (event.type === 'session.state_updated' && event.state === 'connected') isConnected = true;
      fire('message', JSON.stringify(event));
    };
    emitClose = () => {
      fire('close');
    };
    queueMicrotask(() => {
      if (options.refuse) {
        fire('error');
        return;
      }
      fire('open');
      if ((options.connect ?? 'auto') === 'auto') {
        queueMicrotask(() => {
          emit({
            type: 'session.state_updated',
            event_id: 'srv-0',
            source_event_id: null,
            state: 'connected',
          });
        });
      }
    });
    return {
      readyState: 1,
      send: (data: string) => {
        const frame = JSON.parse(data) as Frame;
        frames.push(frame);
        if (!isConnected) sentBeforeConnected += 1;
        const answer = options.reply?.(frame) ?? [
          {
            type: ACKS[String(frame.type)],
            event_id: `ack-${String(frames.length)}`,
            source_event_id: frame.event_id,
          },
        ];
        queueMicrotask(() => {
          for (const event of answer) emit(event);
        });
      },
      close: () => {
        closed += 1;
      },
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        (listeners[type] ??= []).push(listener);
      },
    };
  };
  return {
    open,
    frames,
    opened,
    closed: () => closed,
    sentBeforeConnected: () => sentBeforeConnected,
    connect: () => {
      emit({ type: 'session.state_updated', event_id: 'srv-0', source_event_id: null, state: 'connected' });
    },
    emit: (event: Frame) => {
      emit(event);
    },
    drop: () => {
      emitClose();
    },
  };
}

/** Lets queued microtasks and timers of 0 ms run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

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

function adapter(
  fetchFn: typeof fetch,
  open = socket().open,
  sandbox = false,
  timeouts: { connectMs?: number; ackMs?: number } = {},
) {
  let n = 0;
  return new HeygenLiveAvatarFace({
    apiKey: () => Promise.resolve(KEY),
    apiOrigin: 'https://api.liveavatar.com',
    sandbox,
    usdPerMinute: 0.093,
    fetch: fetchFn,
    openSocket: open,
    ids: () => {
      n += 1;
      return `evt-${String(n)}`;
    },
    timeouts,
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

  it('starts no session at all when the vendor refuses the per-call limit (never one without a limit)', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/token': [f('tokenLimitRefused'), f('token')],
      '/v1/sessions/start': [f('start')],
    });
    await expect(adapter(fetchFn).createSession(request)).rejects.toThrow('liveavatar token 422');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toHaveProperty('max_session_duration', 900);
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
  const handle = {
    sessionRef: 'sess-1',
    control: 'wss://control.test.invalid/ws?t=secret-control',
    requestId: 'req-2',
  };
  const audio = (bytes: number, last: boolean) =>
    ({
      pcm: new Uint8Array(bytes).fill(1),
      utterance: 'intro',
      first: true,
      last,
    }) as unknown as VerifiedFaceAudio;
  const SECOND = 48_000;

  it('sends nothing until the vendor reports the session connected', async () => {
    const control = socket({ connect: 'manual' });
    let done = false;
    const speaking = adapter(vendor({}).fetchFn, control.open)
      .speak(handle, audio(SECOND, true))
      .then(() => {
        done = true;
      });
    await settle();
    expect(control.opened).toEqual([handle.control]);
    expect(control.frames).toEqual([]);
    expect(done).toBe(false);
    control.connect();
    await speaking;
    expect(control.sentBeforeConnected()).toBe(0);
    expect(control.frames.map((frame) => frame.type)).toEqual(['agent.speak', 'agent.speak_end']);
  });

  it('speaks in one-second chunks and closes only once the vendor has committed the utterance', async () => {
    const commits: Frame[] = [];
    const control = socket({
      reply: (frame) => {
        if (frame.type !== 'agent.speak_end') return undefined;
        commits.push({
          type: 'agent.audio_buffer_committed',
          event_id: 'srv-9',
          source_event_id: frame.event_id,
        });
        return [];
      },
    });
    let done = false;
    const speaking = adapter(vendor({}).fetchFn, control.open)
      .speak(handle, audio(2.5 * SECOND, true))
      .then(() => {
        done = true;
      });
    await settle();
    const speak = control.frames.filter((frame) => frame.type === 'agent.speak');
    expect(speak.map((frame) => Buffer.from(String(frame.audio), 'base64').length)).toEqual([
      SECOND,
      SECOND,
      SECOND / 2,
    ]);
    // The first chunk's id names the utterance; every command has its own, so each acknowledgement is matched.
    expect(new Set(control.frames.map((frame) => frame.event_id)).size).toBe(control.frames.length);
    expect(control.frames.at(-1)?.type).toBe('agent.speak_end');
    expect(done).toBe(false);
    expect(control.closed()).toBe(0);
    const commit = commits[0];
    if (commit === undefined) throw new Error('no speak_end');
    control.emit(commit);
    await speaking;
    expect(control.closed()).toBe(1);
  });

  it('leaves the utterance open on a part that is not the last, once its audio was taken', async () => {
    const control = socket();
    await adapter(vendor({}).fetchFn, control.open).speak(handle, audio(SECOND, false));
    expect(control.frames.map((frame) => frame.type)).toEqual(['agent.speak']);
    expect(control.closed()).toBe(1);
  });

  it('fails on the vendor’s error event, without repeating what the vendor said', async () => {
    const control = socket({
      reply: (frame) =>
        frame.type === 'agent.speak'
          ? [
              {
                type: 'error',
                event_id: 'srv-1',
                source_event_id: frame.event_id,
                error: {
                  type: 'invalid_request_error',
                  message: `bad ${handle.control}`,
                  event_id: frame.event_id,
                },
              },
            ]
          : undefined,
    });
    const refused = await failure(
      adapter(vendor({}).fetchFn, control.open).speak(handle, audio(SECOND, true)),
    );
    expect(refused.message).toBe('liveavatar control invalid_request_error');
    expect(refused.message).not.toContain('secret');
    expect(control.closed()).toBe(1);
  });

  it('gives up when the session never connects, or the channel closes before the vendor took the audio', async () => {
    const silent = socket({ connect: 'manual' });
    await expect(
      adapter(vendor({}).fetchFn, silent.open, false, { connectMs: 20 }).speak(handle, audio(SECOND, true)),
    ).rejects.toThrow('liveavatar control channel not connected');
    expect(silent.frames).toEqual([]);
    expect(silent.closed()).toBe(1);

    const dropped = socket({ reply: () => [] });
    const speaking = adapter(vendor({}).fetchFn, dropped.open).speak(handle, audio(SECOND, true));
    await settle();
    dropped.drop();
    await expect(speaking).rejects.toThrow('liveavatar control channel lost');

    const slow = socket({ reply: () => [] });
    await expect(
      adapter(vendor({}).fetchFn, slow.open, false, { ackMs: 20 }).speak(handle, audio(SECOND, true)),
    ).rejects.toThrow('liveavatar control channel timed out');
  });

  it('interrupts on barge-in once connected, and waits for the vendor to clear its buffer', async () => {
    const control = socket();
    await adapter(vendor({}).fetchFn, control.open).interrupt(handle);
    expect(control.frames).toEqual([{ type: 'agent.interrupt', event_id: 'evt-1' }]);
    expect(control.sentBeforeConnected()).toBe(0);
    expect(control.closed()).toBe(1);
  });

  it('fails when the channel refuses, or there is none', async () => {
    await expect(
      adapter(vendor({}).fetchFn, socket({ refuse: true }).open).speak(handle, audio(SECOND, true)),
    ).rejects.toThrow(/control channel refused/);
    await expect(
      adapter(vendor({}).fetchFn).speak({ ...handle, control: null }, audio(SECOND, true)),
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

describe('HeygenLiveAvatarFace: a FULL session (a stock avatar with its stock voice)', () => {
  const STOCK = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
  const VOICE = '2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e';
  function fullAdapter(
    fetchFn: typeof fetch,
    options: { sandbox?: boolean; voiceId?: string | null; avatarId?: string | null } = {},
  ) {
    return new HeygenLiveAvatarFace({
      apiKey: () => Promise.resolve(KEY),
      apiOrigin: 'https://api.liveavatar.com',
      sandbox: options.sandbox ?? false,
      mode: 'full',
      stock: {
        avatarId: options.avatarId === undefined ? STOCK : options.avatarId,
        voiceId: options.voiceId ?? null,
      },
      adminsOnly: true,
      usdPerMinute: 0.19,
      fetch: fetchFn,
      openSocket: () => {
        throw new Error('FULL never opens a control channel');
      },
    });
  }

  it('is a stock face that voices text, for admins only, and no one’s likeness', () => {
    const face = fullAdapter(vendor({}).fetchFn);
    expect(face).toMatchObject({
      id: 'heygen',
      mode: 'full',
      voicing: 'text',
      likeness: false,
      stock: true,
      adminsOnly: true,
      usdPerMinute: 0.19,
    });
    expect(adapter(vendor({}).fetchFn)).toMatchObject({
      mode: 'lite',
      voicing: 'audio',
      likeness: true,
      stock: false,
    });
  });

  it('asks for the stock avatar in restricted push-to-talk mode, 720p, at most 20 minutes, with no context', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/token': [f('fullToken')],
      '/v1/sessions/start': [f('fullStart')],
    });
    const started = await fullAdapter(fetchFn, { voiceId: VOICE }).createSession({
      ...request,
      avatarRef: null,
      maxSeconds: 1800,
    });
    expect(sent[0]?.body).toEqual({
      mode: 'FULL',
      avatar_id: STOCK,
      video_settings: { quality: 'high', encoding: 'H264' },
      avatar_persona: { voice_id: VOICE, language: 'en' },
      interactivity_type: 'PUSH_TO_TALK',
      max_session_duration: 1200,
    });
    expect(JSON.stringify(sent[0]?.body)).not.toContain('context_id');
    // No `ws_url` in FULL, and none is needed: the browser commands the room. Code 100 is success too.
    expect(started).toMatchObject({
      sessionRef: '7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c',
      control: null,
      browser: {
        token: 'eyJhbGciOiJIUzI1NiJ9.full.client.token',
        url: 'wss://heygen-feapbkvq.livekit.cloud',
      },
    });
  });

  it('uses the avatar’s default voice when none is named, the sandbox avatar in sandbox, and the call’s shorter limit', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/token': [f('fullToken'), f('fullToken')],
      '/v1/sessions/start': [f('fullStart'), f('fullStart')],
    });
    await fullAdapter(fetchFn).createSession({ ...request, avatarRef: 'ignored', maxSeconds: 300 });
    expect(sent[0]?.body).toMatchObject({
      avatar_id: STOCK,
      avatar_persona: { language: 'en' },
      max_session_duration: 300,
    });
    expect(sent[0]?.body?.avatar_persona).not.toHaveProperty('voice_id');
    await fullAdapter(fetchFn, { sandbox: true, avatarId: null }).createSession({
      ...request,
      avatarRef: null,
    });
    expect(sent[2]?.body).toMatchObject({
      avatar_id: LIVEAVATAR_SANDBOX_AVATAR,
      is_sandbox: true,
      mode: 'FULL',
    });
    // Outside the sandbox a FULL face without a stock avatar starts nothing (and never calls the vendor).
    const none = vendor({});
    await expect(
      fullAdapter(none.fetchFn, { avatarId: null }).createSession({ ...request, avatarRef: null }),
    ).rejects.toThrow('liveavatar needs an avatar');
    expect(none.sent).toHaveLength(0);
  });

  it('still requires the speak channel in LITE, while FULL starts without one', async () => {
    const half = f('start');
    (half.body as { data: { ws_url?: string } }).data.ws_url = undefined;
    const lite = vendor({
      '/v1/sessions/token': [f('token')],
      '/v1/sessions/start': [half],
      '/v1/sessions/stop': [f('ok')],
    });
    await expect(adapter(lite.fetchFn).createSession(request)).rejects.toThrow(/liveavatar start/);
    const refused = f('fullStart');
    (refused.body as { code: number }).code = 4020;
    const full = vendor({ '/v1/sessions/token': [f('fullToken')], '/v1/sessions/start': [refused] });
    await expect(fullAdapter(full.fetchFn).createSession(request)).rejects.toThrow(/liveavatar start/);
  });

  it('keeps alive and stops with the API key, never opens a socket, and interrupts nothing server-side', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/keep-alive': [f('fullKeepAlive')],
      '/v1/sessions/stop': [f('fullStop')],
    });
    const face = fullAdapter(fetchFn);
    const handle = { sessionRef: '7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c', control: null, requestId: 'r' };
    await face.keepAlive(handle);
    await face.interrupt(handle);
    await face.end(handle);
    expect(sent.map((s) => s.url)).toEqual([
      'https://api.liveavatar.com/v1/sessions/keep-alive',
      'https://api.liveavatar.com/v1/sessions/stop',
    ]);
    expect(sent.every((s) => s.headers['x-api-key'] === KEY)).toBe(true);
    await expect(
      face.speak(handle, {
        pcm: new Uint8Array(2),
        utterance: 'intro',
        first: true,
        last: true,
      } as unknown as VerifiedFaceAudio),
    ).rejects.toThrow('liveavatar has no control channel');
  });

  it('reads the transcript page by page with the API key, each line once, skipping what it cannot read', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c/transcript': [
        f('transcriptPage1'),
        f('transcriptPage2'),
        f('transcriptEnd'),
      ],
    });
    const read = await fullAdapter(fetchFn).transcriptSince(
      { sessionRef: '7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c', control: null, requestId: 'r' },
      null,
    );
    expect(read).toEqual({
      complete: true,
      lines: [
        { role: 'avatar', text: 'Hi Maya, what are we testing this week?', at: 1761900004 },
        { role: 'user', text: '', at: 1761900008 },
        { role: 'avatar', text: 'Start with the riskiest assumption.', at: 1761900012 },
        { role: 'avatar', text: 'Then test it this week.', at: 1761900020 },
      ],
    });
    expect(sent.map((s) => s.url)).toEqual([
      'https://api.liveavatar.com/v1/sessions/7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c/transcript',
      'https://api.liveavatar.com/v1/sessions/7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c/transcript?start_timestamp=1761900012',
      'https://api.liveavatar.com/v1/sessions/7a0d2b3f-4c5e-4f60-9b1c-1d2e3f4a5b6c/transcript?start_timestamp=1761900020',
    ]);
    expect(sent.every((s) => s.method === 'GET' && s.headers['x-api-key'] === KEY)).toBe(true);
  });

  /** A transcript page at the vendor: `[timestamp, words]` lines and the page's `next_timestamp`. */
  const transcriptPage = (next: number | null, lines: readonly (readonly [number, string])[]): Fixture => ({
    status: 200,
    body: {
      code: 100,
      data: {
        session_active: true,
        next_timestamp: next,
        transcript_data: lines.map(([at, transcript]) => ({
          role: 'avatar',
          transcript,
          absolute_timestamp: at,
        })),
      },
      message: 'success',
    },
  });
  const SESSION = { sessionRef: 's', control: null, requestId: 'r' };

  it('says the transcript was not read to its end when one check reaches its page limit', async () => {
    // A page per second, without end; words nobody admitted only after the tenth page.
    const pages = Array.from({ length: 30 }, (_, t) =>
      transcriptPage(t + 1, [[t, t >= 10 ? 'INJECTED WORDS' : 'Admitted sentence.']]),
    );
    const { fetchFn } = vendor({ '/v1/sessions/s/transcript': pages });
    const read = await fullAdapter(fetchFn).transcriptSince(SESSION, null);
    expect(read.complete).toBe(false);
    expect(read.lines).toHaveLength(10);
  });

  it('keeps a new line that shares the second of the last line a page ended on, and each repeat', async () => {
    const { fetchFn } = vendor({
      '/v1/sessions/s/transcript': [
        transcriptPage(5, [
          [4, 'Admitted sentence.'],
          [5, 'Admitted sentence.'],
        ]),
        transcriptPage(6, [
          [5, 'Admitted sentence.'],
          [5, 'INJECTED WORDS'],
          [6, 'Admitted sentence.'],
        ]),
        transcriptPage(6, [[6, 'Admitted sentence.']]),
      ],
    });
    const read = await fullAdapter(fetchFn).transcriptSince(SESSION, null);
    expect(read).toEqual({
      complete: true,
      lines: [
        { role: 'avatar', text: 'Admitted sentence.', at: 4 },
        { role: 'avatar', text: 'Admitted sentence.', at: 5 },
        { role: 'avatar', text: 'INJECTED WORDS', at: 5 },
        { role: 'avatar', text: 'Admitted sentence.', at: 6 },
      ],
    });
  });

  it('reads from a cursor: only lines at or after it', async () => {
    const { fetchFn, sent } = vendor({
      '/v1/sessions/s/transcript': [
        transcriptPage(null, [
          [7, 'Earlier.'],
          [8, 'Later.'],
        ]),
      ],
    });
    const read = await fullAdapter(fetchFn).transcriptSince(SESSION, 7.5);
    expect(read).toEqual({ complete: true, lines: [{ role: 'avatar', text: 'Later.', at: 8 }] });
    expect(sent[0]?.url).toBe('https://api.liveavatar.com/v1/sessions/s/transcript?start_timestamp=7');
  });

  it('fails a transcript it cannot read, without repeating the vendor’s words', async () => {
    const { fetchFn } = vendor({ '/v1/sessions/gone/transcript': [f('transcriptGone')] });
    const err = await failure(
      fullAdapter(fetchFn).transcriptSince({ sessionRef: 'gone', control: null, requestId: 'r' }, 5),
    );
    expect(err).toMatchObject({ name: 'EmbodimentSessionError', message: 'liveavatar transcript 404' });
  });
});

describe('vendorDetailOf: why the vendor refused a token or start request', () => {
  it('keeps the code and the message, and the validation details', () => {
    expect(vendorDetailOf({ code: 4000, message: 'Invalid max_session_duration for your plan' })).toBe(
      'code=4000 | Invalid max_session_duration for your plan',
    );
    expect(
      vendorDetailOf({ detail: [{ loc: ['body', 'avatar_persona', 'voice_id'], msg: 'Field required' }] }),
    ).toBe('body.avatar_persona.voice_id: Field required');
    expect(vendorDetailOf(null)).toBeNull();
    expect(vendorDetailOf({})).toBeNull();
  });

  it('redacts anything shaped like a key or token and caps the length', () => {
    const detail = vendorDetailOf({
      code: 4000,
      message: `bad token tok9ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 for ${'x '.repeat(400)}`,
    });
    expect(detail).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(detail).toContain('[redacted]');
    expect(detail?.length).toBeLessThanOrEqual(300);
  });
});
