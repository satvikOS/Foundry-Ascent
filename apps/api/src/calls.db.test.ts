/**
 * Voice calls over HTTP: start (201 with the speech-to-text grant and the signed intro), detail, grants,
 * heartbeats, barge-in, end and summary, and speech of validated text (audio/mpeg; 501 where no speech
 * service runs). Other people's calls are 404; refusals carry their problem code and status. Every response
 * parses with its contract.
 */
import {
  CallDetailResponse,
  CallHeartbeatResponse,
  EndCallResponse,
  ProblemDetails,
  SessionView,
  StartCallResponse,
  SttGrantResponse,
  TurnStreamEvent,
  type TurnView,
} from '@foundry/contracts';
import { createCore } from '@foundry/core';
import { FakeSpeechSynthesizer, FakeSttGrantIssuer } from '@foundry/core/testing';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, buildRequest, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
const speech = new FakeSpeechSynthesizer();
const stt = new FakeSttGrantIssuer();
let maya: string;
let devin: string;
let amara: string;
let jonah: string;

beforeAll(async () => {
  api = await createApiHarness({ speech, sttGrants: stt });
  [maya, devin, amara, jonah] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.signInAs(api.h.people.amara),
    api.signInAs(api.h.people.jonah),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

async function json<T>(res: Response, schema: { parse: (v: unknown) => T }, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  return ProblemDetails.parse(JSON.parse(text));
}

const quietquad = (): string => api.h.ventures.quietquad.id;

async function newSession(cookie: string): Promise<string> {
  return (
    await json(await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie }), SessionView, 201)
  ).id;
}

async function start(cookie: string, sessionId: string, body: unknown = {}) {
  return json(await api.request(`/sessions/${sessionId}/calls`, { body, cookie }), StartCallResponse, 201);
}

