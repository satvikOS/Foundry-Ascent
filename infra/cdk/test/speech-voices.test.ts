import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { speechAlarmCharactersPerDay, speechUsd } from '../src/lib/constants.js';
import { parseSpeechVoices, SPEECH_VOICES, SPEECH_VOICES_FILE } from '../src/lib/speech-voices.js';

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(SPEECH_VOICES_FILE, 'utf8')) as Record<string, unknown>;

const voicesWith = (engine: string): string[] =>
  Object.entries(SPEECH_VOICES.voices)
    .filter(([, engines]) => engines.includes(engine))
    .map(([voice]) => voice)
    .sort();

describe('speech voices (packages/core/speech-voices.json, shared with the API)', () => {
  it('lists exactly the adult US-English voices of each engine in us-east-1', () => {
    // Polly developer guide, "Available voices" (checked 2026-10-16).
    expect(voicesWith('neural')).toEqual([
      'Danielle',
      'Gregory',
      'Joanna',
      'Joey',
      'Kendra',
      'Kimberly',
      'Matthew',
      'Ruth',
      'Salli',
      'Stephen',
    ]);
    expect(voicesWith('generative')).toEqual([
      'Danielle',
      'Joanna',
      'Matthew',
      'Ruth',
      'Salli',
      'Stephen',
      'Tiffany',
    ]);
  });

  it('gives the platform voice and the seeded persona voices (Matthew, Ruth) both engines', () => {
    for (const voice of [SPEECH_VOICES.platformVoice, 'Matthew', 'Ruth']) {
      expect([...(SPEECH_VOICES.voices[voice] ?? [])].sort(), voice).toEqual(['generative', 'neural']);
    }
  });

  it('prices the alarms as the API meters (USD per million characters)', () => {
    expect(SPEECH_VOICES.usdPerMillionCharacters).toEqual({ neural: 16, generative: 30 });
    expect(speechUsd(1_000_000, 'generative')).toBe(30);
    expect(speechAlarmCharactersPerDay(15, 'neural')).toBe(937_500);
  });

  it.each([
    [{ platformVoice: 'Gregory' }, /platformVoice has no generative voice/],
    [{ platformVoice: 'Nobody' }, /platformVoice must be one of/],
    [{ usdPerMillionCharacters: { neural: 16 } }, /usdPerMillionCharacters.generative must be a positive/],
    [{ voices: { Danielle: ['neural', 'long-form'] } }, /voices.Danielle must list engines/],
    [{ voices: { 'en-US-Danielle': ['neural'] } }, /is not a Polly voice id/],
  ])('refuses %j', (change, message) => {
    expect(() => parseSpeechVoices({ ...raw(), ...change })).toThrow(message);
  });
});
