import { type PathIntent, type Playbook } from './types.js';
import { BREAK, FUNCTION_WORDS, plain, sentences, tokens } from './words.js';

/**
 * What a founder asks, read from their words by the playbook's intent table: phrase rules (referral intents before all
 * others). The nearest phrase by the words that carry meaning ({@link nearestWords}) stands in for the stage by meaning
 * (semantic.ts) only when that could not be asked. Pure: the same words and table always give the same intent, and a tie
 * goes to the intent listed first.
 */
export interface IntentMatch {
  readonly intent: PathIntent;
  readonly how: 'phrase' | 'lexical';
  readonly score: number;
}

/**
 * How the message asks: a question or an instruction (`mid_ask`: while another step is under way, where one shared word is
 * no new subject), a statement, or a follow-up of the turn before.
 */
export type Asking = 'ask' | 'mid_ask' | 'statement' | 'follow_up';

/**
 * When the nearest phrase is what they ask: how much of it the message holds and of the message it is (`likeness`), how
 * telling the words they share are (`evidence`) and how many (`shared`), and how far any other play is behind (`margin`).
 * `guarded` is added to the likeness of a message that is no plain first question. Tuned to say nothing rather than a wrong
 * play: on the fixtures, the blind asks and the messages of nothing (path/play-benchmark) it answers about half of what
 * it is asked and none of it wrongly (words.test.ts, play-benchmark.test.ts).
 */
export const NEAREST_WORDS = { likeness: 0.55, evidence: 5, shared: 2, margin: 0.25, guarded: 0.2 } as const;
/** Words between a phrase's words that never count as a gap ("price my product", "price the actual product"). */
const FILLERS: ReadonlySet<string> = new Set(
  'a an the my our your their this that these those some any just really actually please for me u to i we so'.split(
    ' ',
  ),
);
/** Words a `...` in a phrase may stand for. */
const WILDCARD_WORDS = 6;

interface Phrase {
  readonly words: readonly string[];
  /** For each word but the last: whether the phrase leaves a gap (`...` or `*`) after it. */
  readonly open: readonly boolean[];
  readonly weight: number;
}

interface Compiled {
  readonly intent: PathIntent;
  readonly order: number;
  readonly phrases: readonly Phrase[];
  readonly unless: readonly Phrase[];
  /** Each phrase's words that carry meaning ({@link meaningOf}). */
  readonly vectors: readonly ReadonlySet<string>[];
  /** In how many of its phrases each of those words is. */
  readonly counts: ReadonlyMap<string, number>;
  readonly unlessWords: readonly (readonly string[])[];
}

interface Index {
  readonly intents: readonly Compiled[];
  /** How much a word tells the intents apart (the fewer use it, the more). */
  readonly weight: (word: string) => number;
}

/** Words that carry no meaning of an ask of their own. */
const PLAIN_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the i me my we our us you your it its is are was were be been am do does did to of in on at for with and or ' +
    'but so if that this these those have has had can could will would should shall may might just really very please ' +
    'ok okay hey hi honestly like some any from by as about into than then there here them they their he she his her ' +
    'get got know think want need help tell s t m re ve ll d u how what when where not who which why let more else ' +
    'say said word second one thing way lot bit mean day today tomorrow long call take give explain example anything ' +
    'something monday tuesday wednesday thursday friday saturday sunday line other another'
  ).split(' '),
);

function stem(word: string): string {
  if (word.length <= 3) return word;
  const w = word
    .replace(/ies$/, 'y')
    .replace(/sses$/, 'ss')
    .replace(/(?<![su])s$/, '');
  const cut = w.replace(/(?:ing|ed)$/, '');
  const base = cut.length >= 3 ? cut : w;
  return base.replace(/(.)\1$/, '$1').replace(/e$/, '');
}

