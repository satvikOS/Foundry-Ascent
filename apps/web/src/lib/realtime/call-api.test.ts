import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FACE_CHUNK_BYTES,
  FACE_MANIFEST_HEADER,
  FACE_PART_HEADER,
  fetchSpeech,
  sayFaceText,
  sendFaceAudio,
} from './call-api';

const SESSION = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02';
const TURN = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

/** A problem document as the API sends it (apps/api problemDetails): a code, and a reason the client acts on. */
function problem(status: number, code: string, reason?: string): Response {
  return new Response(
    JSON.stringify({
      type: `urn:foundry-ascent:problem:${code}`,
      title: 'Speech',
      status,
      detail: 'Shown to the founder.',
      code,
      requestId: 'req-1',
      ...(reason === undefined ? {} : { reason }),
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

async function speechOutcome(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  );
  return fetchSpeech(
    SESSION,
    { turnId: TURN, seq: 2, text: 'Twelve is a good start.', sig: 'sig-2-0123456789abcdef' },
    new AbortController().signal,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSpeech: what each answer of POST /speech means for the call', () => {
  it('skips a unit already voiced for this call (409 conflict, reason speech_already_played)', async () => {
    expect(await speechOutcome(problem(409, 'conflict', 'speech_already_played'))).toEqual({
      kind: 'played',
    });
    // The crisis support line already played as often as it may: it stays on screen, never asked again.
    expect(await speechOutcome(problem(409, 'conflict', 'crisis_speech_limit'))).toEqual({ kind: 'played' });
  });

  it('pauses the voice for the rest of the call when a speech budget is used up (429 rate_limited)', async () => {
    expect(await speechOutcome(problem(429, 'rate_limited', 'call_speech_limit'))).toEqual({
      kind: 'paused',
    });
    expect(await speechOutcome(problem(429, 'rate_limited', 'daily_speech_limit'))).toEqual({
      kind: 'paused',
    });
  });

  it('lets the browser read in development only when the server has no speech (501)', async () => {
    expect(await speechOutcome(problem(501, 'speech_unavailable'))).toEqual({ kind: 'unavailable' });
  });

  it('keeps words only for the rest of the call on a known refusal for the call', async () => {
    expect(await speechOutcome(problem(503, 'ai_disabled'))).toEqual({ kind: 'refused' });
    expect(await speechOutcome(problem(429, 'spend_cap_reached'))).toEqual({ kind: 'refused' });
  });

  it('shows the unit as words and asks again next time for anything else, codes it does not know included', async () => {
    expect(await speechOutcome(problem(409, 'conflict', 'call_not_active'))).toEqual({ kind: 'failed' });
    expect(await speechOutcome(problem(429, 'some_future_limit'))).toEqual({ kind: 'failed' });
    expect(await speechOutcome(problem(409, 'something_new'))).toEqual({ kind: 'failed' });
    expect(await speechOutcome(problem(502, 'internal'))).toEqual({ kind: 'failed' });
  });
});

describe('the face of a call over HTTP', () => {
  it('keeps the face-audio manifest POST /speech sent with a unit for the face', async () => {
    const outcome = await speechOutcome(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/wav', [FACE_MANIFEST_HEADER]: 'fa1.k1.payload.mac' },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'audio', faceManifest: 'fa1.k1.payload.mac' });
    const plain = await speechOutcome(new Response(new Uint8Array([1]), { status: 200 }));
    expect(plain).not.toHaveProperty('faceManifest');
  });

  it('hands the face a unit’s exact bytes in parts of at most 18 seconds, each with its manifest, part and hash', async () => {
    const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init: RequestInit) => {
        sent.push({ url: input, headers: new Headers(init.headers), body: init.body as Uint8Array });
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    const pcm = new Uint8Array(FACE_CHUNK_BYTES * 20 + 100).map((_, i) => i % 251);
    await sendFaceAudio('call-1', { pcm, manifest: 'fa1.k1.p.m' }, new AbortController().signal);
    expect(sent.map((s) => s.url)).toEqual([
      '/api/v1/calls/call-1/face/speak',
      '/api/v1/calls/call-1/face/speak',
    ]);
    expect(sent.map((s) => s.headers.get(FACE_PART_HEADER))).toEqual(['0', '18']);
    expect(sent.every((s) => s.headers.get(FACE_MANIFEST_HEADER) === 'fa1.k1.p.m')).toBe(true);
    expect(sent[0]?.headers.get('content-type')).toBe('application/octet-stream');
    expect(sent[0]?.headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]?.body.byteLength).toBe(FACE_CHUNK_BYTES * 18);
    expect(sent[1]?.body).toEqual(pcm.subarray(FACE_CHUNK_BYTES * 18));
  });

  it('asks the server to admit a signed unit for a FULL face, and rejects on a refusal or an unsigned unit', async () => {
    const sent: { url: string; body: unknown }[] = [];
    let answer: Response = new Response(null, { status: 204 });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init: RequestInit) => {
        const raw =
          typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
        sent.push({ url: input, body: JSON.parse(raw) as unknown });
        return Promise.resolve(answer);
      }),
    );
    const unit = { turnId: TURN, seq: 2, text: 'Twelve is a good start.', sig: 'sig-2-0123456789abcdef' };
    await sayFaceText('call-1', unit, new AbortController().signal);
    expect(sent).toEqual([{ url: '/api/v1/calls/call-1/face/say', body: unit }]);
    answer = problem(422, 'validation_failed');
    await expect(sayFaceText('call-1', unit, new AbortController().signal)).rejects.toBeTruthy();
    await expect(
      sayFaceText(
        'call-1',
        { turnId: TURN, seq: 0, text: 'A stored passage.' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('unsigned_unit');
    expect(sent).toHaveLength(2);
  });
});
