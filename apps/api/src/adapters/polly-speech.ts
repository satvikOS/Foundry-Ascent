import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';
import {
  type SpeechEngine,
  SpeechSynthesisError,
  type SpeechSynthesisInput,
  type SpeechSynthesizer,
  type SynthesizedSpeech,
} from '@foundry/core';

export interface PollySpeechSynthesizerOptions {
  readonly region: string;
  /** The deployment's engine (`SPEECH_ENGINE`): tried first whenever the voice has it. */
  readonly engine: SpeechEngine;
  /** Injected client (tests). */
  readonly client?: Pick<PollyClient, 'send'>;
}

/** Errors that mean "this voice cannot use this engine here": the next engine is tried. */
const ENGINE_ERRORS = new Set(['EngineNotSupportedException', 'ValidationException']);

/** `engines` with `preferred` moved to the front when present; otherwise unchanged (pure; unit tested). */
export function preferEngine(
  engines: readonly SpeechEngine[],
  preferred: SpeechEngine,
): readonly SpeechEngine[] {
  return engines.includes(preferred) ? [preferred, ...engines.filter((e) => e !== preferred)] : engines;
}

/**
 * Text-to-speech for calls (core `SpeechSynthesizer` port) through Amazon Polly `SynthesizeSpeech`: MP3 (or
 * 16 kHz PCM for a face), streamed to the caller as Polly produces it. Of the engines core gives for the voice, the deployment's
 * engine is tried first, then the others in core's order; the text is validated reply text only, and is
 * never logged. Needs `polly:SynthesizeSpeech` on the API role.
 */
export class PollySpeechSynthesizer implements SpeechSynthesizer {
  readonly #client: Pick<PollyClient, 'send'>;
  /** The deployment's engine, tried first. */
  readonly engine: SpeechEngine;

  constructor(options: PollySpeechSynthesizerOptions) {
    this.#client = options.client ?? new PollyClient({ region: options.region });
    this.engine = options.engine;
  }

  async synthesize(input: SpeechSynthesisInput): Promise<SynthesizedSpeech> {
    let lastError: unknown = null;
    for (const engine of preferEngine(input.engines, this.engine)) {
      try {
        // A face renders raw PCM (Polly's PCM is 16-bit mono little-endian, at most 16 kHz; core resamples it).
        const pcm = input.format === 'pcm_16000';
        const output = await this.#client.send(
          new SynthesizeSpeechCommand({
            Engine: engine,
            OutputFormat: pcm ? 'pcm' : 'mp3',
            ...(pcm ? { SampleRate: '16000' } : {}),
            Text: input.text,
            TextType: 'text',
            VoiceId: input.voiceId as VoiceId,
          }),
          input.signal === undefined ? {} : { abortSignal: input.signal },
        );
        const stream = output.AudioStream;
        if (stream === undefined) throw new SpeechSynthesisError('Polly returned no audio');
        const audio: ReadableStream<Uint8Array> = stream.transformToWebStream() as ReadableStream<Uint8Array>;
        return {
          audio,
          contentType: pcm ? 'audio/pcm' : 'audio/mpeg',
          ...(pcm ? { sampleRateHertz: 16_000 } : {}),
          characters: output.RequestCharacters ?? input.text.length,
          engine,
          voiceId: input.voiceId,
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (err instanceof SpeechSynthesisError) throw err;
        lastError = err;
        if (err instanceof Error && ENGINE_ERRORS.has(err.name)) continue;
        break;
      }
    }
    throw new SpeechSynthesisError('speech synthesis failed', { cause: lastError });
  }
}
