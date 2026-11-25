import { describe, expect, it } from 'vitest';

import { EXCERPT_WINDOW_CHARS, excerptWindow } from './excerpt.js';

const filler = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Sentence number ${String(i)} says little about anything at all.`).join(
    ' ',
  );

describe('the part of a passage a turn shows', () => {
  it('is the whole text when it fits', () => {
    expect(excerptWindow('  Short and whole.  ', 'anything')).toBe('Short and whole.');
  });

  it('is the sentences about the message, wherever they are, whole and within the limit', () => {
    const text = `${filler(8)} A pilot agreement names who owns improvements. Put the price of the pilot in it. ${filler(8)}`;
    const shown = excerptWindow(text, 'Who owns the improvements made in our pilot?');
    expect(shown).toContain(
      'A pilot agreement names who owns improvements. Put the price of the pilot in it.',
    );
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_WINDOW_CHARS);
    expect(shown.startsWith('… Sentence number')).toBe(true);
    expect(shown.endsWith(' …')).toBe(true);
    // Every sentence shown is whole.
    for (const s of shown
      .replaceAll('…', '')
      .trim()
      .split(/(?<=\.)\s/))
      expect(text).toContain(s.trim());
  });

  it('is the opening when nothing matches', () => {
    const shown = excerptWindow(filler(20), 'zebra crossing');
    expect(shown.startsWith('Sentence number 0')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_WINDOW_CHARS);
    expect(shown.endsWith('.')).toBe(false);
  });

  it('keeps an opening that sends the founder to a professional, whichever sentence matches', () => {
    const text = `A securities attorney decides whether this fits. ${filler(7)} File Form D within 15 days of the first sale.`;
    const shown = excerptWindow(text, 'when do we file form d after a sale', { keepCaution: true });
    expect(shown.startsWith('A securities attorney decides whether this fits. …')).toBe(true);
    expect(shown).toContain('File Form D within 15 days of the first sale.');
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_WINDOW_CHARS);
    expect(excerptWindow(text, 'when do we file form d after a sale')).not.toContain('attorney');
  });

  it('does not take an abbreviation for the end of a sentence', () => {
    const text = `${filler(6)} The U.S. Patent Office accepts a provisional application, e.g. for a device. ${filler(6)}`;
    expect(excerptWindow(text, 'provisional patent application', { limit: 130 })).toContain(
      'The U.S. Patent Office accepts a provisional application, e.g. for a device.',
    );
  });

  it('cuts one endless sentence at a word', () => {
    const shown = excerptWindow('word '.repeat(400), 'word');
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_WINDOW_CHARS);
    expect(shown).toMatch(/word…$/);
    expect(excerptWindow('x'.repeat(2_000), '').length).toBeLessThanOrEqual(EXCERPT_WINDOW_CHARS);
  });

  it('reads list lines as sentences', () => {
    const text = `Key questions:\n${Array.from({ length: 20 }, (_, i) => `- Question ${String(i)} about nothing much here?`).join('\n')}\n- What did they pay for the workaround?`;
    const shown = excerptWindow(text, 'what workaround do they pay for', { limit: 120 });
    expect(shown).toContain('- What did they pay for the workaround?');
  });
});
