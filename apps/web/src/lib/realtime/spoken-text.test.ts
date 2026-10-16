import { describe, expect, it } from 'vitest';

import { openingText, speakableSentences, speakableText, splitSentences } from './spoken-text';

describe('spoken text', () => {
  it('reads Markdown as plain text without citation keys', () => {
    expect(
      speakableText('**Twelve** is a good start [E1]. Next step (E2, E3) is a [pilot](https://x.test).'),
    ).toBe('Twelve is a good start. Next step is a pilot.');
    expect(speakableText('- Price\n- Reach')).toBe('Price Reach');
  });

  it('splits sentences the way the server does: not in numbers, abbreviations or initials', () => {
    expect(
      speakableSentences('Revenue grew 3.5 percent, e.g. at U.S. campuses. Next step (E1) is a pilot.'),
    ).toEqual(['Revenue grew 3.5 percent, e.g. at U.S. campuses.', 'Next step is a pilot.']);
    expect(splitSentences('Ask Dr. Patel first. Then J. Smith! Done?')).toEqual([
      'Ask Dr. Patel first.',
      'Then J. Smith!',
      'Done?',
    ]);
    expect(speakableSentences('   ')).toEqual([]);
  });

  it('keeps the first sentences of a long answer', () => {
    const sentence = 'This sentence has exactly ten words in it for counting.';
    expect(openingText(Array(12).fill(sentence).join(' '))).toBe(Array(4).fill(sentence).join(' '));
    expect(openingText(`${'word '.repeat(90)}end.`)).toBe(`${'word '.repeat(90)}end.`);
  });
});
