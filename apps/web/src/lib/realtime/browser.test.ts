import { describe, expect, it } from 'vitest';

import { developmentSpeechSynthesis } from './browser';

describe('developmentSpeechSynthesis (browser-voice fallback decision)', () => {
  const synthesis = { speak: () => undefined } as unknown as SpeechSynthesis;
  const win = { speechSynthesis: synthesis };

  it('offers the browser voice in development builds only', () => {
    expect(developmentSpeechSynthesis(true, win)).toBe(synthesis);
  });

  it('never in production builds: calls show captions instead', () => {
    expect(developmentSpeechSynthesis(false, win)).toBeNull();
  });

  it('is null where the browser has no speech synthesis', () => {
    expect(developmentSpeechSynthesis(true, {} as Pick<Window, 'speechSynthesis'>)).toBeNull();
    expect(developmentSpeechSynthesis(true, undefined)).toBeNull();
  });
});
