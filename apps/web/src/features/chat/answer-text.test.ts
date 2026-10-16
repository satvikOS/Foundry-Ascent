import { describe, expect, it } from 'vitest';

// The server's validator, as text: the line shown for an answer with no words must be the server's own.
import validatorSource from '../../../../../packages/ai/src/validators/coach-response.ts?raw';

import { conversationAnswer, finishedAnswer, hasNarrowingNote, NO_ANSWER_YET } from './answer-text';

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

describe('finishedAnswer', () => {
  it('says plainly it has not enough yet when the answer was only the narrowing note', () => {
    // An answer that was empty before it was narrowed is stored as the note alone (the validator).
    expect(conversationAnswer(NOTE)).toBe('');
    expect(finishedAnswer(NOTE)).toBe(NO_ANSWER_YET);
    expect(finishedAnswer(`${NOTE}\n\n`)).toBe(NO_ANSWER_YET);
  });

  it('shows any answer with words as the conversation shows it', () => {
    expect(finishedAnswer(`${NOTE}\n\nTalk to three librarians first [E1, E2].`)).toBe(
      'Talk to three librarians first [E1][E2].',
    );
    expect(finishedAnswer('Talk to three librarians first.')).toBe('Talk to three librarians first.');
  });

  it('uses the server’s own line for an answer with no words', () => {
    const declared = /export const EMPTY_ANSWER_FALLBACK =\s*\n?\s*"([^"]+)"/.exec(validatorSource)?.[1];
    expect(declared).toBe(NO_ANSWER_YET);
  });
});
