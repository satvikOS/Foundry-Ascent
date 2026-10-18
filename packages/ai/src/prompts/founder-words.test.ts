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
