import { claimNumbers, figuresIn, sameNumber } from './figures.js';
import { stemsOf } from '../validators/stems.js';
import type { RecordLine, UnderstoodKind } from './types.js';

/**
 * Whether the record really denies what a message says. A reply opens on it ("your own numbers say otherwise"), so it has to
 * be so: a claim of theirs, in their own words, that rates or generalises against the counts of a line, or gives another
 * number for the same thing. A line said again, a new figure or plan, a step done or a question denies nothing.
 */
export interface Conflict {
  /** The claim, as JUDGE quotes it. */
  readonly claim: string;
  /** What JUDGE says of it. */
  readonly why: string;
  readonly line: RecordLine;
  readonly message: string;
  readonly kind: UnderstoodKind;
  readonly also: readonly UnderstoodKind[];
}

/** Why a contradiction is none (codes for logs and the bench). */
export type ConflictDrop = 'kind' | 'line' | 'quote' | 'claim' | 'moved' | 'sides';

/** Lines that hold what happened or stands; never who they are, what they hope, or what is to be done. */
const HOLDS: ReadonlySet<string> = new Set([
  'evidence',
  'experiment',
  'fact',
  'decision',
  'milestone',
  'metric',
]);
/** Messages that claim nothing of the kind. */
const CLAIMS_NOTHING: ReadonlySet<UnderstoodKind> = new Set([
  'recall',
  'social',
  'draft',
  'privacy',
  'integrity',
]);

/** Rated, or said of all or none. */
const RATES =
  /\b(?:every(?:one|body)?|all of (?:them|us|my|our|the)|nobody|no one|none|always|never|stead(?:y|ily)|grow(?:s|ing|n|th)?|grew|prove[sdn]?|proving|proof|sure|certain(?:ly)?|definitely|guaranteed|only (?:problem|reason|thing|issue)|love[sd]?|obsessed|most(?:ly)?|clearly|obviously|doubl(?:ed|es|ing)|consistent(?:ly)?)\b/iu;
/** Said of how it goes: a line denies it by counts that go another way. */
const GROWS =
  /\b(?:grow(?:s|ing|n|th)?|grew|doubl(?:ed|es|ing)|(?:going|went|gone) up|up (?:every|all)|increas\w+|climb\w+)\b/iu;
const STEADY =
  /\b(?:stead(?:y|ily)|stable|constant(?:ly)?|consistent(?:ly)?|no change|flat|same as ever)\b/iu;
const TREND = { test: (text: string): boolean => GROWS.test(text) || STEADY.test(text) };
/** What a line has of a shortfall, beside two counts. */
const FALLS_SHORT =
  /\b(?:none|nobody|no one|zero|not|never|only|cancel+ed|stopped|left|quit|fell|dropped|lost|fewer|refused|no)\b/iu;
/** They tell a change: what stood before is not denied by it. */
const MOVED =
  /\b(?:pivot\w*|chang(?:e|ed|ing)|instead|switch(?:ed|ing)?|no longer|forget|from now|(?:is|are|it['’]?s) (?:now|\S+ now)|new (?:price|plan|number)|used to|raised|lowered|correct(?:ion|ed)?|wrong|not \d)\b/iu;

const flat = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, ' ')
    .replace(/^["'\s]+|["'\s.!?,]+$/gu, '')
    .trim();

const words = (text: string): number => text.split(/\s+/u).filter((w) => w !== '').length;
const says = (stems: ReadonlySet<string>): string[] => [...stems].filter((w) => !/^\d/u.test(w));

/** Why it is none; null: it stands. */
export function conflictDrop(c: Conflict): ConflictDrop | null {
  if (CLAIMS_NOTHING.has(c.kind)) return 'kind';
  // A report that asks nothing is told, not argued.
  if (c.kind === 'update' && !c.message.includes('?') && !c.also.includes('pushback')) return 'kind';
  // Nor what is told as no longer so.
  if (!HOLDS.has(c.line.kind) || c.line.text.includes('(was true until ')) return 'line';
  const claim = flat(c.claim);
  if (words(claim) < 2 || words(claim) > 24 || !flat(c.message).includes(claim)) return 'quote';
  const inLine = figuresIn(c.line.text);
  const told = inLine.map((f) => f.value);
  /** Its counts as they are told, the first and the last: "80 in March and 62 in April". */
  const counts = inLine.filter((f) => f.mark === null && f.time === undefined).map((f) => f.value);
  const [first = 0, last = 0] = [counts[0], counts.at(-1)];
  if (c.line.kind === 'decision' && MOVED.test(c.message)) return 'moved';
  const stated = figuresIn(claim).map((f) => f.value);
  const ofLine = stemsOf(c.line.text);
  const ofClaim = stemsOf(claim);
  const trend = TREND.test(claim);
  const rated = trend
    ? counts.length >= 2 && (GROWS.test(claim) ? last < first : last !== first)
    : RATES.test(claim) && (new Set(told).size >= 2 || (told.length > 0 && FALLS_SHORT.test(c.line.text)));
  const counted =
    stated.length > 0 &&
    told.length > 0 &&
    stated.some((n) => !told.some((t) => sameNumber(t, n))) &&
    !MOVED.test(c.message) &&
    says(ofClaim).some((w) => ofLine.has(w));
  if (!rated && !counted) return 'claim';
  // Both sides: what they say, and what the line holds.
  const why = stemsOf(c.why);
  const theirs =
    [...ofClaim].some((w) => why.has(w)) ||
    RATES.test(c.why) ||
    TREND.test(c.why) ||
    stated.some((n) => claimNumbers(c.why).includes(n));
  const lines =
    claimNumbers(c.why).some((n) => told.some((t) => sameNumber(t, n))) ||
    says(ofLine).filter((w) => why.has(w) && !ofClaim.has(w)).length >= 2;
  return theirs && lines && flat(c.why) !== flat(c.line.text) ? null : 'sides';
}