/** The distinct words of `text` that carry its meaning, stemmed. */
function meaningOf(text: string): string[] {
  const words = plain(text)
    .replace(/['’]/g, '')
    .replace(/\bco[- ]founder/g, 'cofounder')
    .replace(/\bten\b/g, '10')
    .replace(/\bhundred\b/g, '100')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '' && !PLAIN_WORDS.has(w));
  return [...new Set(words.map(stem))];
}

function phraseOf(text: string): Phrase | null {
  const words: string[] = [];
  const open: boolean[] = [];
  for (const part of text.split(/\s*(?:\.\.\.|…|\*)\s*/u)) {
    const own = tokens(part).filter((t) => t !== BREAK);
    if (own.length === 0) continue;
    if (words.length > 0) open[words.length - 1] = true;
    for (const word of own) {
      words.push(word);
      open.push(false);
    }
  }
  if (words.length === 0) return null;
  const weight = words.reduce((sum, w) => sum + (FUNCTION_WORDS.has(w) ? 1 : 2), 0);
  return { words, open, weight };
}

const indexes = new WeakMap<Playbook, Index>();

function indexOf(playbook: Playbook): Index {
  const known = indexes.get(playbook);
  if (known !== undefined) return known;
  const compiled = playbook.intents.map((intent, order): Compiled => {
    const phrases = intent.phrases.flatMap((text) => {
      const phrase = phraseOf(text);
      return phrase === null ? [] : [phrase];
    });
    return {
      intent,
      order,
      phrases,
      unless: (intent.unless ?? []).flatMap((text) => {
        const phrase = phraseOf(text);
        return phrase === null ? [] : [phrase];
      }),
      ...meaningsOf(intent),
    };
  });
  const seenIn = new Map<string, number>();
  for (const c of compiled) for (const word of c.counts.keys()) seenIn.set(word, (seenIn.get(word) ?? 0) + 1);
  const n = Math.max(1, compiled.length);
  const built: Index = {
    intents: compiled,
    // A word no phrase has is as telling as one a few have: it says the ask is about something else.
    weight: (word) => Math.log(1 + n / (seenIn.get(word) ?? 4)),
  };
  indexes.set(playbook, built);
  return built;
}

function meaningsOf(intent: PathIntent): Pick<Compiled, 'vectors' | 'counts' | 'unlessWords'> {
  const vectors = intent.phrases
    .map((text) => new Set(meaningOf(text.replace(/\.\.\.|…|\*/g, ' '))))
    .filter((words) => words.size > 0);
  const counts = new Map<string, number>();
  for (const words of vectors) for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return {
    vectors,
    counts,
    unlessWords: (intent.unless ?? []).map(meaningOf).filter((words) => words.length > 0),
  };
}

/**
 * Whether `words` holds `phrase` in order, on whole words, within one sentence. Between two of its words: fillers
 * freely; one other word when the phrase has three words or more; up to {@link WILDCARD_WORDS} where it says `...`.
 * Returns how many words were skipped (fewest over every start), or null.
 */
export function findPhrase(words: readonly string[], phrase: Phrase): number | null {
  const gapOf = (i: number): number =>
    phrase.open[i] === true ? WILDCARD_WORDS : phrase.words.length >= 3 ? 1 : 0;
  let best: number | null = null;
  /** From word `i` of the phrase matched at `at`: the fewest words skipped to match the rest. */
  const rest = (i: number, at: number): number | null => {
    if (i === phrase.words.length - 1) return 0;
    let skipped = 0;
    let found: number | null = null;
    for (let j = at + 1; j < words.length; j += 1) {
      const word = words[j];
      if (word === undefined || word === BREAK) break;
      if (word === phrase.words[i + 1]) {
        const more = rest(i + 1, j);
        if (more !== null && (found === null || skipped + more < found)) found = skipped + more;
      }
      if (!FILLERS.has(word)) skipped += 1;
      if (skipped > gapOf(i)) break;
    }
    return found;
  };
  for (let start = 0; start < words.length; start += 1) {
    if (words[start] !== phrase.words[0]) continue;
    const skipped = rest(0, start);
    if (skipped !== null && (best === null || skipped < best)) best = skipped;
  }
  return best;
}

function holds(words: readonly string[], phrases: readonly Phrase[]): boolean {
  return phrases.some((phrase) => findPhrase(words, phrase) !== null);
}

/** Whether the message says it is another ask than `intent`'s (its `unless` words). */
export function isAnotherAsk(playbook: Playbook, intent: PathIntent, text: string): boolean {
  const compiled = indexOf(playbook).intents.find((c) => c.intent === intent);
  return compiled !== undefined && holds(tokens(text), compiled.unless);
}

/** How many words of the message carry meaning of their own. */
export function meaningWords(text: string): number {
  return meaningOf(text).length;
}

/** The intent whose phrase the message holds: a referral first, then the most specific phrase, then table order. */
export function phraseIntent(
  playbook: Playbook,
  text: string,
  only: (intent: PathIntent) => boolean = () => true,
): IntentMatch | null {
  const words = tokens(text);
  let best: { match: IntentMatch; referral: boolean; order: number } | null = null;
  for (const c of indexOf(playbook).intents) {
    if (!only(c.intent) || holds(words, c.unless)) continue;
    let score = 0;
    for (const phrase of c.phrases) {
      const skipped = findPhrase(words, phrase);
      if (skipped !== null) score = Math.max(score, phrase.weight - skipped * 0.5);
    }
    if (score <= 0) continue;
    const referral = c.intent.referral === true;
    if (
      best === null ||
      (referral && !best.referral) ||
      (referral === best.referral && score > best.match.score)
    )
      best = { match: { intent: c.intent, how: 'phrase', score }, referral, order: c.order };
  }
  return best?.match ?? null;
}

/** The words of a follow-up ("can you write it", "what do I say to them", "the other one"). */
const ANAPHORA =
  /\b(?:it|them|they|he|she|him|her|there|instead|else|the other|the second|the first one)\b|\b(?:this|that|these|those|one|ones)\b/;

/** Whether a message has a word that points at what was just said, whatever else it names. */
export function refersBack(text: string): boolean {
  return ANAPHORA.test(plain(text));
}

/** Whether a message names little of its own and points at what was just said. */
export function pointsBack(text: string): boolean {
  return refersBack(text) && meaningOf(text).length <= 3;
}

export interface Nearest {
  readonly intent: PathIntent;
  readonly score: number;
  readonly likeness: number;
  /** How telling the words shared with the nearest phrase are, and how many they are. */
  readonly evidence: number;
  readonly shared: number;
}

function nearestOf(index: Index, text: string, only: (intent: PathIntent) => boolean): Nearest[] {
  const said = meaningOf(text);
  const has = new Set(said);
  const total = (words: Iterable<string>): number => {
    let sum = 0;
    for (const word of words) sum += index.weight(word);
    return sum;
  };
  const all = total(said);
  if (all === 0) return [];
  const aboutCoach = /\byou\b/.test(plain(text));
  const out: Nearest[] = [];
  for (const c of index.intents) {
    if (!only(c.intent) || c.unlessWords.some((words) => words.every((w) => has.has(w)))) continue;
    let likeness = 0;
    let evidence = 0;
    let shared = 0;
    for (const vector of c.vectors) {
      let common = 0;
      let count = 0;
      let only = '';
      for (const word of vector) {
        if (!has.has(word)) continue;
        common += index.weight(word);
        count += 1;
        only = word;
      }
      if (common === 0) continue;
      // One word in common names the subject only when the intent is about that word, or it is much of the message ("fix" of
      // "fix my deck" is neither); of a referral, or a question about the coach, nearly all.
      if (
        count === 1 &&
        vector.size > 1 &&
        (c.counts.get(only) ?? 0) < 2 &&
        index.weight(only) < (c.intent.referral === true || aboutCoach ? 0.9 : 0.39) * all
      )
        continue;
      const score = 0.55 * (common / total(vector)) + 0.45 * (common / all);
      if (score > likeness) {
        likeness = score;
        evidence = common;
        shared = count;
      }
    }
    if (likeness === 0) continue;
    // Words its phrases use again and again ("equity" in the equity split).
    let familiar = 0;
    for (const word of said) familiar += index.weight(word) * Math.min(1, (c.counts.get(word) ?? 0) / 3);
    out.push({
      intent: c.intent,
      likeness,
      evidence,
      shared,
      score: likeness + 0.3 * (familiar / all),
    });
  }
  return out;
}

/**
 * The intents the message is near by the words that carry meaning (each weighted by how few intents use it), best first,
 * one for each play: how much of one phrase the message, or a sentence of it that says something of its own, holds, and how
 * much of it that phrase is.
 */
export function nearestAsks(
  playbook: Playbook,
  text: string,
  only: (intent: PathIntent) => boolean = () => true,
): Nearest[] {
  const index = indexOf(playbook);
  const own = sentences(text);
  const parts = own.length > 1 && own.length <= 6 ? [text, ...own.filter((x) => !pointsBack(x))] : [text];
  const best = new Map<string, Nearest>();
  for (const part of parts)
    for (const near of nearestOf(index, part, only)) {
      const known = best.get(near.intent.playId);
      if (known === undefined || near.score > known.score) best.set(near.intent.playId, near);
    }
  return [...best.values()].sort((x, y) => y.score - x.score);
}

/**
 * The intent the message is plainly nearest to by its words ({@link NEAREST_WORDS}); null when none is, or two are about
 * as near. Only when the message could not be compared by meaning.
 */
export function nearestWords(
  playbook: Playbook,
  text: string,
  options: {
    readonly only?: (intent: PathIntent) => boolean;
    readonly guarded?: boolean;
  } = {},
): IntentMatch | null {
  const [first, second] = nearestAsks(playbook, text, options.only);
  const least = NEAREST_WORDS.likeness + (options.guarded === true ? NEAREST_WORDS.guarded : 0);
  if (
    first === undefined ||
    first.likeness < least ||
    first.evidence < NEAREST_WORDS.evidence ||
    first.shared < NEAREST_WORDS.shared ||
    first.score - (second?.score ?? 0) < NEAREST_WORDS.margin
  )
    return null;
  return { intent: first.intent, how: 'lexical', score: first.score };
}
