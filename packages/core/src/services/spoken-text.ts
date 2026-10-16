import { CRISIS_SPOKEN_MESSAGE, type HistoryTurn } from '@foundry/ai';
import { type callsRepo, type turnsRepo } from '@foundry/db';

/**
 * What a call may say, as plain text (pure; unit tested): answer Markdown read as sentences, the sentences of
 * a stored spoken reply that an unsigned speech request may ask for, the fixed crisis support message, and the
 * conversation history as the founder heard it after speaking over the vEIR.
 */

/** Unsigned requests shorter than this must be the whole spoken reply (no one-word splicing). */
export const MIN_UNSIGNED_SPEECH_CHARS = 12;

/** Answer Markdown read as plain sentences: no citation keys, emphasis, headings, bullets or link targets. */
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
const ABBREVIATIONS = new Set([
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
 * brackets) followed by whitespace, so "19.5%" or "e-mail.com" never split, and never after an abbreviation
 * or an initial ("e.g. at the main branch" stays one sentence).
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

function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A run of whole sentences of a stored spoken reply: its stored words and its sentence indices. */
export interface SpeakableRun {
  readonly text: string;
  /** Index of its first and last sentence in the stored reply (`splitSentences` of its plain text). */
  readonly first: number;
  readonly last: number;
}

/**
 * The stored words to speak when `requested` asks for a turn whose validated spoken form is `spoken`: all of
 * it, or one or more consecutive whole sentences of it at least {@link MIN_UNSIGNED_SPEECH_CHARS} long, with
 * the indices of those sentences. The match ignores case, quote styles and spacing, and the stored sentences
 * are returned (never the request's own spelling). Null for arbitrary substrings, reordered or skipped
 * sentences and anything else (pure; unit tested).
 */
export function speakableRunSpan(requested: string, spoken: string | null): SpeakableRun | null {
  if (spoken === null) return null;
  const wanted = comparable(speakableText(requested));
  if (wanted === '') return null;
  const plain = speakableText(spoken);
  const sentences = splitSentences(plain);
  if (wanted === comparable(plain)) return { text: plain, first: 0, last: Math.max(0, sentences.length - 1) };
  if (wanted.length < MIN_UNSIGNED_SPEECH_CHARS) return null;
  const keys = sentences.map(comparable);
  for (let start = 0; start < keys.length; start += 1) {
    let run = '';
    for (let end = start; end < keys.length; end += 1) {
      run = end === start ? (keys[end] ?? '') : `${run} ${keys[end] ?? ''}`;
      if (run === wanted) return { text: sentences.slice(start, end + 1).join(' '), first: start, last: end };
      if (run.length >= wanted.length) break;
    }
  }
  return null;
}

/** The stored words of {@link speakableRunSpan}. */
export function speakableRun(requested: string, spoken: string | null): string | null {
  return speakableRunSpan(requested, spoken)?.text ?? null;
}

/** Whether `text` is the fixed spoken crisis support message. */
export function isCrisisMessage(text: string): boolean {
  return comparable(speakableText(text)) === comparable(CRISIS_SPOKEN_MESSAGE);
}

/**
 * The conversation history as the founder heard it (docs/architecture/calls.md §2.6): a reply they spoke over
 * is replayed as the words of the units they heard (verified when recorded), and left out when they heard none
 * of it or its words were not recorded; other turns as answered.
 */
export function historyAsHeard(
  turns: readonly Pick<turnsRepo.TurnRecord, 'id' | 'founderText' | 'response'>[],
  interruptions: ReadonlyMap<string, Pick<callsRepo.TurnInterruption, 'heardText'>>,
): HistoryTurn[] {
  return turns.map((turn) => {
    const cut = interruptions.get(turn.id);
    return {
      founderText: turn.founderText,
      answer: cut === undefined ? (turn.response?.answer ?? null) : cut.heardText,
    };
  });
}
