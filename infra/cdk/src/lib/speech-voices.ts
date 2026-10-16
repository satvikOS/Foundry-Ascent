/**
 * The infra side of `packages/core/speech-voices.json`: the Amazon Polly voices the API speaks with and the
 * prices it meters speech at (packages/core `voices.ts` reads the same file). Validated at synth time, so a
 * deployment cannot choose an engine the platform voice lacks. A persona may speak with any listed voice, and a
 * voice without the deployment's engine is synthesized (and billed) on one it has, so the speech alarms are
 * priced at the costliest engine any listed voice can be billed on, not at the deployment's engine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.js';

export const SPEECH_VOICES_FILE = join(REPO_ROOT, 'packages', 'core', 'speech-voices.json');

/** Polly engines a deployment can choose for calls (standard voices sound robotic; long-form is not real-time). */
export const SPEECH_ENGINES = ['neural', 'generative'] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

/** Every engine a voice may list (the API never chooses `standard`, but core prices it). */
const KNOWN_ENGINES: readonly string[] = [...SPEECH_ENGINES, 'standard'];

export interface SpeechVoices {
  /** Voice of personas without a consented voice of their own; it has every engine in SPEECH_ENGINES. */
  readonly platformVoice: string;
  /** On-demand USD per million characters (us-east-1). */
  readonly usdPerMillionCharacters: Readonly<Record<SpeechEngine, number>>;
  /** Adult US-English voice id → the engines it has in us-east-1. */
  readonly voices: Readonly<Record<string, readonly string[]>>;
  /**
   * The costliest engine some listed voice can be billed on, and its price: whatever voices personas choose,
   * Polly never bills more per character than this.
   */
  readonly costliest: { readonly engine: string; readonly usdPerMillionCharacters: number };
}

type Json = Record<string, unknown>;

function fail(path: string, problem: string): never {
  throw new Error(`${SPEECH_VOICES_FILE}: ${path} ${problem}`);
}

function obj(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as Json;
}

export function parseSpeechVoices(raw: unknown): SpeechVoices {
  const root = obj(raw, '$');
  const voices: Record<string, readonly string[]> = {};
  for (const [voice, engines] of Object.entries(obj(root.voices, '$.voices'))) {
    if (!/^[A-Z][a-z]+$/.test(voice)) fail(`$.voices.${voice}`, 'is not a Polly voice id');
    if (
      !Array.isArray(engines) ||
      engines.length === 0 ||
      !engines.every((e) => typeof e === 'string' && KNOWN_ENGINES.includes(e))
    ) {
      fail(`$.voices.${voice}`, `must list engines among ${KNOWN_ENGINES.join(', ')}`);
    }
    voices[voice] = engines as string[];
  }
  const prices = obj(root.usdPerMillionCharacters, '$.usdPerMillionCharacters');
  const usdPerMillionCharacters = Object.fromEntries(
    SPEECH_ENGINES.map((engine) => {
      const price = prices[engine];
      if (typeof price !== 'number' || !(price > 0))
        fail(`$.usdPerMillionCharacters.${engine}`, 'must be a positive number');
      return [engine, price];
    }),
  ) as Record<SpeechEngine, number>;
  const platformVoice = root.platformVoice;
  if (typeof platformVoice !== 'string' || !Object.hasOwn(voices, platformVoice))
    fail('$.platformVoice', 'must be one of $.voices');
  const missing = SPEECH_ENGINES.filter((engine) => !voices[platformVoice]?.includes(engine));
  if (missing.length > 0) fail('$.platformVoice', `has no ${missing.join(', ')} voice`);
  let costliest: SpeechVoices['costliest'] | null = null;
  for (const engine of new Set(Object.values(voices).flat())) {
    const price = prices[engine];
    if (typeof price !== 'number' || !(price > 0))
      fail(`$.usdPerMillionCharacters.${engine}`, 'must be a positive number (a voice uses the engine)');
    if (costliest === null || price > costliest.usdPerMillionCharacters)
      costliest = { engine, usdPerMillionCharacters: price };
  }
  if (costliest === null) fail('$.voices', 'must list at least one voice');
  return { platformVoice, usdPerMillionCharacters, voices, costliest };
}

export const SPEECH_VOICES: SpeechVoices = parseSpeechVoices(
  JSON.parse(readFileSync(SPEECH_VOICES_FILE, 'utf8')) as unknown,
);
