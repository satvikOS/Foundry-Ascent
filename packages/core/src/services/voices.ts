import { type SpeechEngine } from '../ports.js';

/**
 * Voices a persona may speak with during calls: Amazon Polly's adult US-English voices, with the engines each
 * supports, most natural first (generative, then neural). Polly's generative and neural engines are both
 * available in us-east-1, where the API runs.
 */
export const SPEECH_VOICES: Readonly<Record<string, readonly SpeechEngine[]>> = {
  Danielle: ['generative', 'neural'],
  Joanna: ['generative', 'neural'],
  Matthew: ['generative', 'neural'],
  Ruth: ['generative', 'neural'],
  Salli: ['generative', 'neural'],
  Stephen: ['generative', 'neural'],
  Gregory: ['neural'],
  Joey: ['neural'],
  Kendra: ['neural'],
  Kimberly: ['neural'],
};

/** The platform voice: personas without a (consented) voice of their own, such as Foundry Guide. */
export const DEFAULT_SPEECH_VOICE = 'Danielle';

/** Polly prices in USD per million characters (us-east-1, on demand). */
export const SPEECH_PRICE_PER_MILLION_CHARS: Readonly<Record<SpeechEngine, number>> = {
  generative: 30,
  neural: 16,
  standard: 4,
};

export function isSpeechVoice(voiceId: string): boolean {
  return Object.hasOwn(SPEECH_VOICES, voiceId);
}

/** The engines to try for a voice, most natural first (unknown voices get the platform default's). */
export function speechEngines(voiceId: string): readonly SpeechEngine[] {
  return SPEECH_VOICES[voiceId] ?? SPEECH_VOICES[DEFAULT_SPEECH_VOICE] ?? ['neural'];
}

/** Cost of synthesizing `characters` with `engine`. */
export function speechCostUsd(characters: number, engine: SpeechEngine): number {
  return (Math.max(0, characters) * SPEECH_PRICE_PER_MILLION_CHARS[engine]) / 1_000_000;
}
