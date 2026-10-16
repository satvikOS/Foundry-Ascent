/**
 * A reply as a call says it: plain sentences without citation keys or Markdown. The rules are the server's
 * (`speakableText` and `splitSentences` in core's spoken text), because an unsigned `POST /speech` passage must
 * be whole sentences of the stored spoken reply exactly as the server splits it.
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

/** The sentences of a stored spoken reply, each a passage `POST /speech` accepts on its own. */
export function speakableSentences(spoken: string): string[] {
  return splitSentences(speakableText(spoken));
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
