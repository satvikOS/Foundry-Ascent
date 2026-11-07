/**
 * Call recordings over HTTP (ADR-0023): register (201 with presigned PUTs), complete, list, replay (presigned GETs),
 * download (a presigned GET that saves the file under a readable name) and delete (204), for the caller's own call only; a private call is 409 `recording_private_call`, someone else's
 * recording is 404, and the development stand-in for the recordings bucket accepts exactly the signed upload and
 * answers byte ranges. Every response parses with its contract.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CreateRecordingResponse,
  ProblemDetails,
  RecordingListResponse,
  RecordingPlaybackResponse,
  RecordingView,
  SessionView,
  StartCallResponse,
} from '@foundry/contracts';
import { RecordingDownloadResponse } from '@foundry/contracts/recording-files';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalRecordingStore } from './adapters/local-recording-store.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let maya: string;
let devin: string;
let dir: string;

beforeAll(async () => {
  api = await createApiHarness();
  [maya, devin] = await Promise.all([api.signInAs(api.h.people.maya), api.signInAs(api.h.people.devin)]);
  dir = await mkdtemp(join(tmpdir(), 'fa-recordings-routes-'));
});
afterAll(async () => {
  await api.cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function json<T>(res: Response, schema: { parse: (v: unknown) => T }, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return ProblemDetails.parse(JSON.parse(text));
}

const quietquad = (): string => api.h.ventures.quietquad.id;

/** A call of `cookie`'s in a new conversation (private on request), ended. */
async function endedCall(cookie: string, privacy: 'standard' | 'ephemeral' = 'standard'): Promise<string> {
  const session = await json(
    await api.request(`/ventures/${quietquad()}/sessions`, { body: { privacy }, cookie }),
    SessionView,
    201,
  );
  const started = await json(
    await api.request(`/sessions/${session.id}/calls`, { body: { inputMode: 'typed' }, cookie }),
    StartCallResponse,
    201,
  );
  await api.request(`/calls/${started.call.id}/end`, {
    body: { reason: 'user' },
    cookie,
    idempotencyKey: crypto.randomUUID(),
  });
  return started.call.id;
}

const BODY = { mimeType: 'video/webm', bytes: 2_048, durationMs: 9_000, captions: { bytes: 64, cues: 2 } };

