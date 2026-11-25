import { asksFor } from './kinds.js';
import { bare, upperFirst } from './tell.js';
import { numberOf, plain } from './words.js';

/**
 * A claim of growth, or that nobody leaves, that the venture's own record denies: said before anything else, whatever else
 * was read of the message. Only two counts of one thing, the later one smaller, deny it. Pure.
 */
const CLAIMS_GROWTH =
  /\b(?:steady|steadily|growing|grew|grown|growth (?:is|was|has been)|(?:going|gone|went|goes) up|increas(?:e|ed|ing)|doubl(?:e|ed|ing)|nobody (?:left|leaves|quits?|cancels?|cancel+ed)|no ?one (?:left|leaves|quits?|cancels?|cancel+ed)|(?:no|zero) churn|every(?:one|body) (?:stays|stayed|renews|renewed|comes back|came back))\b/;
/** Asked about, planned or denied: no claim. */
const NO_CLAIM =
  /\b(?:how (?:do|can|would|should|could)|want to|would like to|hope|plan(?:ning)? to|going to|trying to|if we|once we|not (?:growing|steady)|isn't|aren't|stopped|no longer)\b/;
const TIME =
  /\b(?:quarter|month|week|year|term|semester|season|spring|summer|autumn|fall|winter|january|february|march|april|may|june|july|august|september|october|november|december|before|last|now)\b/g;
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** The counts a text tells, in order: no amount of money, share, day or hour. */
function countsOf(text: string): number[] {
  const said = plain(text).replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_m, tens: string, one: string) => String((TENS[tens] ?? 0) + (numberOf(one) ?? 0)),
  );
  const out: number[] = [];
  for (const m of said.matchAll(/(\$ ?)?(?<![\d.])(\d[\d,]*(?:\.\d+)?|[a-z]+)(?![\d%])(?: ([a-z%$]+))?/g)) {
    const word = m[2] ?? '';
    const n = /^\d/.test(word) ? Number(word.replace(/,/g, '')) : (TENS[word] ?? numberOf(word));
    if (n === null || !Number.isInteger(n) || n < 2 || m[1] !== undefined) continue;
    if (
      /^(?:dollars?|bucks?|percent|pct|%|hours?|minutes?|days?|weeks?|months?|years?|am|pm|cents?)$/.test(
        m[3] ?? '',
      )
    )
      continue;
    out.push(n);
  }
  return out;
}

/** Whether a fact of the record tells that something became fewer. */
export function tellsDecline(fact: string): boolean {
  const said = plain(fact);
  if (/\b(?:goal|target|want|plan|hope|should|costs?|price[sd]?|wait|minutes|hours|spend|spent)\b/.test(said))
    return false;
  const counts = countsOf(fact);
  if (/\bdown from\b/.test(said)) return true;
  const [first, second] = counts;
  if (first === undefined || second === undefined || second >= first) return false;
  if (/\bfrom\b.{0,40}\bto\b/.test(said) && /\b(?:fell|fallen|dropped|shrank|went)\b/.test(said)) return true;
  // Two times, two counts: "42 rented one in May; 31 rent one in July".
  return (
    new Set(said.match(TIME) ?? []).size >= 1 &&
    /\b(?:second|third|fourth|last|this|now|then|later|later on|october|november|december|the next)\b/.test(
      said,
    ) &&
    /[;,.]/.test(fact)
  );
}

export interface Denied {
  readonly text: string;
  readonly voice: string;
}

/** What to say first when the record denies the growth they claim; null: they claim none, or it stands. */
export function deniedGrowth(message: string, facts: readonly string[]): Denied | null {
  const claims = message
    .split(/(?<=[.!?])\s+|\n+/)
    .some((s) => CLAIMS_GROWTH.test(plain(s)) && !NO_CLAIM.test(plain(s)));
  if (!claims) return null;
  const fact = facts.find(tellsDecline);
  if (fact === undefined) return null;
  const opens = asksFor(message) ? 'Not quite, by your own record:' : 'Your own record says otherwise:';
  const text = `${opens} ${bare(fact).replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase())}. Say both numbers, before somebody else does.`;
  return { text: upperFirst(text), voice: upperFirst(text) };
}
