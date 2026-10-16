import { describe, expect, it } from 'vitest';

import { conversationAnswer, hasNarrowingNote } from './answer-text';

const NOTE =
  '> **Limited evidence:** only 1 of 2 factual statements in this answer are backed by your venture records. Treat the rest as unverified until you can check them.';

describe('conversationAnswer', () => {
  it('drops the narrowing block quote: in a conversation it read as a report', () => {
    const answer = `${NOTE}\n\nTalk to three librarians first [E1].`;
    expect(hasNarrowingNote(answer)).toBe(true);
    expect(conversationAnswer(answer)).toBe('Talk to three librarians first [E1].');
  });

  it('gives each grouped evidence key its own citation', () => {
    expect(conversationAnswer('Two sources agree [E4, E6]; a third [E1; E2;E3].')).toBe(
      'Two sources agree [E4][E6]; a third [E1][E2][E3].',
    );
  });

  it('leaves everything else as written, including a quote the vEIR chose to use', () => {
    const answer = '> A librarian said: “we count by hand”.\n\nThat is your opening [E2].';
    expect(hasNarrowingNote(answer)).toBe(false);
    expect(conversationAnswer(answer)).toBe(answer);
  });
});
