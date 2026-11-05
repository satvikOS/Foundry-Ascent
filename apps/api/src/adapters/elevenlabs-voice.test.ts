import { type VerifiedSpeechUnit, type VoiceSynthesisInput } from '@foundry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function voice(
  fetchFn: typeof fetch,
  zeroRetention = false,
  extra: Partial<ConstructorParameters<typeof ElevenLabsVoice>[0]> = {},
) {
  return new ElevenLabsVoice({
    apiKey: () => Promise.resolve(KEY),
    apiOrigin: 'https://api.elevenlabs.io',
    model: 'eleven_flash_v2_5',
    usdPer1kCharacters: 0.04,
    zeroRetention,
    fetch: fetchFn,
    ...extra,
  });
}

/** A request for the unit's words (as core hands them: spoken form, the verified unit beside them). */
function ask(format: 'mp3' | 'pcm_24000', more: Partial<VoiceSynthesisInput> = {}): VoiceSynthesisInput {
  return { text: unit.text, unit, voiceRef: 'VoiceClone01', format, requestId: 'req-1', ...more };
}

/**
 * A vendor whose audio arrives in parts: the stream's `push` and `fail` are driven by the test, so what the adapter
 * hands on before the vendor finished is observable; aborting the request errors the stream as fetch does.
 */
