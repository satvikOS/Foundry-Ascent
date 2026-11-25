import { coverage, stemOf, stemsOf } from './stems.js';
import { isListUnit, unitsOf, wordsIn } from './units.js';

/**
 * The same thing said twice (live, 2026-11-25: a question right after the statement its play had answered got the same
 * paragraphs back; a paragraph of the program's answer stood twice in one reply). Read sentence by sentence, by the words each
 * turns on: most of them said in one earlier sentence, with the same figures and the same yes or no, and nothing is new.
 */
export interface SaidSentence {
  readonly stems: ReadonlySet<string>;
  readonly denied: boolean;
  /** Its words alone, for a quoted line said again. */
  readonly text: string;
}

/** Words that join or turn a sentence without adding to it. */
const JOINERS: ReadonlySet<string> = new Set(
  'because why not no now so yes just also already remember mind keep'.split(' ').map(stemOf),
);
const DENIED = /\b(?:not|no|never|nobody|no one|none|nothing|neither|without|cannot|\w+n['’]t)\b/iu;
/** The step line, and what done means: the same on every turn until it is done. */
const OF_THE_STEP =
  /^[\s*_]*(?:(?:your )?next(?: step)?|on your path,? next is)[*_]*\s*:|^[\s*_]*done when\b|^[\s*_]*it was due\b/iu;

/** A line in quotes, of four words or more. */
const QUOTED = /["“]((?:[^"“”]+? ){3,}[^"“”]+?)["”]/u;
const plainly = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/** Share of a sentence's words that one earlier sentence holds for it to be that sentence again. */
export const SAID_AGAIN = 0.8;
/** Most words that stand beside a line in quotes when the unit is only that line. */
const BESIDE_A_QUOTE = 3;
const LEAST_STEMS = 3;
const LEAST_WORDS = 4;

const wordsOf = (text: string): Set<string> => {
  const stems = stemsOf(text);
  for (const j of JOINERS) stems.delete(j);
  return stems;
};

/** What a text said, sentence by sentence (never its step line). */
export function saidSentences(text: string): SaidSentence[] {
  return unitsOf(text).flatMap((u) => {
    if (OF_THE_STEP.test(u.text)) return [];
    const stems = wordsOf(u.text);
    const quoted = QUOTED.test(u.text);
    return stems.size < LEAST_STEMS && !quoted
      ? []
      : [{ stems, denied: DENIED.test(u.text), text: plainly(u.text) }];
  });
}

/** Whether a unit says again what one of `said` said (a list item never: left out, its list would have a hole). */
export function saysAgain(unit: string, said: readonly SaidSentence[], share = SAID_AGAIN): boolean {
  if (said.length === 0 || isListUnit(unit) || wordsIn(unit) < LEAST_WORDS) return false;
  const quote = QUOTED.exec(unit)?.[1];
  if (
    quote !== undefined &&
    wordsOf(unit.replace(quote, ' ')).size <= BESIDE_A_QUOTE &&
    said.some((s) => s.text.includes(plainly(quote)))
  )
    return true;
  const own = wordsOf(unit);
  if (own.size < LEAST_STEMS) return false;
  const denied = DENIED.test(unit);
  const figures = [...own].filter((w) => /^\d/.test(w));
  return said.some(
    (s) => s.denied === denied && figures.every((f) => s.stems.has(f)) && coverage(own, s.stems) >= share,
  );
}

/** The sentences of `text` that `said` does not hold yet, joined. */
export function unsaidOf(text: string, said: readonly SaidSentence[]): string {
  let out = '';
  let went = false;
  for (const u of unitsOf(text)) {
    if (saysAgain(u.text, said)) {
      went = true;
      continue;
    }
    // "Then list 50 more": what it came after went.
    out += went
      ? u.raw.replace(
          /^(\s*)(?:then|so|and|but|also),? (\p{L})/iu,
          (_m, space: string, c: string) => `${space}${c.toUpperCase()}`,
        )
      : u.raw;
    went = false;
  }
  return out.trim();
}
