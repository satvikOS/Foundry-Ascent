/**
 * A reply as a call says it: plain sentences without citation keys or Markdown. The rules are the server's
 * (`speakableText`, and the sentence rules of the calls backend), because `POST /speech` voices an unsigned
 * passage only when it is whole sentences of the stored spoken reply read that way, and an interrupted
 * reply's heard units are checked the same way.
 */

/** Answer Markdown read as plain text: no citation keys, emphasis, headings, bullets or link targets. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/\[(E\d+(?:\s*[,;]\s*E\d+)*)\]/g, ' ')
    .replace(/\((E\d+(?:\s*[,;]\s*E\d+)*)\)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** Words that end with a period without ending the sentence. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.',
  'i.e.',
  'vs.',
  'cf.',
  'approx.',
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'prof.',
]);

/** Whether `sentence` ends with an abbreviation ("e.g.", "Dr.", "U.S.") or an initial ("J.") rather than its end. */
function endsInAbbreviation(sentence: string): boolean {
  const last = sentence.slice(sentence.lastIndexOf(' ') + 1).replace(/^["'“‘([]+/u, '');
  return ABBREVIATIONS.has(last.toLowerCase()) || /^(?:\p{L}\.){2,}$/u.test(last) || /^\p{Lu}\.$/u.test(last);
}

/**
 * Sentences of plain text, in order: a sentence ends at `.`, `!`, `?` or `…` (with any closing quotes or
 * brackets) followed by whitespace, so "3.5 percent" never splits, and never after an abbreviation or an
 * initial ("e.g. at U.S. campuses" stays one sentence).
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let open = '';
  for (const raw of text.split(/(?<=[.!?…]["'”’)\]]*)\s+/u)) {
    const piece = raw.trim();
    if (piece === '') continue;
    open = open === '' ? piece : `${open} ${piece}`;
    if (!endsInAbbreviation(open)) {
      sentences.push(open);
      open = '';
    }
  }
  if (open !== '') sentences.push(open);
  return sentences;
}

/** The server voices a shorter unsigned passage only when it is the whole reply (no one-word splicing). */
export const MIN_PASSAGE_CHARS = 12;

/**
 * The passages of a stored spoken reply, in order, each one `POST /speech` accepts on its own: a sentence,
 * or a short sentence ("Good.") joined to the next so no passage is shorter than {@link MIN_PASSAGE_CHARS}.
 */
export function speakableSentences(spoken: string): string[] {
  const passages: string[] = [];
  let open = '';
  for (const sentence of splitSentences(speakableText(spoken))) {
    open = open === '' ? sentence : `${open} ${sentence}`;
    if (open.length >= MIN_PASSAGE_CHARS) {
      passages.push(open);
      open = '';
    }
  }
  if (open === '') return passages;
  // A short last sentence joins the passage before it.
  const last = passages.pop();
  passages.push(last === undefined ? open : `${last} ${open}`);
  return passages;
}

/** The opening of a reply that has no spoken form: its first sentences (shown, never voiced). */
export function openingText(answer: string, maxWords = 40): string {
  const opening: string[] = [];
  let count = 0;
  for (const sentence of splitSentences(speakableText(answer))) {
    const words = sentence.split(/\s+/).length;
    if (opening.length > 0 && count + words > maxWords) break;
    opening.push(sentence);
    count += words;
  }
  return opening.join(' ');
}

/**
 * The words a voice in the browser is handed without double quotation marks (the server's `withoutQuoteMarks`, core
 * speech-text.ts): the coach puts every line written for the founder to say or send, and every line in character, in
 * double quotes, on a call too, and a voice must never say them. Applied only where a voice is handed text (the full
 * face's `avatar.speak_text`, the development speech synthesis), so the caption keeps them. An inch mark after a
 * number ("5\" long") is said as inches. Apostrophes stay.
 */
export function withoutQuoteMarks(text: string): string {
  if (!/["“”„‟«»]/u.test(text)) return text;
  return text
    .replace(/(\d+(?:\.\d+)?)"(?=[\s.,;:!?)]|$)/g, (whole, n: string, offset: number, all: string) =>
      (all.slice(0, offset).match(/"/g) ?? []).length % 2 === 0
        ? `${n} ${n === '1' ? 'inch' : 'inches'}`
        : whole,
    )
    .replace(/\s*["“”„‟«»]\s*/gu, (mark, offset: number, all: string) => {
      const after = all.slice(offset + mark.length);
      // A mark between two words keeps one space; at the start or end of the text, or before punctuation, none.
      if (offset === 0 || after === '' || /^[.,;:!?…)\]]/u.test(after)) return '';
      return /\s/u.test(mark) ? ' ' : '';
    })
    .replace(/\s{2,}/g, ' ');
}
