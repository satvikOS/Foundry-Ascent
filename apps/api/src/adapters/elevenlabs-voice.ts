import {
  SpeechSynthesisError,
  type SynthesizedSpeech,
  type VoiceProvider,
  type VoiceSynthesisInput,
} from '@foundry/core';

import { type ApiKeySource } from './media-secrets.js';

/**
 * The EIR's cloned voice through **ElevenLabs** streaming text-to-speech (core `VoiceProvider` port;
 * docs/runbooks/avatars.md). Written from the vendor's API reference (2026-10-17); never called in CI (tests use
 * recorded responses).
 *
 * `POST /v1/text-to-speech/{voice_id}/stream?output_format=…` with the API key (`xi-api-key`; Secrets Manager
 * `foundry-ascent/media/elevenlabs`, a key restricted to text to speech) and `{text, model_id}`. The words come
 * only from a verified unit (`VerifiedSpeechUnit`): the server signed them after the identity guard, the
 * meta-narration gate and the sentence gate passed them. MP3 for the call's speakers, raw 24 kHz PCM for a face.
 * With zero retention (an Enterprise feature) the request asks the vendor to keep nothing (`enable_logging=false`).
 * The audio streams through as the vendor produces it. Errors carry the status only, never the words or the key.
 */

const HTTP_TIMEOUT_MS = 15_000;

export interface ElevenLabsVoiceOptions {
  readonly apiKey: ApiKeySource;
  /** `https://api.elevenlabs.io` (packages/core/media-vendors.json). */
  readonly apiOrigin: string;
  /** The model (`MEDIA_VOICE_MODEL`, default `eleven_flash_v2_5`). */
  readonly model: string;
  readonly usdPer1kCharacters: number;
  /** Ask for zero retention (`MEDIA_VOICE_ZERO_RETENTION`; Enterprise accounts only). */
  readonly zeroRetention: boolean;
  readonly fetch?: typeof fetch;
}

export class ElevenLabsVoice implements VoiceProvider {
  readonly id = 'elevenlabs' as const;
  readonly model: string;
  readonly usdPer1kCharacters: number;
  readonly #options: ElevenLabsVoiceOptions;
  readonly #fetch: typeof fetch;

  constructor(options: ElevenLabsVoiceOptions) {
    this.#options = options;
    this.model = options.model;
    this.usdPer1kCharacters = options.usdPer1kCharacters;
    this.#fetch = options.fetch ?? fetch;
  }

  async synthesize(input: VoiceSynthesisInput): Promise<SynthesizedSpeech> {
    const text = input.unit.text;
    const pcm = input.format === 'pcm_24000';
    const query = new URLSearchParams({ output_format: pcm ? 'pcm_24000' : 'mp3_44100_128' });
    if (this.#options.zeroRetention) query.set('enable_logging', 'false');
    const url = `${this.#options.apiOrigin}/v1/text-to-speech/${encodeURIComponent(input.voiceRef)}/stream?${query.toString()}`;
    const signals = [AbortSignal.timeout(HTTP_TIMEOUT_MS), ...(input.signal ? [input.signal] : [])];
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': await this.#options.apiKey(),
          'content-type': 'application/json',
          accept: pcm ? 'audio/pcm' : 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: this.model }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && input.signal?.aborted === true) throw err;
      throw new SpeechSynthesisError('elevenlabs unreachable');
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new SpeechSynthesisError(`elevenlabs ${String(response.status)}`);
    }
    return {
      audio: response.body,
      contentType: pcm ? 'audio/pcm' : 'audio/mpeg',
      ...(pcm ? { sampleRateHertz: 24_000 } : {}),
      characters: text.length,
      engine: 'clone',
      voiceId: input.voiceRef,
    };
  }
}
