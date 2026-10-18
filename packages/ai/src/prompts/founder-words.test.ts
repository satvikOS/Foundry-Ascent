import { describe, expect, it } from 'vitest';

import { tidyFounderWords } from './founder-words.js';

describe('tidyFounderWords: the founder’s words said back in plain written English', () => {
  it('drops the chat slang the w6 integrator heard echoed, and capitalises days', () => {
    expect(tidyFounderWords('run five more interviews at the bus station this week fr')).toBe(
      'run five more interviews at the bus station this week',
    );
    expect(tidyFounderWords('call facilities monday')).toBe('call facilities Monday');
    expect(tidyFounderWords('Last time you planned to call facilities monday fr. How did it go?')).toBe(
      'Last time you planned to call facilities Monday. How did it go?',
    );
    expect(tidyFounderWords('ngl the pricing call went ok lol')).toBe('the pricing call went ok');
  });

  it('spells out shorthand', () => {
    expect(tidyFounderWords('gonna email u the deck tmrw')).toBe('going to email you the deck tomorrow');
    expect(tidyFounderWords('U said ur team is kinda small')).toBe('You said your team is kind of small');
    expect(tidyFounderWords('pls send it b4 friday')).toBe('send it before Friday');
  });

  it('capitalises months, and "may" or "march" only where they name the month', () => {
    expect(tidyFounderWords('launch in september, test by may')).toBe('launch in September, test by May');
    expect(tidyFounderWords('we may launch early march')).toBe('we may launch early March');
    expect(tidyFounderWords('the end of may')).toBe('the end of May');
    expect(tidyFounderWords('this may work')).toBe('this may work');
  });

  it('never spells out an upper-case code, a hyphenated name or a room code (wave 7 review)', () => {
    for (const text of [
      'the U-Pass discount for students',
      'the u-pass discount for students',
      'hiring an RN for the clinic',
      'book room B4 at the library',
      'book room b4 at the library',
      'the U of T library',
      'Floor 2day pass for the U.S. office',
    ]) {
      expect(tidyFounderWords(text)).toBe(text);
    }
    // Lower-case shorthand still is, and a sentence-opening "U" before a verb.
    expect(tidyFounderWords('send it rn')).toBe('send it right now');
    expect(tidyFounderWords('U said ur team is kinda small')).toBe('You said your team is kind of small');
  });

  it('keeps "idk" as the uncertainty it is, and writes "i" as "I"', () => {
    expect(tidyFounderWords('idk if hartwell will sign')).toBe("you're not sure if hartwell will sign");
    expect(tidyFounderWords("we're idk 3 weeks out")).toBe("we're maybe 3 weeks out");
    expect(tidyFounderWords("what i should charge, i'm not sure")).toBe("what I should charge, I'm not sure");
  });

  it('touches whole words only and leaves everything else alone', () => {
    for (const text of [
      'the Hartwell pilot at USD 900 per semester',
      'Ask Noor about the U.S. libraries',
      'a frank conversation about lollipop sales',
      'R&D budget for the URL shortener',
      'The pilot starts Monday.',
      '',
    ]) {
      expect(tidyFounderWords(text)).toBe(text);
    }
  });
});