function streamingVendor(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const signals: AbortSignal[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const fetchFn = ((_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    if (signal) {
      signals.push(signal);
      signal.addEventListener('abort', () => {
        try {
          controller.error(signal.reason);
        } catch {
          /* already closed */
        }
      });
    }
    return Promise.resolve(new Response(body, { status, headers: { 'content-type': 'audio/pcm' } }));
  }) as typeof fetch;
  return {
    fetchFn,
    signals,
    push: (bytes: Uint8Array) => {
      controller.enqueue(bytes);
    },
    end: () => {
      controller.close();
    },
    fail: (err: Error) => {
      controller.error(err);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ElevenLabsVoice', () => {
  it('streams 64 kbps MP3 of the words in the voice asked for, with the key in its header', async () => {
    const { fetchFn, sent } = vendor(200);
    const speech = await voice(fetchFn).synthesize(ask('mp3'));
    const request = sent[0];
    expect(`${request?.url.origin ?? ''}${request?.url.pathname ?? ''}`).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/VoiceClone01/stream',
    );
    expect(request?.url.searchParams.get('output_format')).toBe('mp3_44100_64');
    expect(request?.url.searchParams.has('enable_logging')).toBe(false);
    // Never the deprecated latency knob.
    expect(request?.url.searchParams.has('optimize_streaming_latency')).toBe(false);
    expect(request?.headers['xi-api-key']).toBe(KEY);
    expect(request?.url.toString()).not.toContain(KEY);
    expect(request?.body).toEqual({ text: unit.text, model_id: 'eleven_flash_v2_5', language_code: 'en' });
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

  it('says the words it is handed (spoken form), with the neighbouring units as context only', async () => {
    const { fetchFn, sent } = vendor(200);
    const speech = await voice(fetchFn).synthesize(
      ask('mp3', {
        text: 'We grew twenty-five percent.',
        unit: null,
        previousText: 'Revenue doubled.',
        nextText: 'What changed?',
      }),
    );
    expect(sent[0]?.body).toEqual({
      text: 'We grew twenty-five percent.',
      model_id: 'eleven_flash_v2_5',
      previous_text: 'Revenue doubled.',
      next_text: 'What changed?',
      language_code: 'en',
    });
    // Billed for the words said, never the context.
    expect(speech.characters).toBe('We grew twenty-five percent.'.length);
    await speech.audio.cancel();
  });

  it('enforces English only on models that take it', async () => {
    const { fetchFn, sent } = vendor(200);
    await (await voice(fetchFn, false, { model: 'eleven_flash_v2' }).synthesize(ask('mp3'))).audio.cancel();
    expect(sent[0]?.body).toEqual({ text: unit.text, model_id: 'eleven_flash_v2' });
  });

  it('asks for 24 kHz PCM for a face or a streaming page, and zero retention when the account has it', async () => {
    const { fetchFn, sent } = vendor(200, new Uint8Array(480));
    const speech = await voice(fetchFn, true).synthesize(ask('pcm_24000'));
    expect(sent[0]?.url.searchParams.get('output_format')).toBe('pcm_24000');
    expect(sent[0]?.url.searchParams.get('enable_logging')).toBe('false');
    expect(speech).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 24_000 });
  });

  it('hands audio on as the vendor sends it: the first bytes before the vendor has finished', async () => {
    const v = streamingVendor();
    const pending = voice(v.fetchFn).synthesize(ask('pcm_24000'));
    v.push(new Uint8Array([1, 2, 3, 4]));
    const speech = await pending;
    const reader = speech.audio.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 2, 3, 4]) });
    const second = reader.read();
    v.push(new Uint8Array([5, 6]));
    expect(await second).toEqual({ done: false, value: new Uint8Array([5, 6]) });
    v.end();
    expect((await reader.read()).done).toBe(true);
  });

  it('gives up on a vendor that sends no audio by the first-audio deadline (Polly says the unit instead)', async () => {
    vi.useFakeTimers();
    const v = streamingVendor();
    const pending = failure(
      voice(v.fetchFn, false, { firstAudioTimeoutMs: 500 }).synthesize(ask('pcm_24000')),
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(v.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const err = await pending;
    expect(err).toMatchObject({ name: 'SpeechSynthesisError', message: 'elevenlabs first audio timeout' });
    // The request is abandoned at the vendor too.
    expect(v.signals[0]?.aborted).toBe(true);
  });

  it('keeps streaming past the deadline once the first audio came', async () => {
    vi.useFakeTimers();
    const v = streamingVendor();
    const pending = voice(v.fetchFn, false, { firstAudioTimeoutMs: 500 }).synthesize(ask('pcm_24000'));
    v.push(new Uint8Array([1, 2]));
    const speech = await pending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(v.signals[0]?.aborted).toBe(false);
    const reader = speech.audio.getReader();
    await reader.read();
    const next = reader.read();
    v.push(new Uint8Array([3, 4]));
    expect(await next).toEqual({ done: false, value: new Uint8Array([3, 4]) });
  });

  it('an empty answer is a failure, and a stream that breaks after its first audio errors its reader', async () => {
    const empty = streamingVendor();
    const none = failure(voice(empty.fetchFn).synthesize(ask('pcm_24000')));
    empty.end();
    expect(await none).toMatchObject({
      name: 'SpeechSynthesisError',
      message: 'elevenlabs returned no audio',
    });

    const broken = streamingVendor();
    const pending = voice(broken.fetchFn).synthesize(ask('pcm_24000'));
    broken.push(new Uint8Array([1, 2]));
    const reader = (await pending).audio.getReader();
    await reader.read();
    const next = reader.read();
    broken.fail(new TypeError('terminated'));
    await expect(next).rejects.toThrow('terminated');
  });

  it('the caller’s abort cancels the vendor request at once and stays an abort (no fallback)', async () => {
    const v = streamingVendor();
    const caller = new AbortController();
    const pending = failure(voice(v.fetchFn).synthesize(ask('pcm_24000', { signal: caller.signal })));
    await Promise.resolve();
    caller.abort();
    expect((await pending).name).toBe('AbortError');
    expect(v.signals[0]?.aborted).toBe(true);

    // Mid-stream: cancelling what the adapter handed on cancels the vendor's body.
    const w = streamingVendor();
    const later = new AbortController();
    const started = voice(w.fetchFn).synthesize(ask('pcm_24000', { signal: later.signal }));
    w.push(new Uint8Array([1, 2]));
    const speech = await started;
    const reader = speech.audio.getReader();
    await reader.read();
    later.abort();
    await expect(reader.read()).rejects.toBeDefined();
  });

  it('fails with the status only (never the words or the key), and escapes the voice id', async () => {
    const { fetchFn, sent } = vendor(404);
    const err = await failure(voice(fetchFn).synthesize(ask('mp3', { voiceRef: 'a/../b' })));
    expect(err).toMatchObject({ name: 'SpeechSynthesisError', message: 'elevenlabs 404' });
    expect(err.message).not.toContain(unit.text);
    expect(sent[0]?.url.pathname).toBe('/v1/text-to-speech/a%2F..%2Fb/stream');
    const unreachable = voice(() => Promise.reject(new TypeError('network down')));
    await expect(unreachable.synthesize(ask('mp3'))).rejects.toThrow('elevenlabs unreachable');
    const keyless = voice(vendor(200).fetchFn, false, {
      apiKey: () => Promise.reject(new Error('secret foundry-ascent/media/elevenlabs could not be read')),
    });
    await expect(keyless.synthesize(ask('mp3'))).rejects.toMatchObject({
      name: 'SpeechSynthesisError',
      message: 'elevenlabs key unavailable',
    });
  });

  it('prewarms with a free authenticated request and never rejects', async () => {
    const { fetchFn, sent } = vendor(200);
    await voice(fetchFn).prewarm();
    expect(sent[0]?.url.toString()).toBe('https://api.elevenlabs.io/v1/models');
    expect(sent[0]?.headers['xi-api-key']).toBe(KEY);
    await expect(voice(() => Promise.reject(new TypeError('down'))).prewarm()).resolves.toBeUndefined();
  });
});
