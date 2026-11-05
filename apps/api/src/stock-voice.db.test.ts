/**
 * The ElevenLabs stock voice over HTTP (`POST /speech`), with fake vendors behind the ports: a page that plays PCM
 * as it arrives says so in `accept` and gets raw `audio/pcm` with its rate; an older page gets MP3; a vendor failure
 * is said by Polly in the same response; the call config discloses the voice as an "AI voice".
 */
import { CallConfigResponse, SessionView, StartCallResponse } from '@foundry/contracts';
import { FakeSpeechSynthesizer, FakeVoiceProvider } from '@foundry/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acceptsPcm, SPEECH_SAMPLE_RATE_HEADER } from './routes/veir.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
const polly = new FakeSpeechSynthesizer();
const eleven = new FakeVoiceProvider('elevenlabs', 0.04);
let maya: string;

beforeAll(async () => {
  api = await createApiHarness({
    speech: polly,
    stockVoice: { provider: eleven, voiceRef: 'AaOhDHYJ1XLZk74lXhdE', fallbackVoiceId: 'Matthew' },
  });
  maya = await api.signInAs(api.h.people.maya);
});
afterAll(async () => {
  await api.cleanup();
});

async function introOfNewCall() {
  const session = SessionView.parse(
    await (
      await api.request(`/ventures/${api.h.ventures.quietquad.id}/sessions`, { body: {}, cookie: maya })
    ).json(),
  );
  const started = StartCallResponse.parse(
    await (
      await api.request(`/sessions/${session.id}/calls`, {
        body: { inputMode: 'typed', replace: true },
        cookie: maya,
      })
    ).json(),
  );
  if (started.intro === null) throw new Error('no intro');
  return { sessionId: session.id, ...started.intro };
}

describe('the stock ElevenLabs voice over HTTP', () => {
  it('reads accept for raw PCM, never a refused one', () => {
    expect(acceptsPcm('audio/pcm, audio/mpeg, application/problem+json')).toBe(true);
    expect(acceptsPcm('audio/mpeg, audio/wav, application/problem+json')).toBe(false);
    expect(acceptsPcm('audio/pcm;q=0, audio/mpeg')).toBe(false);
    expect(acceptsPcm('AUDIO/PCM;q=0.5')).toBe(true);
    expect(acceptsPcm(undefined)).toBe(false);
  });

  it('streams raw 24 kHz PCM to a page that plays it as it arrives, MP3 to one that does not', async () => {
    const intro = await introOfNewCall();
    const res = await api.request('/speech', {
      body: { sessionId: intro.sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
      cookie: maya,
      headers: { accept: 'audio/pcm, audio/mpeg, audio/wav, application/problem+json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/pcm');
    expect(res.headers.get(SPEECH_SAMPLE_RATE_HEADER)).toBe('24000');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(eleven.calls.at(-1)).toMatchObject({ format: 'pcm_24000', voiceRef: 'AaOhDHYJ1XLZk74lXhdE' });

    const older = await introOfNewCall();
    const mp3 = await api.request('/speech', {
      body: { sessionId: older.sessionId, turnId: null, seq: 0, text: older.text, sig: older.sig },
      cookie: maya,
      headers: { accept: 'audio/mpeg, audio/wav, application/problem+json' },
    });
    expect(mp3.headers.get('content-type')).toBe('audio/mpeg');
    expect(mp3.headers.get(SPEECH_SAMPLE_RATE_HEADER)).toBeNull();
    await mp3.arrayBuffer();
  });

  it('a vendor failure is said by Polly in the same response, once', async () => {
    const intro = await introOfNewCall();
    eleven.failNext = true;
    const pollyCalls = polly.calls.length;
    const res = await api.request('/speech', {
      body: { sessionId: intro.sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
      cookie: maya,
      headers: { accept: 'audio/pcm, audio/mpeg, application/problem+json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(SPEECH_SAMPLE_RATE_HEADER)).toBe('16000');
    await res.arrayBuffer();
    expect(polly.calls.length).toBe(pollyCalls + 1);
    // Never twice: a replay of the unit is refused.
    const again = await api.request('/speech', {
      body: { sessionId: intro.sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
      cookie: maya,
    });
    expect(again.status).toBe(409);
  });

  it('discloses the voice as an AI voice in the call config', async () => {
    const res = await api.request(`/ventures/${api.h.ventures.quietquad.id}/call-config`, { cookie: maya });
    expect(CallConfigResponse.parse(await res.json()).voice).toEqual({
      vendor: 'elevenlabs',
      label: 'AI voice',
    });
  });
});