describe('call recordings', () => {
  it('registers, completes, lists, replays and deletes the caller’s own recording', async () => {
    const callId = await endedCall(maya);
    const created = await json(
      await api.request(`/calls/${callId}/recordings`, { body: BODY, cookie: maya }),
      CreateRecordingResponse,
      201,
    );
    expect(created.upload.media.method).toBe('PUT');
    expect(created.upload.captions?.headers).toEqual({ 'content-type': 'text/vtt' });
    const [media, captions] = api.h.recordingStore.puts.filter((put) =>
      put.key.includes(created.recording.id),
    );
    api.h.recordingStore.put(media?.key ?? '', BODY.bytes);
    api.h.recordingStore.put(captions?.key ?? '', BODY.captions.bytes);

    const id = created.recording.id;
    const ready = await json(
      await api.request(`/recordings/${id}/complete`, {
        method: 'POST',
        cookie: maya,
        idempotencyKey: crypto.randomUUID(),
      }),
      RecordingView,
    );
    expect(ready.status).toBe('ready');
    const listed = await json(
      await api.request(`/recordings?sessionId=${created.recording.sessionId}`, { cookie: maya }),
      RecordingListResponse,
    );
    expect(listed.items.map((r) => r.id)).toEqual([id]);
    expect(listed.available).toBe(true);
    const replay = await json(
      await api.request(`/recordings/${id}/playback`, { cookie: maya }),
      RecordingPlaybackResponse,
    );
    expect(replay.media.url).toContain('call.webm');
    expect(replay.captions?.url).toContain('captions.vtt');
    const download = await json(
      await api.request(`/recordings/${id}/download?name=Thomas&timeZone=America%2FNew_York`, {
        cookie: maya,
      }),
      RecordingDownloadResponse,
    );
    expect(download.filename).toMatch(/^Thomas call \d{4}-\d\d-\d\d \d\d-\d\d\.webm$/);
    expect(api.h.recordingStore.gets.at(-1)).toMatchObject({
      key: media?.key,
      downloadAs: download.filename,
    });
    const transcript = await json(
      await api.request(`/recordings/${id}/download?file=transcript`, { cookie: maya }),
      RecordingDownloadResponse,
    );
    expect(transcript.filename).toMatch(/^Call .+ transcript\.vtt$/);
    expect(
      (await problem(await api.request(`/recordings/${id}/download?file=everything`, { cookie: maya }), 422))
        .code,
    ).toBe('validation_failed');

    // Devin works on the venture, but the recording is Maya's.
    expect(
      (await problem(await api.request(`/recordings/${id}/playback`, { cookie: devin }), 404)).code,
    ).toBe('not_found');
    expect(
      (await problem(await api.request(`/recordings/${id}/download`, { cookie: devin }), 404)).code,
    ).toBe('not_found');
    expect(
      (
        await json(
          await api.request(`/recordings?sessionId=${created.recording.sessionId}`, { cookie: devin }),
          RecordingListResponse,
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await problem(
          await api.request(`/recordings/${id}`, {
            method: 'DELETE',
            cookie: devin,
            idempotencyKey: crypto.randomUUID(),
          }),
          404,
        )
      ).code,
    ).toBe('not_found');

    const gone = await api.request(`/recordings/${id}`, {
      method: 'DELETE',
      cookie: maya,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(gone.status).toBe(204);
    expect(api.h.recordingStore.deleted.filter((key) => key.includes(id))).toHaveLength(2);
    expect((await problem(await api.request(`/recordings/${id}/playback`, { cookie: maya }), 404)).code).toBe(
      'not_found',
    );
  });

  it('refuses a private call with its public reason, and a body it cannot take', async () => {
    const privateCall = await endedCall(maya, 'ephemeral');
    const refused = await problem(
      await api.request(`/calls/${privateCall}/recordings`, { body: BODY, cookie: maya }),
      409,
    );
    expect(refused).toMatchObject({ code: 'conflict', reason: 'recording_private_call' });
    const callId = await endedCall(maya);
    expect(
      (
        await problem(
          await api.request(`/calls/${callId}/recordings`, {
            body: { ...BODY, mimeType: 'video/ogg' },
            cookie: maya,
          }),
          422,
        )
      ).code,
    ).toBe('validation_failed');
    expect(
      (
        await problem(
          await api.request(`/calls/${callId}/recordings`, {
            body: { ...BODY, bytes: 600 * 1024 * 1024 },
            cookie: maya,
          }),
          422,
        )
      ).code,
    ).toBe('validation_failed');
  });

  it('lists every recording route as authenticated; presigned responses are never replayed', () => {
    const routes = api.app.routeTable.filter((r) => r.path.includes('recordings'));
    expect(routes).toEqual(
      expect.arrayContaining([
        { method: 'POST', path: '/calls/:id/recordings', auth: 'session', idempotency: 'none' },
        { method: 'POST', path: '/recordings/:id/complete', auth: 'session', idempotency: 'standard' },
        { method: 'GET', path: '/recordings', auth: 'session', idempotency: 'none' },
        { method: 'GET', path: '/recordings/:id/playback', auth: 'session', idempotency: 'none' },
        { method: 'GET', path: '/recordings/:id/download', auth: 'session', idempotency: 'none' },
        { method: 'DELETE', path: '/recordings/:id', auth: 'session', idempotency: 'standard' },
      ]),
    );
    expect(routes.some((r) => r.path.startsWith('/_local/'))).toBe(false);
  });
});

describe('PUT|GET /_local/recordings/:token (development only)', () => {
  it('takes exactly the signed upload and serves it back by byte range, with CORS for local origins', async () => {
    const store = new LocalRecordingStore({ directory: dir, origin: 'http://localhost:8787' });
    const app = api.appWith({ appEnv: 'development', localRecordings: store });
    const key = `tenants/${api.h.seed.tenantId}/ventures/${quietquad()}/sessions/${crypto.randomUUID()}/recordings/${crypto.randomUUID()}/call.webm`;
    const upload = await store.presignPut({
      key,
      contentType: 'video/webm',
      contentLength: 6,
      expiresInSeconds: 60,
    });
    const path = new URL(upload.url).pathname;
    const origin = 'http://localhost:5183';
    // A preflight, then the PUT itself (no session cookie or CSRF header: the token is the authorization).
    const preflight = await app.request(
      new Request(`http://localhost${path}`, { method: 'OPTIONS', headers: { origin } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('PUT, GET');
    const wrong = await app.request(
      new Request(`http://localhost${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        body: 'abcdef',
      }),
    );
    expect(wrong.status).toBe(403);
    const put = await app.request(
      new Request(`http://localhost${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'video/webm', origin },
        body: 'abcdef',
      }),
    );
    expect(put.status).toBe(200);
    expect(put.headers.get('access-control-allow-origin')).toBe(origin);

    const replay = await store.presignGet({ key, contentType: 'video/webm', expiresInSeconds: 60 });
    const get = new URL(replay.url).pathname;
    const whole = await app.request(new Request(`http://localhost${get}`, { headers: { origin } }));
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('abcdef');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('access-control-expose-headers')).toContain('content-range');
    const part = await app.request(
      new Request(`http://localhost${get}`, { headers: { range: 'bytes=1-3' } }),
    );
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('bcd');
    expect(part.headers.get('content-range')).toBe('bytes 1-3/6');
    expect(whole.headers.get('content-disposition')).toBeNull();
    expect((await app.request(new Request(`http://localhost${get}x`))).status).toBe(403);

    // A download is the same file, saved under its name.
    const download = await store.presignGet({
      key,
      contentType: 'video/webm',
      expiresInSeconds: 60,
      downloadAs: 'Thomas call 2026-11-07 14-22.webm',
    });
    const saved = await app.request(new Request(`http://localhost${new URL(download.url).pathname}`));
    expect(saved.status).toBe(200);
    expect(await saved.text()).toBe('abcdef');
    expect(saved.headers.get('content-disposition')).toBe(
      `attachment; filename="Thomas call 2026-11-07 14-22.webm"; filename*=UTF-8''Thomas%20call%202026-11-07%2014-22.webm`,
    );
  });

  it('refuses to mount outside development', () => {
    const store = new LocalRecordingStore({ directory: dir, origin: 'http://localhost:8787' });
    expect(() => api.appWith({ appEnv: 'production', localRecordings: store })).toThrow(/development/);
  });
});
