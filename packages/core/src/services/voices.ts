import { z } from 'zod';

import raw from '../../speech-voices.json' with { type: 'json' };
import { type SpeechEngine } from '../ports.js';

const Engine = z.enum(['neural', 'generative', 'standard']);

/**
 * `packages/core/speech-voices.json`, shared with infra/cdk (which checks the deployment's engine against it
 * and prices the speech alarms with it), so the voices core speaks with and the prices it meters cannot drift
 * from the infrastructure's.
 */
const SpeechCatalog = z
  .object({
    platformVoice: z.string(),
    usdPerMillionCharacters: z.record(Engine, z.number().positive()),
    voices: z.record(z.string().regex(/^[A-Z][a-z]+$/), z.array(Engine).min(1)),
  })
  .refine((c) => (['neural', 'generative'] as const).every((e) => c.voices[c.platformVoice]?.includes(e)), {
    message: 'platformVoice must exist on the neural and generative engines',
  });

const catalog = SpeechCatalog.parse(raw);

/**
 * Voices a persona may speak with during calls: Amazon Polly's adult US-English voices in us-east-1, where the
 * API runs, with the engines each supports (neural first). The API's Polly adapter tries the deployment's
 * engine (`SPEECH_ENGINE`) first when the voice has it.
 */
export const SPEECH_VOICES: Readonly<Record<string, readonly SpeechEngine[]>> = catalog.voices;

/** The platform voice: personas without a (consented) voice of their own, such as Foundry Guide. */
export const DEFAULT_SPEECH_VOICE: string = catalog.platformVoice;

/** Polly prices in USD per million characters (us-east-1, on demand). */
export const SPEECH_PRICE_PER_MILLION_CHARS: Readonly<Record<SpeechEngine, number>> =
  catalog.usdPerMillionCharacters;

export function isSpeechVoice(voiceId: string): boolean {
  return Object.hasOwn(SPEECH_VOICES, voiceId);
}

/** The engines a voice supports, neural first (unknown voices get the platform voice's). */
export function speechEngines(voiceId: string): readonly SpeechEngine[] {
  return SPEECH_VOICES[voiceId] ?? SPEECH_VOICES[DEFAULT_SPEECH_VOICE] ?? ['neural'];
}

/** Cost of synthesizing `characters` with `engine`. */
export function speechCostUsd(characters: number, engine: SpeechEngine): number {
  return (Math.max(0, characters) * SPEECH_PRICE_PER_MILLION_CHARS[engine]) / 1_000_000;
}
