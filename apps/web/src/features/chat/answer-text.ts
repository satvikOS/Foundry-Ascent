/*
 * The vEIR's answer as a conversation shows it. Two things the server writes into the answer text read as
 * machine output in a conversation (production transcripts, Oct 2026):
 *   - a block quote "**Limited evidence:** only 1 of 2 factual statements …" prepended to a narrowed answer.
 *     The same information stays under "Sources & reasoning" (the validator's `narrowed` result);
 *   - grouped evidence keys "[E4, E6]", which the citation renderer does not recognise and so show as raw
 *     text. They become one citation each ("[E4][E6]").
 */

/** The server's narrowing note: a block quote starting "**Limited evidence:**", up to its first blank line. */
const NARROWING_NOTE = /^\s*>[ \t]*\*\*Limited evidence:\*\*[^\n]*(?:\n>[^\n]*)*\s*/;

/** Several evidence keys in one bracket: "[E4, E6]", "[E1; E2; E3]". */
const GROUPED_KEYS = /\[(E\d{1,3}(?:\s*[,;]\s*E\d{1,3})+)\]/g;

/** Whether the answer text opens with the server's narrowing note. */
export function hasNarrowingNote(answer: string): boolean {
  return NARROWING_NOTE.test(answer);
}

/** The answer without the narrowing note, each evidence key in its own citation. */
export function conversationAnswer(answer: string): string {
  return answer.replace(NARROWING_NOTE, '').replace(GROUPED_KEYS, (_match, keys: string) =>
    keys
      .split(/\s*[,;]\s*/)
      .map((key) => `[${key}]`)
      .join(''),
  );
}
