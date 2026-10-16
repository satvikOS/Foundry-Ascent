import { DEFAULT_SPEECH_PRICES } from '@foundry/ai';
import { SEED_VEIRS } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPEECH_VOICE,
  SPEECH_PRICE_PER_MILLION_CHARS,
  SPEECH_VOICES,
  isSpeechVoice,
  speechCostUsd,
  speechEngines,
} from './voices.js';

describe('speech voices (speech-voices.json, shared with infra/cdk)', () => {
  it('lists every voice neural first, so the platform default engine is tried first', () => {
    for (const [voice, engines] of Object.entries(SPEECH_VOICES)) {
      expect(engines.length, voice).toBeGreaterThan(0);
      if (engines.includes('neural')) expect(engines[0], voice).toBe('neural');
    }
    expect(speechEngines('Ruth')).toEqual(['neural', 'generative']);
    expect(speechEngines('Gregory')).toEqual(['neural']);
    expect(speechEngines('Tiffany')).toEqual(['generative']);
  });

  it('gives the platform voice, and every seeded persona voice, both engines', () => {
    expect(DEFAULT_SPEECH_VOICE).toBe('Danielle');
    expect(speechEngines(DEFAULT_SPEECH_VOICE)).toEqual(['neural', 'generative']);
    expect(speechEngines('Unknown')).toEqual(speechEngines(DEFAULT_SPEECH_VOICE));
    expect(isSpeechVoice('Unknown')).toBe(false);
    expect(SEED_VEIRS.map((v) => v.voiceId)).toEqual(['Matthew', 'Ruth']);
    for (const veir of SEED_VEIRS) {
      expect(isSpeechVoice(veir.voiceId), veir.name).toBe(true);
      expect(speechEngines(veir.voiceId), veir.name).toEqual(['neural', 'generative']);
    }
  });

  it('prices characters as the ai package does', () => {
    expect(SPEECH_PRICE_PER_MILLION_CHARS).toEqual({ neural: 16, generative: 30, standard: 4 });
    expect(SPEECH_PRICE_PER_MILLION_CHARS.neural).toBe(DEFAULT_SPEECH_PRICES.neural);
    expect(SPEECH_PRICE_PER_MILLION_CHARS.generative).toBe(DEFAULT_SPEECH_PRICES.generative);
    expect(speechCostUsd(1_000_000, 'generative')).toBe(30);
    expect(speechCostUsd(500, 'neural')).toBeCloseTo(0.008, 6);
    expect(speechCostUsd(-5, 'neural')).toBe(0);
  });
});
