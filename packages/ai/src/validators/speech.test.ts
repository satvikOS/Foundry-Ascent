import { describe, expect, it } from 'vitest';

import { SPOKEN_MAX_WORDS, clampWords, deriveSpoken, toSpeakable } from './speech.js';

describe('toSpeakable', () => {
  it.each([
    ['plain sentences stay as they are', 'Run the pilot. Who pays?', 'Run the pilot. Who pays?'],
    [
      'citation keys go',
      'Interviews show pain [E1] and churn [E2, E3]. Next (E4).',
      'Interviews show pain and churn. Next.',
    ],
    [
      'emphasis and inline code go',
      'This is **important** and _subtle_ with `code`.',
      'This is important and subtle with code.',
    ],
    [
      'headings and list items become sentences',
      '# Plan\n1. Call five buyers\n2. Ask for a deposit',
      'Plan. Call five buyers. Ask for a deposit.',
    ],
    [
      'links keep their label, URLs go',
      'Read [the guide](https://example.org/x) at https://example.org/y now.',
      'Read the guide at now.',
    ],
    ['quotes and rules go', '> A quote\n\n---\n\nThen this.', 'A quote. Then this.'],
    ['HTML goes', 'Hello <b>there</b><script>alert(1)</script>.', 'Hello there.'],
    ['code blocks are not read aloud', 'Try this:\n```\nrm -rf /\n```\nDone.', 'Try this: Done.'],
    ['tables flatten', '| a | b |\n| 1 | 2 |', 'a b. 1 2.'],
    ['a line ending in a comma runs on', 'Best,\nCorin', 'Best, Corin.'],
  ])('%s', (_name, input, expected) => {
    expect(toSpeakable(input)).toBe(expected);
  });

  it('keeps apostrophes and reads stray underscores as spaces', () => {
    expect(toSpeakable("Don't over_think it; it's fine.")).toBe("Don't over think it; it's fine.");
  });
});

describe('clampWords', () => {
  it('leaves short text alone', () => {
    expect(clampWords('Short and sweet.')).toEqual({ text: 'Short and sweet.', truncated: false });
  });

  it('cuts at the last sentence that fits', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    expect(clampWords(text, 7)).toEqual({ text: 'One two three. Four five six.', truncated: true });
  });

  it('cuts a single long sentence at a word boundary and closes it', () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i},`).join(' ');
    const out = clampWords(long);
    expect(out.truncated).toBe(true);
    expect(out.text.split(/\s+/)).toHaveLength(SPOKEN_MAX_WORDS);
    expect(out.text.endsWith('w69.')).toBe(true);
  });

  it('respects the character bound too', () => {
    const out = clampWords(`${'a'.repeat(700)} b.`, 70, 600);
    expect(out.text.length).toBeLessThanOrEqual(601);
    expect(out.truncated).toBe(true);
  });
});

describe('deriveSpoken', () => {
  it('turns a Markdown answer into at most 70 plain words', () => {
    const answer = [
      'Maya, your interviews point to real pain [E1].',
      '',
      ...Array.from({ length: 30 }, (_, i) => `- Point number ${i} matters here.`),
      '',
      'Who pays?',
    ].join('\n');
    const spoken = deriveSpoken(answer);
    expect(spoken.startsWith('Maya, your interviews point to real pain.')).toBe(true);
    expect(spoken).not.toMatch(/\[|-\s/);
    expect(spoken.split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_MAX_WORDS);
  });

  it('returns an empty string for an empty answer', () => {
    expect(deriveSpoken('')).toBe('');
  });
});
