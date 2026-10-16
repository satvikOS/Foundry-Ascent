import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';
import {
  SpeechSynthesisError,
  type SpeechSynthesisInput,
  type SpeechSynthesizer,
  type SynthesizedSpeech,
} from '@foundry/core';

export interface PollySpeechSynthesizerOptions {
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: Pick<PollyClient, 'send'>;
}

/** Errors that mean "this voice cannot use this engine here": the next engine is tried. */
const ENGINE_ERRORS = new Set(['EngineNotSupportedException', 'ValidationException']);

/**
 * Text-to-speech for calls (core `SpeechSynthesizer` port) through Amazon Polly `SynthesizeSpeech`: MP3,
 * streamed to the caller as Polly produces it. Engines are tried in the order core gives (generative, then
 * neural); the text is validated reply text only, and is never logged. Needs `polly:SynthesizeSpeech` on the
 * API role.
 */
export class PollySpeechSynthesizer implements SpeechSynthesizer {
  readonly #client: Pick<PollyClient, 'send'>;

  constructor(options: PollySpeechSynthesizerOptions) {
    this.#client = options.client ?? new PollyClient({ region: options.region });
  }

  async synthesize(input: SpeechSynthesisInput): Promise<SynthesizedSpeech> {
    let lastError: unknown = null;
    for (const engine of input.engines) {
      try {
        const output = await this.#client.send(
          new SynthesizeSpeechCommand({
            Engine: engine,
            OutputFormat: 'mp3',
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
          contentType: 'audio/mpeg',
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
