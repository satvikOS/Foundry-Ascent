import { DEFAULT_SPEECH_VOICE_ID, SPEECH_VOICE_IDS } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SPEECH_VOICE, isSpeechVoice, SPEECH_VOICES } from './voices.js';

describe('speech voices', () => {
  it('accepts exactly the voices the contract lists (the EIR studio offers that list)', () => {
    expect(Object.keys(SPEECH_VOICES)).toEqual([...SPEECH_VOICE_IDS]);
    expect(DEFAULT_SPEECH_VOICE).toBe(DEFAULT_SPEECH_VOICE_ID);
    expect(SPEECH_VOICE_IDS.every((voice) => isSpeechVoice(voice))).toBe(true);
    expect(isSpeechVoice('Robot')).toBe(false);
  });
});
