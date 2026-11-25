/**
 * Business words a first-time founder is told the meaning of the first time they are used (in ten words or fewer). The
 * server's own lines say it themselves, and so does a sentence of the model's that used one without its meaning.
 */
interface Term {
  readonly id: string;
  readonly said: RegExp;
  readonly means: string;
}

const TERMS: readonly Term[] = [
  {
    id: 'value proposition',
    said: /\bvalue prop(?:osition)?s?\b/iu,
    means: 'one sentence on who you help and how',
  },
  {
    id: 'jobs pains gains',
    said: /\bjobs?, (?:the )?(?:\w+ )?pains? and (?:the )?(?:\w+ )?gains?\b/iu,
    means: 'what they try to do, what hurts, what they want',
  },
  { id: 'unit economics', said: /\bunit economics\b/iu, means: 'what one sale leaves after its costs' },
  {
    id: 'canvas',
    said: /\bbusiness model canvas\b/iu,
    means: 'one page on how the venture works and gets paid',
  },
  {
    id: 'mvp',
    said: /\bMVPs?\b|\bminimum viable product\b/u,
    means: 'the smallest version that tests the idea',
  },
  { id: 'beachhead', said: /\bbeachhead\b/iu, means: 'the first small group you win' },
  { id: 'loi', said: /\bLOIs?\b|\bletters? of intent\b/u, means: 'a signed note that they plan to buy' },
  {
    id: 'pass line',
    said: /\bpass lines?\b/iu,
    means: 'the number that means it worked, set before you start',
  },
  { id: 'churn', said: /\bchurn\b/iu, means: 'customers who stop buying' },
  { id: 'runway', said: /\brunway\b/iu, means: 'how long the money lasts' },
  { id: 'burn rate', said: /\bburn rate\b/iu, means: 'what you spend in a month' },
  { id: 'margin', said: /\b(?:gross|contribution) margins?\b/iu, means: 'the share of the price you keep' },
  { id: 'break-even', said: /\bbreak[- ]?even\b/iu, means: 'where sales cover the costs' },
  { id: 'cac', said: /\bCAC\b|\bcustomer acquisition cost\b/u, means: 'what it costs to win one customer' },
  { id: 'ltv', said: /\bLTV\b|\blifetime value\b/u, means: 'what one customer leaves you in all' },
  {
    id: 'tam',
    said: /\bTAM\b|\btotal addressable market\b/u,
    means: 'everyone who could ever buy it, in money',
  },
  { id: 'gtm', said: /\bgo-to-market\b|\bGTM\b/u, means: 'how you reach and win buyers' },
  {
    id: 'pmf',
    said: /\bproduct[- ]market fit\b|\bPMF\b/u,
    means: 'people want it enough to pull it from you',
  },
  { id: 'cap table', said: /\bcap table\b/iu, means: 'the list of who owns which share' },
  { id: 'dilution', said: /\bdilut(?:ion|ed|es)\b/iu, means: 'your share shrinks when new shares are sold' },
  { id: 'vesting', said: /\bvest(?:ing|s)\b/iu, means: 'shares earned over time' },
  { id: 'term sheet', said: /\bterm sheets?\b/iu, means: 'the main points of an investment deal' },
  { id: 'seed', said: /\b(?:pre-)?seed (?:round|funding|stage)\b/iu, means: 'the first outside investment' },
  { id: 'early adopter', said: /\bearly adopters?\b/iu, means: 'people who try new things first' },
  { id: 'icp', said: /\bICP\b|\bideal customer profile\b/u, means: 'the customer you serve best' },
  { id: 'kpi', said: /\bKPIs?\b/u, means: 'the number you watch' },
  { id: 'recurring', said: /\b(?:ARR|MRR)\b/u, means: 'revenue that repeats each year or month' },
  { id: 'b2b', said: /\bB2B\b/u, means: 'selling to businesses' },
  { id: 'b2c', said: /\bB2C\b/u, means: 'selling to people' },
  {
    id: 'provisional',
    said: /\bprovisional (?:patent|application)\b/iu,
    means: 'a first filing that holds a date',
  },
  { id: 'smoke test', said: /\bsmoke test\b/iu, means: 'an offer shown before it exists, to count takers' },
  { id: 'concierge', said: /\bconcierge (?:test|mvp)\b/iu, means: 'doing it by hand first' },
];

/** What already tells its meaning where it stands. */
const DEFINED_AFTER =
  /^["”'’)*_]*\s*(?:\(|[-–—:=]|,? ?(?:which|that|this) (?:is|means)|,? ?meaning\b|,? ?i\.e\.|,? ?that is|means?\b|is (?:a|an|the|one|what|how|when|just|simply|your)\b|,? or\b)/iu;
const DEFINED_BEFORE =
  /(?:called|known as|that(?:['’]s| is) (?:a|the|your)|\(|,? or) (?:an?|the|your)?\s*["“*_]*$/iu;

/** The business words a text uses. */
export function termsIn(text: string): Set<string> {
  return new Set(TERMS.filter((t) => t.said.test(text)).map((t) => t.id));
}

/** `text` with the meaning of each word of the list after its first use, when `known` does not hold it (it then does). */
export function withMeanings(text: string, known: Set<string>, spoken = false): string {
  let out = text;
  for (const term of TERMS) {
    if (known.has(term.id)) continue;
    const m = term.said.exec(out);
    if (m === null) continue;
    known.add(term.id);
    const end = m.index + m[0].length;
    const after = out.slice(end);
    if (DEFINED_AFTER.test(after) || DEFINED_BEFORE.test(out.slice(0, m.index))) continue;
    const tail = /^[*_"”’]*/u.exec(after)?.[0].length ?? 0;
    const at = end + tail;
    out = spoken
      ? `${out.slice(0, at)}, ${term.means}${/^[.,;:!?]/u.test(out.slice(at)) ? '' : ','}${out.slice(at)}`
      : `${out.slice(0, at)} (${term.means})${out.slice(at)}`;
  }
  return out;
}
