import {
  SpeechSynthesisError,
  type SynthesizedSpeech,
  type VoiceProvider,
  type VoiceSynthesisInput,
} from '@foundry/core';

import { type ApiKeySource } from './media-secrets.js';

/**
 * A vEIR voice through **ElevenLabs** streaming text-to-speech (core `VoiceProvider` port; docs/runbooks/avatars.md,
 * docs/runbooks/elevenlabs-voice.md): the platform's stock voice (an "AI voice", `media.voice.provider:
 * elevenlabs-stock`) and the EIRs' consented clones. Written from the vendor's API reference (checked 2026-11-05);
 * never called in CI (tests use recorded responses and a local stub server).
 *
 * `POST /v1/text-to-speech/{voice_id}/stream?output_format=…` with the API key (`xi-api-key`; Secrets Manager
 * `foundry-ascent/media/elevenlabs`) and `{text, model_id, previous_text?, next_text?, language_code?}`, one request per
 * validated unit (the HTTP streaming path ElevenLabs recommends when the text is complete up front). The words are
 * validated words only (core hands a clone a `VerifiedSpeechUnit`'s words, the stock voice also a passage of a stored
 * reply), already written out for speech (core `speechText`: Flash v2.5 does not normalise numbers itself); the
 * neighbouring units' words go as `previous_text` / `next_text` so sentences join up, and are not billed. Raw 24 kHz
 * PCM for a browser that plays it as it arrives and for a face, MP3 at 64 kbps otherwise (speech needs no more). With
 * zero retention (an Enterprise feature) the request asks the vendor to keep nothing (`enable_logging=false`).
 *
 * The audio streams through as the vendor produces it, once its first bytes arrived: until then the request is held
 * to a first-audio deadline ({@link FIRST_AUDIO_TIMEOUT_MS}), so a slow or failing vendor is given up on in time for
 * Amazon Polly to say the unit instead in the same response (core speech service). Errors carry the status only,
 * never the words or the key.
 */

/** The whole request, its audio included. */
const HTTP_TIMEOUT_MS = 15_000;
/**
 * From the call to the first audio bytes (the key read, the connection, the vendor's time to first byte): past it the
 * request is abandoned as failed and Polly says the unit. ElevenLabs publishes ~100-150 ms for Flash in North America
 * (server side); a cold container adds a key read and a new TLS connection.
 */
export const FIRST_AUDIO_TIMEOUT_MS = 2_000;
/** How long a prewarm request may take before it is abandoned. */
export const PREWARM_TIMEOUT_MS = 3_000;

export interface ElevenLabsVoiceOptions {
  readonly apiKey: ApiKeySource;
  /** `https://api.elevenlabs.io` (packages/core/media-vendors.json). */
  readonly apiOrigin: string;
  /** The model (`MEDIA_VOICE_MODEL`, default `eleven_flash_v2_5`). */
  readonly model: string;
  readonly usdPer1kCharacters: number;
  /** Ask for zero retention (`MEDIA_VOICE_ZERO_RETENTION`; Enterprise accounts only). */
  readonly zeroRetention: boolean;
  /** {@link FIRST_AUDIO_TIMEOUT_MS} unless set (tests). */
  readonly firstAudioTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Models that take `language_code` (ElevenLabs: language enforcement is Turbo v2.5 and Flash v2.5 only). */
const ENFORCES_LANGUAGE = /^eleven_(?:flash|turbo)_v2_5$/;

export class ElevenLabsVoice implements VoiceProvider {
  readonly id = 'elevenlabs' as const;
  readonly model: string;
  readonly usdPer1kCharacters: number;
  readonly #options: ElevenLabsVoiceOptions;
  readonly #fetch: typeof fetch;
  readonly #firstAudioMs: number;

  constructor(options: ElevenLabsVoiceOptions) {
    this.#options = options;
    this.model = options.model;
    this.usdPer1kCharacters = options.usdPer1kCharacters;
    this.#firstAudioMs = options.firstAudioTimeoutMs ?? FIRST_AUDIO_TIMEOUT_MS;
    // Bound, so the global fetch never runs with this adapter as its receiver.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Reads the key and opens the connection to the vendor with a free request (`GET /v1/models`), so the call's first
   * unit pays for neither. Never rejects.
   */
  async prewarm(): Promise<void> {
    try {
      const response = await this.#fetch(`${this.#options.apiOrigin}/v1/models`, {
        method: 'GET',
        headers: { 'xi-api-key': await this.#options.apiKey() },
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Unreachable or refused: the first unit opens its own connection (and falls back to Polly if it must).
    }
  }

  async synthesize(input: VoiceSynthesisInput): Promise<SynthesizedSpeech> {
    const text = input.text;
    const pcm = input.format === 'pcm_24000';
    const query = new URLSearchParams({ output_format: pcm ? 'pcm_24000' : 'mp3_44100_64' });
    if (this.#options.zeroRetention) query.set('enable_logging', 'false');
    const url = `${this.#options.apiOrigin}/v1/text-to-speech/${encodeURIComponent(input.voiceRef)}/stream?${query.toString()}`;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, this.#firstAudioMs);
    const signal = AbortSignal.any([
      AbortSignal.timeout(HTTP_TIMEOUT_MS),
      deadline.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    let first: Uint8Array;
    try {
      let key: string;
      try {
        key = await this.#options.apiKey();
      } catch {
        throw new SpeechSynthesisError('elevenlabs key unavailable');
      }
      const body: Record<string, unknown> = { text, model_id: this.model };
      if (input.previousText !== undefined && input.previousText !== '')
        body.previous_text = input.previousText;
      if (input.nextText !== undefined && input.nextText !== '') body.next_text = input.nextText;
      if (ENFORCES_LANGUAGE.test(this.model)) body.language_code = 'en';
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'content-type': 'application/json',
          accept: pcm ? 'audio/pcm' : 'audio/mpeg',
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechSynthesisError(`elevenlabs ${String(response.status)}`);
      }
      reader = response.body.getReader();
      // The first audio bytes, within the deadline (an empty answer is a failure too).
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new SpeechSynthesisError('elevenlabs returned no audio');
        if (next.value.byteLength > 0) {
          first = next.value;
          break;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (input.signal?.aborted === true) {
        throw err instanceof Error && err.name === 'AbortError' ? err : abortError();
      }
      if (err instanceof SpeechSynthesisError) throw err;
      if (deadline.signal.aborted) throw new SpeechSynthesisError('elevenlabs first audio timeout');
      throw new SpeechSynthesisError('elevenlabs unreachable');
    }
    clearTimeout(timer);
    let pending: Uint8Array | null = first;
    const audio = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pending !== null) {
          controller.enqueue(pending);
          pending = null;
          return;
        }
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return {
      audio,
      contentType: pcm ? 'audio/pcm' : 'audio/mpeg',
      ...(pcm ? { sampleRateHertz: 24_000 } : {}),
      characters: text.length,
      engine: 'clone',
      voiceId: input.voiceRef,
    };
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
