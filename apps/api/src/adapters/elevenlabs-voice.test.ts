import { type VerifiedSpeechUnit } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { ElevenLabsVoice } from './elevenlabs-voice.js';

/** The error a promise rejects with (fails the test when it resolves). */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

const KEY = 'xi-test-api-key';
const unit = {
  sessionId: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  turnId: null,
  seq: 0,
  text: 'Hi Maya. What would you like to work on?',
  sig: 'su1.k1.AAAA',
} as unknown as VerifiedSpeechUnit;

interface Sent {
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** A recorded vendor answer: status and audio bytes (or the vendor's error body). */
function vendor(status: number, bytes = new Uint8Array([0xff, 0xf3, 0x44, 0xc4])) {
  const sent: Sent[] = [];
  const fetchFn = ((input: string | URL, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    });
    return Promise.resolve(
      status === 200
        ? new Response(bytes, { status, headers: { 'content-type': 'audio/mpeg' } })
        : new Response(
            JSON.stringify({
              detail: { status: 'voice_not_found', message: 'A voice with the voice_id was not found.' },
            }),
            { status },
          ),
    );
  }) as typeof fetch;
  return { fetchFn, sent };
}

function voice(fetchFn: typeof fetch, zeroRetention = false) {
  return new ElevenLabsVoice({
    apiKey: () => Promise.resolve(KEY),
    apiOrigin: 'https://api.elevenlabs.io',
    model: 'eleven_flash_v2_5',
    usdPer1kCharacters: 0.04,
    zeroRetention,
    fetch: fetchFn,
  });
}

describe('ElevenLabsVoice', () => {
  it('streams MP3 of the verified unit’s words in the persona’s voice, with the key in its header', async () => {
    const { fetchFn, sent } = vendor(200);
    const speech = await voice(fetchFn).synthesize({
      unit,
      voiceRef: 'VoiceClone01',
      format: 'mp3',
      requestId: 'req-1',
    });
    const request = sent[0];
    expect(`${request?.url.origin ?? ''}${request?.url.pathname ?? ''}`).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/VoiceClone01/stream',
    );
    expect(request?.url.searchParams.get('output_format')).toBe('mp3_44100_128');
    expect(request?.url.searchParams.has('enable_logging')).toBe(false);
    expect(request?.headers['xi-api-key']).toBe(KEY);
    expect(request?.url.toString()).not.toContain(KEY);
    expect(request?.body).toEqual({ text: unit.text, model_id: 'eleven_flash_v2_5' });
    expect(speech).toMatchObject({
      contentType: 'audio/mpeg',
      engine: 'clone',
      voiceId: 'VoiceClone01',
      characters: unit.text.length,
    });
    expect(new Uint8Array(await new Response(speech.audio).arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xf3, 0x44, 0xc4]),
    );
  });

  it('asks for 24 kHz PCM for a face, and zero retention when the account has it', async () => {
    const { fetchFn, sent } = vendor(200, new Uint8Array(480));
    const speech = await voice(fetchFn, true).synthesize({
      unit,
      voiceRef: 'VoiceClone01',
      format: 'pcm_24000',
      requestId: 'req-1',
    });
    expect(sent[0]?.url.searchParams.get('output_format')).toBe('pcm_24000');
    expect(sent[0]?.url.searchParams.get('enable_logging')).toBe('false');
    expect(speech).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 24_000 });
  });

  it('fails with the status only (never the words or the key), and escapes the voice id', async () => {
    const { fetchFn, sent } = vendor(404);
    const err = await failure(
      voice(fetchFn).synthesize({ unit, voiceRef: 'a/../b', format: 'mp3', requestId: 'req-1' }),
    );
    expect(err).toMatchObject({ name: 'SpeechSynthesisError', message: 'elevenlabs 404' });
    expect(err.message).not.toContain(unit.text);
    expect(sent[0]?.url.pathname).toBe('/v1/text-to-speech/a%2F..%2Fb/stream');
    const unreachable = voice(() => Promise.reject(new TypeError('network down')));
    await expect(
      unreachable.synthesize({ unit, voiceRef: 'VoiceClone01', format: 'mp3', requestId: 'req-1' }),
    ).rejects.toThrow('elevenlabs unreachable');
  });
});
