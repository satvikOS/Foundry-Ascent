/**
 * The part of a passage a turn shows: the run of whole sentences that says most of what the message is about. A typed
 * turn's evidence was about 3,100 tokens, most of it the opening of passages whose matching part came later; the
 * founder is answered (and citations are checked) with the sentences that answer.
 */
import { knowledgePack } from '@foundry/db';

/** Most characters of an item that is not the turn's play, ellipses included. */
export const EXCERPT_WINDOW_CHARS = 350;

/**
 * A reference-library passage is shown from its opening, as much of it as before: it is written so that what its
 * evidence does not establish comes first (`knowledge-pack/render.ts`), and is never shown without it.
 */
export const REFERENCE_EXCERPT_CHARS = 600;

/**
 * A sentence that sends the founder to a professional, or says a fact must be confirmed: a note that opens with one is
 * never shown without it, whichever of its sentences match.
 */
const CAUTION =
  /\b(?:attorneys?|lawyers?|accountants?|tax professional|financial advisor|counselor|patent agent|confirm (?:the|with)|check with)\b/i;

const ELLIPSIS = '…';

interface Sentence {
  readonly start: number;
  readonly end: number;
  readonly stems: ReadonlySet<string>;
}

const stems = (text: string): string[] => knowledgePack.contentTerms(text).map(knowledgePack.stem);

/** A dot that ends no sentence: an initial ("U.S."), or "e.g.". */
const ABBREVIATION = /(?:\b[A-Z]|\b(?:e\.g|i\.e|vs|etc|no|Dr|Mr|Ms))\.$/;

/** Sentences (and list lines) as ranges of `text`. */
function sentencesOf(text: string): Sentence[] {
  const ends = [...text.matchAll(/[.!?]+["”’')\]]*(?=\s)|\n+/g)]
    .filter((m) => m[0].startsWith('\n') || !ABBREVIATION.test(text.slice(0, m.index + m[0].length)))
    .map((m) => m.index + m[0].length);
  const out: Sentence[] = [];
  let from = 0;
  for (const end of [...ends, text.length]) {
    const raw = text.slice(from, end);
    const body = raw.trim();
    const start = from + (raw.length - raw.trimStart().length);
    from = end;
    if (body !== '') out.push({ start, end: start + body.length, stems: new Set(stems(body)) });
  }
  return out;
}

/** `text` cut to `limit` characters at a word, with an ellipsis. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.max(0, limit - 1));
  const space = head.lastIndexOf(' ');
  return `${(space > limit / 2 ? head.slice(0, space) : head).trimEnd()}${ELLIPSIS}`;
}

/**
 * The run of whole sentences of `text`, at most `limit` characters, that holds most of `about`'s content words (the
 * earliest of equal ones); the whole text when it fits. `keepCaution`: an opening sentence that sends the founder to a
 * professional is kept in front of it.
 */
export function excerptWindow(
  text: string,
  about: string,
  options: { readonly limit?: number; readonly keepCaution?: boolean } = {},
): string {
  const limit = options.limit ?? EXCERPT_WINDOW_CHARS;
  const whole = text.trim();
  if (whole.length <= limit) return whole;
  const sentences = sentencesOf(whole);
  const [first] = sentences;
  if (first === undefined) return cut(whole, limit);
  const caution =
    options.keepCaution === true && CAUTION.test(whole.slice(first.start, first.end))
      ? cut(whole.slice(first.start, first.end), Math.floor(limit / 2))
      : null;
  // Room for an ellipsis and a space on either side.
  const room = limit - 4 - (caution === null ? 0 : caution.length);
  const asked = new Set(stems(about));
  let best: { from: number; to: number; score: number } | null = null;
  for (let from = caution === null ? 0 : 1; from < sentences.length; from += 1) {
    const held = new Set<string>();
    for (let to = from; to < sentences.length; to += 1) {
      const start = sentences[from]?.start ?? 0;
      const last = sentences[to];
      if (last === undefined || (last.end - start > room && to > from)) break;
      for (const s of last.stems) if (asked.has(s)) held.add(s);
      if (best === null || held.size > best.score) best = { from, to, score: held.size };
      if (last.end - start > room) break;
    }
  }
  if (best === null) return caution ?? cut(whole, limit);
  const { from } = best;
  const start = sentences[from]?.start ?? 0;
  // The best run, with as many of the sentences after it (then before it) as still fit.
  let to = best.to;
  while (to + 1 < sentences.length && (sentences[to + 1]?.end ?? 0) - start <= room) to += 1;
  let begin = from;
  const floor = caution === null ? 0 : 1;
  const end = sentences[to]?.end ?? whole.length;
  while (begin > floor && end - (sentences[begin - 1]?.start ?? 0) <= room) begin -= 1;
  const begins = sentences[begin]?.start ?? 0;
  const run = cut(whole.slice(begins, end), room);
  const before = begin > floor ? `${ELLIPSIS} ` : '';
  const after = to < sentences.length - 1 && !run.endsWith(ELLIPSIS) ? ` ${ELLIPSIS}` : '';
  const shown = `${before}${run}${after}`;
  return caution === null ? shown : `${caution} ${shown}`;
}

/** The opening of `text`, at most `limit` characters. */
export function excerptOpening(text: string, limit: number = REFERENCE_EXCERPT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}${ELLIPSIS}`;
}
