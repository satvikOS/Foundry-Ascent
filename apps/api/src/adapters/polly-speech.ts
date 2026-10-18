import {
  DescribeVoicesCommand,
  PollyClient,
  SynthesizeSpeechCommand,
  type VoiceId,
} from '@aws-sdk/client-polly';
import { sharedAwsAgent } from '@foundry/ai';
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

/** How long a prewarm request may take before it is abandoned. */
export const PREWARM_TIMEOUT_MS = 3_000;

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
 * Text-to-speech for calls (core `SpeechSynthesizer` port) through Amazon Polly `SynthesizeSpeech`: MP3,
 * streamed to the caller as Polly produces it. Of the engines core gives for the voice, the deployment's
 * engine is tried first, then the others in core's order; the text is validated reply text only, and is
 * never logged. Needs `polly:SynthesizeSpeech` on the API role.
 */
export class PollySpeechSynthesizer implements SpeechSynthesizer {
  readonly #client: Pick<PollyClient, 'send'>;
  /** The deployment's engine, tried first. */
  readonly engine: SpeechEngine;

  constructor(options: PollySpeechSynthesizerOptions) {
    // On the process's keep-alive agent: connections kept between replies and counted (LAB-P2).
    this.#client =
      options.client ??
      new PollyClient({ region: options.region, requestHandler: { httpsAgent: sharedAwsAgent() } });
    this.engine = options.engine;
  }

  /** Opens (or reuses) the Polly connection with a free request (`DescribeVoices`); never rejects. */
  async prewarm(): Promise<void> {
    try {
      await this.#client.send(new DescribeVoicesCommand({ LanguageCode: 'en-US' }), {
        abortSignal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
    } catch {
      // Unreachable or refused: the next synthesis opens its own connection, as before.
    }
  }

  async synthesize(input: SpeechSynthesisInput): Promise<SynthesizedSpeech> {
    let lastError: unknown = null;
    for (const engine of preferEngine(input.engines, this.engine)) {
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
