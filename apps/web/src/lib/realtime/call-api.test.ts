import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSpeech } from './call-api';

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
