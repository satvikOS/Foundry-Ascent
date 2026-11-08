import { describe, expect, it } from 'vitest';

import {
  MIN_PASSAGE_CHARS,
  openingText,
  speakableSentences,
  speakableText,
  splitSentences,
  withoutQuoteMarks,
} from './spoken-text';

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

  it('joins a short sentence to its neighbour, since the server voices short passages only whole', () => {
    expect(speakableSentences('Good. Pilot with one library first. Then ask. Yes.')).toEqual([
      'Good. Pilot with one library first.',
      'Then ask. Yes.',
    ]);
    expect(speakableSentences('Pilot with one library first. Yes.')).toEqual([
      'Pilot with one library first. Yes.',
    ]);
    expect(speakableSentences('Yes. No.')).toEqual(['Yes. No.']);
    for (const passage of speakableSentences('Sure. Ok. Try the pilot. Done. Fine.')) {
      expect(passage.length).toBeGreaterThanOrEqual(MIN_PASSAGE_CHARS);
    }
  });

  it('keeps the first sentences of a long answer', () => {
    const sentence = 'This sentence has exactly ten words in it for counting.';
    expect(openingText(Array(12).fill(sentence).join(' '))).toBe(Array(4).fill(sentence).join(' '));
    expect(openingText(`${'word '.repeat(90)}end.`)).toBe(`${'word '.repeat(90)}end.`);
  });
});

describe('withoutQuoteMarks: a voice in the browser is handed a drafted line without its quote marks', () => {
  it.each([
    [
      'Send him one line. "Is monitoring time reimbursable under existing CPT codes?"',
      'Send him one line. Is monitoring time reimbursable under existing CPT codes?',
    ],
    [
      'You could open with “Which class do you think we are?” and let him talk.',
      'You could open with Which class do you think we are? and let him talk.',
    ],
    ['The insole is 5" long.', 'The insole is 5 inches long.'],
    ["It's class II, and they don't bill it.", "It's class II, and they don't bill it."],
  ])('%j', (text, said) => {
    expect(withoutQuoteMarks(text)).toBe(said);
  });
});