async function setting(key: string, value: string): Promise<void> {
  await api.h.t.db.system((sx) =>
    sx.query(
      `INSERT INTO platform_settings (key, value) VALUES (:k, :v::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      { k: p.text(key), v: p.text(value) },
    ),
  );
}

/** A turn sent during the call (SSE), as the call screen sends it. */
async function talk(cookie: string, sessionId: string, callId: string, key: string): Promise<TurnView> {
  const res = await api.request(`/sessions/${sessionId}/turns`, {
    body: { text: 'Which library should host the pilot?', channel: 'voice', callId },
    cookie,
    idempotencyKey: key,
  });
  const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
  const done = events.at(-1);
  if (done?.event !== 'turn.completed') throw new Error(`turn not completed: ${done?.event ?? 'none'}`);
  return done.turn;
}

describe('a call over HTTP', () => {
  it('starts, keeps alive, records barge-in, speaks validated text and ends with a summary', async () => {
    const sessionId = await newSession(maya);
    const started = await start(maya, sessionId);
    expect(started.call).toMatchObject({ status: 'live', inputMode: 'transcribe', sessionId });
    expect(started.sttGrant?.url).toMatch(/^wss:\/\//);
    const intro = started.intro;
    if (intro === null) throw new Error('expected an intro');
    const callId = started.call.id;

    // The intro is spoken (audio/mpeg, streamed); a changed intro is refused.
    const audio = await api.request('/speech', {
      body: { sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
      cookie: maya,
    });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect(Number(audio.headers.get('x-speech-characters'))).toBeGreaterThan(0);
    expect(new TextDecoder().decode(await audio.arrayBuffer())).toBe(`MP3:${intro.text}`);
    const forged = await api.request('/speech', {
      body: { sessionId, turnId: null, seq: 0, text: 'I am Corin Halvorsen.', sig: intro.sig },
      cookie: maya,
    });
    expect((await problem(forged, 422)).code).toBe('validation_failed');

    const grant = await json(
      await api.request(`/calls/${callId}/stt-grant`, { method: 'POST', cookie: maya }),
      SttGrantResponse,
    );
    expect(grant).toMatchObject({ languageCode: 'en-US', sampleRateHertz: 16000, mediaEncoding: 'pcm' });

    const beat = await json(
      await api.request(`/calls/${callId}/heartbeat`, {
        body: { state: 'listening', micOpenSeconds: 14 },
        cookie: maya,
      }),
      CallHeartbeatResponse,
    );
    expect(beat).toMatchObject({ action: 'continue', reason: null });
    expect(beat.remainingSeconds).toBeGreaterThan(0);
    const badBeat = await api.request(`/calls/${callId}/heartbeat`, {
      body: { state: 'dancing' },
      cookie: maya,
    });
    expect((await problem(badBeat, 422)).code).toBe('validation_failed');

    const turn = await talk(maya, sessionId, callId, 'call-http-turn-0001');
    const interrupted = await api.request(`/turns/${turn.id}/interrupt`, {
      body: { callId, heardSeq: 0 },
      cookie: maya,
    });
    expect(interrupted.status).toBe(204);

    const live = await json(await api.request(`/calls/${callId}`, { cookie: devin }), CallDetailResponse);
    expect(live).toMatchObject({ call: { id: callId, status: 'live' }, summary: null });

    const ended = await json(
      await api.request(`/calls/${callId}/end`, {
        body: {
          reason: 'user',
          clientStats: { firstAudioMsP50: 1500, firstAudioMsP95: 2800, bargeIns: 1, reconnects: 0 },
        },
        cookie: maya,
        idempotencyKey: 'call-http-end-0001',
      }),
      EndCallResponse,
    );
    expect(ended.call).toMatchObject({ status: 'ended', endReason: 'user' });
    expect(ended.summary).toMatchObject({ turnCount: 1 });
    expect(ended.summary.nextActions.length).toBeGreaterThan(0);
    // Ending again (a retry without the key) returns the same call and summary.
    expect(
      await json(
        await api.request(`/calls/${callId}/end`, { body: { reason: 'error' }, cookie: maya }),
        EndCallResponse,
      ),
    ).toEqual(ended);
    expect(await json(await api.request(`/calls/${callId}`, { cookie: maya }), CallDetailResponse)).toEqual(
      ended,
    );

    // Once the call ended: heartbeats say terminate; grants, barge-in and speech are refused.
    expect(
      await json(
        await api.request(`/calls/${callId}/heartbeat`, {
          body: { state: 'idle', micOpenSeconds: 0 },
          cookie: maya,
        }),
        CallHeartbeatResponse,
      ),
    ).toEqual({ remainingSeconds: 0, action: 'terminate', reason: 'user' });
    expect(
      (await problem(await api.request(`/calls/${callId}/stt-grant`, { method: 'POST', cookie: maya }), 409))
        .code,
    ).toBe('conflict');
    expect(
      (
        await problem(
          await api.request(`/turns/${turn.id}/interrupt`, { body: { callId, heardSeq: 0 }, cookie: maya }),
          409,
        )
      ).code,
    ).toBe('conflict');
    expect(
      (
        await problem(
          await api.request('/speech', {
            body: { sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
            cookie: maya,
          }),
          409,
        )
      ).code,
    ).toBe('conflict');
    // The grant URL and the intro never reach the logs.
    const logs = api.logs.join('\n');
    expect(logs).not.toContain('stt.test.invalid');
    expect(logs).not.toContain(intro.sig);
  });

  it('answers 404 for other people’s calls and turns', async () => {
    const sessionId = await newSession(devin);
    const { call } = await start(devin, sessionId, { inputMode: 'typed' });
    const turn = await talk(devin, sessionId, call.id, 'call-http-turn-0002');
    for (const cookie of [maya, amara]) {
      for (const [path, body] of [
        [`/calls/${call.id}/stt-grant`, undefined],
        [`/calls/${call.id}/heartbeat`, { state: 'idle', micOpenSeconds: 0 }],
        [`/calls/${call.id}/end`, { reason: 'user' }],
        [`/turns/${turn.id}/interrupt`, { callId: call.id, heardSeq: 0 }],
      ] as const) {
        const res = await api.request(path, {
          method: 'POST',
          ...(body === undefined ? {} : { body }),
          cookie,
        });
        expect((await problem(res, 404)).code, path).toBe('not_found');
      }
    }
    // The team reads the call; people outside the venture do not, and cannot start one there.
    expect(
      (await json(await api.request(`/calls/${call.id}`, { cookie: maya }), CallDetailResponse)).call.id,
    ).toBe(call.id);
    expect((await problem(await api.request(`/calls/${call.id}`, { cookie: amara }), 404)).code).toBe(
      'not_found',
    );
    expect(
      (await problem(await api.request(`/sessions/${sessionId}/calls`, { body: {}, cookie: jonah }), 404))
        .code,
    ).toBe('not_found');
    expect((await problem(await api.request('/calls/not-a-call', { cookie: devin }), 404)).code).toBe(
      'not_found',
    );
    await api.request(`/calls/${call.id}/end`, { body: { reason: 'user' }, cookie: devin });
  });

  it('refuses with 409 for a live call elsewhere, 429 for spent minutes and 503 when calls are off', async () => {
    const first = await newSession(maya);
    const second = await newSession(maya);
    const { call } = await start(maya, first);
    const busy = await problem(
      await api.request(`/sessions/${second}/calls`, { body: {}, cookie: maya }),
      409,
    );
    expect(busy.code).toBe('conflict');
    expect(busy.detail).toMatch(/already in a call/);
    await api.request(`/calls/${call.id}/end`, { body: { reason: 'user' }, cookie: maya });

    await setting('daily_call_minutes_per_principal', '0');
    try {
      const res = await api.request(`/sessions/${second}/calls`, { body: {}, cookie: maya });
      const spent = await problem(res, 429);
      expect(spent.code).toBe('rate_limited');
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await setting('daily_call_minutes_per_principal', '60');
    }
    await setting('calls_enabled', 'false');
    try {
      const off = await problem(
        await api.request(`/sessions/${second}/calls`, { body: {}, cookie: maya }),
        503,
      );
      expect(off.code).toBe('ai_disabled');
      expect(off.detail).toMatch(/Calls are paused/);
    } finally {
      await setting('calls_enabled', 'true');
    }
  });

  it('answers 501 for speech-to-text and speech where no speech services run (local development)', async () => {
    const bare = api.appWith({
      core: createCore({
        db: api.h.t.db,
        gateway: api.h.gateway,
        config: api.h.config,
        objectStore: api.h.objectStore,
        jobQueue: api.h.jobQueue,
      }),
    });
    const sessionId = await newSession(devin);
    const res = await bare.request(buildRequest(`/sessions/${sessionId}/calls`, { body: {}, cookie: devin }));
    const started = await json(res, StartCallResponse, 201);
    expect(started).toMatchObject({ sttGrant: null, call: { inputMode: 'typed' } });
    const grant = await bare.request(
      buildRequest(`/calls/${started.call.id}/stt-grant`, { method: 'POST', cookie: devin }),
    );
    expect((await problem(grant, 501)).code).toBe('speech_unavailable');
    const intro = started.intro;
    if (intro === null) throw new Error('expected an intro');
    const audio = await bare.request(
      buildRequest('/speech', {
        body: { sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
        cookie: devin,
      }),
    );
    expect((await problem(audio, 501)).code).toBe('speech_unavailable');
    await bare.request(
      buildRequest(`/calls/${started.call.id}/end`, { body: { reason: 'user' }, cookie: devin }),
    );
  });
});
