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

/**
 * What the vEIR says when it has no answer to give: the server's own line for an empty answer (`packages/ai`
 * EMPTY_ANSWER_FALLBACK, which a drift test pins). An answer that was empty before it was narrowed is stored as
 * the note alone, so the server's guard against an empty answer never sees it.
 */
export const NO_ANSWER_YET =
  "I don't have enough to give you a reliable answer yet. Could you share a bit more detail about what you've observed so far?";

/** The answer without the narrowing note, each evidence key in its own citation. */
export function conversationAnswer(answer: string): string {
  return answer.replace(NARROWING_NOTE, '').replace(GROUPED_KEYS, (_match, keys: string) =>
    keys
      .split(/\s*[,;]\s*/)
      .map((key) => `[${key}]`)
      .join(''),
  );
}

/**
 * A finished answer as the conversation shows it: never a message with no words. When the answer was only the
 * narrowing note, the vEIR says plainly that it has not enough yet (the note itself stays in Sources & reasoning).
 * A streaming answer uses {@link conversationAnswer}: its text is still arriving.
 */
export function finishedAnswer(answer: string): string {
  const shown = conversationAnswer(answer);
  return shown.trim() === '' && hasNarrowingNote(answer) ? NO_ANSWER_YET : shown;
}
