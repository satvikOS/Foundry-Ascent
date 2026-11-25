import {
  LOST,
  nounOf,
  quantitiesIn,
  ratiosIn,
  readText,
  saidNumbers,
  type Count,
  type Loose,
  type Period,
  type Quantity,
  type QuantityRole,
  type Ratio,
  type Read,
} from './calc-read.js';
import { singular } from './words.js';

export { quantitiesIn, ratiosIn, saidNumbers, type Period, type Quantity, type QuantityRole, type Ratio };

/**
 * Sums a student asks for, worked out by code from their own words: what one sale leaves, a margin, so many of them, a
 * month, a break-even, an hour, a share, what a customer cost to win, the price for a margin, a payback, a runway. The
 * reply opens with them only when they are sure: every number's role is said (calc-read.ts), no other amount of the same
 * text is left unplaced, and the numbers can be read one way only. When they are not (`unsure`) nothing is told here: the
 * model answers with a sum of its own in a marker, which code works out (`@foundry/ai` validators/sums.ts). A sum below
 * zero is told only when both the price and the costs are said in so many words. Pure: the same words, the same lines.
 */

export type CalcAsk =
  | 'contribution'
  | 'margin'
  | 'total'
  | 'monthly'
  | 'revenue'
  | 'income'
  | 'break_even'
  | 'hourly'
  | 'slot_price'
  | 'conversion'
  | 'churn'
  | 'same_rate'
  | 'compare'
  | 'acquisition'
  | 'target_price'
  | 'start'
  | 'payback'
  | 'runway'
  | 'time';

export interface CalcInput {
  readonly message: string;
  /** The founder's earlier messages, oldest first. */
  readonly earlier?: readonly string[];
  /** What the record and the intake hold, oldest first: read before anything they said here. */
  readonly record?: readonly string[];
  /** What they ask for when the message itself does not say it (the play of their ask: unit economics). */
  readonly ask?: CalcAsk | null;
}

export interface CalcResult {
  /** What they ask to have worked out; null: they ask for no sum. */
  readonly ask: CalcAsk | null;
  /** The lines to say, word for word: the asked one first. Empty when it is not sure. */
  readonly lines: readonly string[];
  /** The one number that is missing, as the question to ask; null when nothing is. */
  readonly missing: string | null;
  /** They ask for a sum, and their words can be read more than one way: the model answers it. */
  readonly unsure?: boolean;
}

// What they ask ------------------------------------------------------------------------------------------------------

const ASKS: readonly (readonly [CalcAsk, RegExp])[] = [
  [
    'target_price',
    /\b(?:charge|price|ask for|sell (?:it|them|one) (?:for|at)|set (?:it|my price|the price))\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:to|for|at|with|if i want|gives?|gets?)\b(?:[^?.!]|\.(?=\d)){0,160}?\b\d+(?:\.\d+)? ?(?:%|percent)/,
  ],
  [
    'acquisition',
    /\bwhat (?:did|does) (?:an?|each|1|every) (?:new )?(?:customer|order|client|buyer|sign-?up|user|subscriber|member) cost\b|\bcost\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:to )?(?:win|get|land|acquire|find|sign|bring in|gain)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:customers?|orders?|clients?|buyers?|sales?|sign-?ups?|users?|subscribers?|members?|one)\b|\bcac\b|\bcustomer acquisition costs?\b|\bcosts? (?:per|of (?:a|each|one)) (?:new |won )?(?:customer|order|client|buyer|sign-?up|user|subscriber|member)\b|\b(?:spend|spent|pay|paid) (?:per|for each|for every) (?:new )?(?:customer|order|client|buyer|sign-?up|user|subscriber)\b/,
  ],
  [
    'same_rate',
    /\b(?:the )?same (?:share|rate|percent\w*|proportion|pace|churn)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:again|next|leaves?|leave|cancels?|continues?|keeps?|quits?|drops?)\b|\bif (?:that|this) (?:share|rate|percent\w*|proportion) (?:leaves?|cancels?|continues?|keeps? (?:up|going)|quits?|drops?)\b/,
  ],
  [
    'churn',
    /\bchurn(?: rate)?\b|\b(?:share|percent|percentage|fraction|proportion|part|what rate)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:los[et]|lost|cancel\w*|left|quit|drop(?:ped|s)? (?:out|off))\b/,
  ],
  [
    'break_even',
    /\bbreak[- ]?even\b|\bhow many\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:to (?:cover|pay (?:for|off)|earn back|make back|break even)|(?:cover|covers|pay for|pays for|pay back)|(?:paid|pays?|pay) (?:for )?(?:itself|for itself|it ?self off)|paid for itself|paid off)\b|\bhow many (?:\w+ )?(?:do|would|must|should) (?:i|we) (?:have to|need to|must)? ?sell\b/,
  ],
  [
    'payback',
    /\bpay ?back\b|\b(?:how long|when)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:earn|make|get|pay) (?:it|that|the \w+|my money|this|them)? ?(?:back|off)\b|\bpays? for itself\b/,
  ],
  [
    'runway',
    /\brunway\b|\bhow long\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:money|cash|savings?|budget)\b(?:[^?.!]|\.(?=\d)){0,160}\blast\b|\bhow many months (?:do|can|will) (?:i|we) (?:last|survive|keep going|afford|run|have left)\b/,
  ],
  [
    'slot_price',
    /\b(?:how much|what)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:quarter[- ](?:of an )?hour|15 minutes|20 minutes|30 minutes|10 minutes|45 minutes)\b/,
  ],
  [
    'hourly',
    /\bhourly\b|\b(?:what|how much)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:per|an|each) hour\b(?:[^?.!]|\.(?=\d)){0,160}\?|\bwhat (?:do|am|would|are) (?:i|we) (?:earn|make|making|earning|get)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:an|per) hour\b/,
  ],
  [
    'conversion',
    /\bconversion\b|\bwhat (?:percent|percentage|share|fraction|proportion|part)\b|\b(?:close|response|success|reply) rate\b/,
  ],
  ['margin', /\bmargins?\b|\bmark-?up\b/],
  [
    'start',
    /\bhow much (?:money |cash )?(?:do|would|will) (?:i|we) need\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:start|started|begin|launch|open)\b|\b(?:what|how much)\b(?:[^?.!]|\.(?=\d)){0,160}\bstart-?up costs?\b/,
  ],
  [
    'income',
    /\b(?:how much|what)(?: money)?(?: is| am i| are we)?\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:coming in|comes? in|taking in)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:a|per|each|every|this|next) month\b|\b(?:monthly|recurring) (?:revenue|income)\b|\b(?:how much|what)(?: money)? (?:comes?|is coming) in(?: now| each| every| a| per| this| after| these|\s*\?)/,
  ],
  [
    'revenue',
    /\b(?:how much|what)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:revenue|turnover|in sales)\b|\bif (?:i|we) (?:sell|sold) \d+\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:covered|covers?|pays? for|paid for|right|correct)\b(?:[^?.!]|\.(?=\d)){0,40}\?/,
  ],
  [
    'monthly',
    /\b(?:how much|what)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:make|making|earn|earning|left|profit|keep|keeping|bring in|bringing in|get|getting|net|clear|stay)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:a|per|each|every|in a|in one|in 1|for the) (?:month|week|year)\b|\b(?:monthly|weekly|yearly) (?:profit|earnings|income|total)\b|\b(?:month|week)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:make|earn|profit)\b(?:[^?.!]|\.(?=\d)){0,160}\?/,
  ],
  [
    'time',
    /\bhow (?:long|many hours|much time)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:would|will|does|do|to make|to do|for)\b(?:[^?.!]|\.(?=\d)){0,160}\b\d+\b/,
  ],
  [
    'total',
    /\b(?:how much|what)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:left|make|makes|profit|earn|keep|clear|stays?|remains?|get)\b(?:[^?.!]|\.(?=\d)){0,160}(?:\b(?:on|from|for|with|at|if|of) (?:(?:i|we) )?(?:(?:sell|sold|do|make) )?\d+\b)|\b(?:if|say|suppose|when) (?:(?:i|we) )?(?:sell|sold|do|make) \d+\b(?:[^?.!]|\.(?=\d)){0,160}?[?.,;](?:[^?.!]|\.(?=\d)){0,160}\b(?:how much|what)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:left|make|profit|earn|keep|clear|stays?|remains?)\b|\b(?:if|say|suppose|when) (?:(?:i|we) )?(?:sell|sold|do|make) \d+\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:how much|what)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:left|make|profit|earn|keep|clear|stays?|remains?)\b/,
  ],
  [
    'contribution',
    /\bunit economics\b|\bcontribution\b|\b(?:how much|what)(?: money)?\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:left|make|makes|making|profit|earn|earning|keep|keeping|clear|stays?|remains?)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:per|on (?:each|one|every|1|an?)|from (?:each|one|every|1|an?)|for (?:each|one|1)|each|a|one|1) (?!month|week|year|hour|day)\w+|\bprofit (?:per|on (?:each|one|every|1)|a) (?!month|week|year|hour|day)\w+|\bwhat (?:is left|would be left|would (?:i|we) (?:make|keep|have left)|do i (?:make|keep)|am i left with)(?=\s*(?:\?|$|on\b|per\b|from\b|for (?:me|us|each|one|1)\b|after\b|each\b|then\b|if\b|at\b|\.))|\bwork out (?:my|the|our) (?:numbers|margin|costs|profit)\b|\bam i (?:making|losing) money\b|\bdo i (?:make|lose) money\b/,
  ],
];

/** Somebody else's numbers, or what a word means: no sum of theirs. */
const NOT_THEIRS =
  /\b(?:good|typical|normal|average|usual|industry|healthy|standard|decent|fair|realistic|better|higher) (?:\w+ ){0,2}?(?:margins?|revenue|sales|goals?|targets?|rates?|conversion|churn|runway|mark-?up|payback|break[- ]?even|profit|cac|share|percent\w*)\b|\bwhat (?:is|are|does) (?:an? |the (?:word|term) )?(?:gross |net )?(?:margins?|break[- ]?even|contribution|unit economics|runway|conversion(?: rate)?|churn(?: rate)?|cac|payback|mark-?up)(?: mean)?\s*(?:\?|$|in plain|exactly|again in)|\bmargin of (?:error|safety)\b|\b(?:share|percent|percentage|fraction|part)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:equity|co-?founders?|ownership|stake|company|investors?|my (?:time|day|week|budget)|profit|give)\b|\bwhat (?:do|does|did|would|will|can|could) (?!(?:i|we|you|1|one|it|an?|each|every|my|our|the|that|this|selling)\b)[a-z]+(?: [a-z]+)? (?:make|earn|keep|charge|get|clear|profit)\b|\b(?:explain|define|meaning of|difference between)\b|\b(?:other|most|typical|successful|real) (?:\w+ )?(?:founders?|bakers?|bakeries|cafes?|startups?|companies|businesses|people|sellers|makers|teams|shops|competitors)\b(?:[^?.!]|\.(?=\d)){0,160}\b(?:make|earn|charge|keep|margin|convert)/;

/** What the message asks to have worked out; null: no sum. */
export function calcAsked(message: string): CalcAsk | null {
  const t = saidNumbers(message);
  if (NOT_THEIRS.test(t)) return null;
  const found = ASKS.find(([, pattern]) => pattern.test(t))?.[0] ?? null;
  // "On 1 kit" is what one leaves.
  if (
    found === 'total' &&
    !/(?<![\d.$])(?!1\b)\d+(?![\d.]| ?(?:%|percent))/.test(t.replace(/\$\d[\d.~]*/g, '$'))
  )
    return 'contribution';
  if (found === 'payback' && /\bhow many (?!months?|weeks?|days?|years?)/.test(t)) return 'break_even';
  if (found !== null) return found;
  return pairAsked(t) === null ? null : 'compare';
}

/** "North or south?", "the shop or the market?": the two they ask about, in one word each. */
function pairAsked(t: string): readonly [string, string] | null {
  const m =
    /(?:^|[.,;:!?] ?|\bwhich\b(?:[^?.!]|\.(?=\d)){0,160}?,? ?|\bshould (?:i|we) (?:go|pick|choose|take|do|start)(?: with| for| in)? )(?:the )?([a-z]+)(?: [a-z]+)? or (?:the )?([a-z]+)(?: [a-z]+)?\s*\??$/.exec(
      t.trim(),
    );
  return m?.[1] === undefined || m[2] === undefined || m[1] === m[2] ? null : [m[1], m[2]];
}

/** The sums a follow-up can go on from ("and if I do sixty a week?"). */
const GOES_ON: ReadonlySet<CalcAsk> = new Set<CalcAsk>([
  'contribution',
  'margin',
  'total',
  'monthly',
  'revenue',
  'break_even',
]);
const FOLLOWS =
  /^(?:(?:and|so|ok|okay|but|then|now|hmm|right)[, ]+)*(?:(?:(?:what |how )?(?:about|if)|at|with|say|for|on|suppose)\b|\d+ (?:of (?:them|those|these)|more)\b)/;

/** What a follow-up asks for: the sum of the turn before, with the number it brings. */
function followed(input: CalcInput): CalcAsk | null {
  const t = saidNumbers(input.message);
  if (!FOLLOWS.test(t) || !/\d/.test(t) || t.split(' ').length > 14) return null;
  const before = [...(input.earlier ?? [])].slice(-3).reverse();
  for (const text of before) {
    const ask = calcAsked(text);
    if (ask !== null && !GOES_ON.has(ask)) return null;
    if (ask !== null) {
      const brings = readText(input.message, true);
      const volume = brings.quantities.find((q) => q.role === 'volume');
      // An amount with no role of its own ("and at 18 dollars?") is the same sum, and not sure.
      if (volume === undefined)
        return brings.loose.length > 0 ||
          brings.quantities.some((q) => q.role === 'price' || q.role === 'unit_cost')
          ? ask
          : null;
      if (ask === 'revenue') return ask;
      return volume.period === null ? 'total' : 'monthly';
    }
    // Only a message that told something stands between the two.
    if (text.includes('?')) return null;
  }
  return null;
}

// Said ---------------------------------------------------------------------------------------------------------------

export function money(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const abs = Math.abs(rounded);
  const text = Number.isInteger(abs)
    ? abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d)(?=\.))/g, ',');
  return `${rounded < 0 ? '-' : ''}$${text}`;
}

function number(value: number, places = 1): string {
  const f = 10 ** places;
  const r = Math.round(value * f) / f;
  return Number.isInteger(r)
    ? r.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : r.toFixed(places).replace(/0+$/, '');
}
export function percent(part: number, whole: number): string {
  const exact = (part / whole) * 100;
  const tenth = Math.round(exact * 10) / 10;
  // "3.75%", "6.7%", "67%" of a few, "68.8%" of hundreds.
  if (exact < 5) return `${number(exact, 2)}%`;
  return `${number(whole >= 100 || Math.abs((tenth % 1) - 0.5) < 1e-9 || tenth < 10 ? tenth : Math.round(exact))}%`;
}
const range = (low: number, high: number): string =>
  low === high ? money(low) : `${money(low)} to ${money(high)}`;
const plural = (noun: string): string =>
  /(?:s|x|ch|sh|z)$/.test(noun)
    ? `${noun}es`
    : /[^aeiou]y$/.test(noun)
      ? `${noun.slice(0, -1)}ies`
      : `${noun}s`;

// Their numbers put together -----------------------------------------------------------------------------------------

/** Their numbers put together: the latest said of each wins. */
interface Book {
  readonly reads: readonly Read[];
  readonly noun: string | null;
  /** More than one thing they sell, and no word of which. */
  readonly nouns: readonly string[];
  readonly price: Quantity | null;
  readonly costs: readonly Quantity[];
  /** The parts of the price somebody else takes, in percent. */
  readonly shares: readonly Quantity[];
  /** What one sale costs or brings can be read more than one way. */
  readonly doubt: boolean;
  /** An amount nobody could place stands in their words: nothing is missing, it is unclear. */
  readonly unplaced: boolean;
  /** Two fixed costs of one name. */
  readonly fixedDoubt: boolean;
  readonly periodCosts: readonly Quantity[];
  readonly oneTime: readonly Quantity[];
  readonly volume: Quantity | null;
  readonly unitTime: Quantity | null;
  readonly weekHours: Quantity | null;
  readonly cash: Quantity | null;
  readonly revenue: Quantity | null;
  readonly here: Read;
  /** They sell it by the quarter hour. */
  readonly quarter: boolean;
}

/** What one is, in the question itself ("what do I make per cookie?"). */
function nounAsked(asked: string): string | null {
  return nounOf(
    /\b(?:per|on (?:each|1|every|an?)|from (?:each|1|every|an?)|for (?:1|each)|on) ([a-z-]+)(?=\W|$)/.exec(
      asked,
    )?.[1],
  );
}

type Placed = Quantity & { readonly source: number };

const keyOf = (label: string): string => singular(label.split(' ').at(-1) ?? '');

/** The costs of one, from every text that tells them: the newest word of each part stands. */
function costsOf(
  found: readonly Placed[],
  priceSource: number | null,
  noun: string | null,
): { readonly costs: readonly Placed[]; readonly doubt: boolean } {
  const sources = [...new Set(found.map((q) => q.source))].sort((a, b) => a - b);
  let parts = new Map<string, Placed>();
  let doubt = false;
  for (const source of sources) {
    const here = found.filter((q) => q.source === source);
    const own = new Map<string, Placed>();
    for (const q of here) {
      const key = keyOf(q.label);
      const twin = own.get(key);
      // Two different costs of one name, in one breath.
      if (twin !== undefined && (twin.low !== q.low || twin.high !== q.high)) doubt = true;
      own.set(key, q);
    }
    if (own.has('') && own.size > 1) {
      // "Each costs me 9: 6 for clay and 3 for glaze": the whole and its parts, or one more cost?
      const whole = own.get('');
      const rest = [...own.entries()].filter(([k]) => k !== '').reduce((sum, [, q]) => sum + q.low, 0);
      if (whole !== undefined && Math.abs(whole.low - rest) < 0.005) own.delete('');
      else if (![...own.values()].some((q) => q.added === true)) doubt = true;
    }
    if (parts.size === 0 || source === priceSource) {
      // The text that tells the price tells its costs too.
      if (
        source === priceSource &&
        parts.size > 0 &&
        [...own.keys()].every((k) => !parts.has(k)) &&
        !own.has('')
      ) {
        const sum = (m: ReadonlyMap<string, Placed>): number =>
          [...m.values()].reduce((t, q) => t + q.low, 0);
        if (sum(own) !== sum(parts)) {
          if ([...own.values()].every((q) => q.added === true)) {
            for (const [k, q] of own) parts.set(k, q);
            continue;
          }
        }
      }
      parts = own;
      continue;
    }
    if (own.has('') && own.size === 1) {
      parts = own;
      continue;
    }
    if (parts.has('')) {
      // One part named after a whole: part of it, or the new whole?
      if ([...own.values()].every((q) => q.added === true)) {
        for (const [k, q] of own) parts.set(k, q);
        continue;
      }
      if (own.size < 2) doubt = true;
      parts = own;
      continue;
    }
    for (const [key, q] of own) {
      const known = parts.has(key);
      const more = q.added === true || (q.soft !== true && q.noun !== null && q.noun === noun);
      const twin = [...parts.values()].some((p) => p.low === q.low && p.high === q.high);
      if (!known && !more) doubt = true;
      // The same amount under another name may be the same cost.
      if (!known && twin && q.added !== true && q.noun !== noun) doubt = true;
      parts.set(key, q);
    }
  }
  return { costs: [...parts.values()], doubt };
}

function bookOf(input: CalcInput, ask: CalcAsk | null): Book {
  const texts = [...(input.record ?? []), ...(input.earlier ?? []), input.message];
  const reads = texts.map((t, i) => readText(t, ask !== null && i === texts.length - 1));
  const here = reads.at(-1) ?? readText('');
  const records = (input.record ?? []).length;
  const quantities: Placed[] = reads.flatMap((r, source) => r.quantities.map((q) => ({ ...q, source })));
  const last = <T>(xs: readonly T[]): T | null => xs.at(-1) ?? null;
  const prices = quantities.filter((q) => q.role === 'price' && q.period === null);
  const priced = [...new Set(prices.flatMap((p) => (p.noun === null ? [] : [p.noun])))];
  const asked = saidNumbers(input.message);
  const namedHere = priced.filter((n) => new RegExp(`\\b${n}(?:e?s)?\\b`).test(asked));
  const nouns = namedHere.length > 0 ? namedHere : priced;
  const noun = nouns.length === 1 ? (nouns[0] ?? null) : nouns.length === 0 ? nounAsked(asked) : null;
  const fits = (q: Quantity): boolean => q.noun === null || noun === null || q.noun === noun;
  const fitting = prices
    .filter((p) => nouns.length <= 1 || (p.noun !== null && nouns.includes(p.noun)))
    .filter(fits);
  let price = last(fitting);
  let doubt = false;
  if (price !== null) {
    const at = price.source;
    const same = fitting.filter((p) => p.source === at);
    // Two prices in one breath.
    if (new Set(same.map((p) => `${String(p.low)}~${String(p.high)}`)).size > 1) doubt = true;
    // Two entries of the record with two prices, and no word that one has changed.
    const others = fitting.filter(
      (p) => p.source !== at && p.source < records && (p.low !== price?.low || p.high !== price.high),
    );
    if (at < records && others.length > 0 && reads[at]?.updates !== true) doubt = true;
    // A price only its shape gives ("$4 a cup"), beside one said in words.
    const said = last(fitting.filter((p) => p.soft !== true && p.source === at));
    if (price.soft === true && said !== null) price = said;
  }
  // "A delivery is 9 dollars; the rider gets 6": with a cost beside it and no price said anywhere, what one brings.
  let bare: { readonly loose: Loose; readonly source: number } | null = null;
  if (price === null) {
    for (const [source, r] of reads.entries()) {
      const bares = r.loose.filter((l) => l.kind === 'bare' && (noun === null || l.noun === noun));
      const explicit = r.quantities.filter((q) => q.role === 'unit_cost' && q.soft !== true);
      const only = bares[0];
      if (
        only?.first === true &&
        bares.length === 1 &&
        r.loose.length === 1 &&
        explicit.length > 0 &&
        // What others get of it is less than it.
        explicit.reduce((sum, q) => sum + q.high, 0) < only.value
      )
        bare = { loose: only, source };
    }
    if (bare !== null)
      price = {
        role: 'price',
        low: bare.loose.value,
        high: bare.loose.value,
        noun: bare.loose.noun,
        period: null,
        label: '',
        soft: true,
        source: bare.source,
      };
  }
  const thing = noun ?? price?.noun ?? null;
  const unit = (q: Quantity): boolean => q.noun === null || thing === null || q.noun === thing;
  const costFound: Placed[] = [];
  for (const q of quantities.filter((x) => x.role === 'unit_cost')) {
    // "The bag costs $1" of a kit: a part of it, unless the bag is sold by itself.
    const part = !unit(q) && q.noun !== null && !priced.includes(q.noun);
    if (!part && !unit(q)) continue;
    costFound.push(part && q.label === '' ? { ...q, label: q.noun } : q);
  }
  const merged = costsOf(costFound, price?.source ?? null, thing);
  // The same cost told twice on record, two ways.
  for (const q of merged.costs)
    if (
      q.source < records &&
      reads[q.source]?.updates !== true &&
      costFound.some(
        (o) =>
          o.source < q.source && keyOf(o.label) === keyOf(q.label) && (o.low !== q.low || o.high !== q.high),
      )
    )
      doubt = true;
  if (merged.doubt) doubt = true;
  const used = new Set(merged.costs.map((c) => c.source));
  if (price !== null) used.add(price.source);
  const shares = quantities.filter((q) => q.role === 'unit_share' && used.has(q.source));
  if (new Set(shares.map((q) => q.label)).size < shares.length) doubt = true;
  // An amount of the same words that nobody could place, or a cost that is one only beside a price.
  const placedValues = new Set(
    quantities.flatMap((q) => [q.low, q.high]).concat(bare === null ? [] : [bare.loose.value]),
  );
  const unplacedIn = (r: Read): boolean => r.loose.some((l) => !placedValues.has(l.value));
  const last_ = reads.length - 1;
  for (const [source, r] of reads.entries()) {
    if (!used.has(source) && source !== last_) continue;
    if (unplacedIn(r) || r.percentLoose) doubt = true;
    // "Ink 1.25", "printing 5": a number beside the price with no word of what it is.
    if (
      used.has(source) &&
      r.counts.some(
        (c) =>
          c.bare &&
          c.value !== 1 &&
          !(c.value >= 1900 && c.value <= 2100) &&
          !placedValues.has(c.value) &&
          !r.ratios.some((x) => x.part === c.value || x.whole === c.value),
      )
    )
      doubt = true;
  }
  if (price !== null) {
    // "A kit costs 9", "clay is 6" with the price in another text: of one of them?
    const at = price.source;
    const told = new Set(prices.map((p) => p.source));
    if (merged.costs.some((c) => c.soft === true && c.source !== at && !told.has(c.source))) doubt = true;
  }
  // A wage by the hour, in the same words: how long one takes decides.
  if (
    quantities.some(
      (q) => q.role === 'period_cost' && q.period === 'hour' && (used.has(q.source) || q.source === last_),
    )
  )
    doubt = true;
  if (reads.some((r) => r.foreign)) doubt = true;
  let unlabelled = false;
  const byLabel = (role: QuantityRole): Placed[] => {
    const out = new Map<string, Placed>();
    for (const q of quantities.filter((x) => x.role === role)) {
      const twin = out.get(keyOf(q.label));
      // Two costs of one name in one breath: one of them, or both?
      if (twin?.source === q.source && twin.low !== q.low && twin.period === q.period) unlabelled = true;
      if (q.role === 'period_cost' && q.soft === true) unlabelled = true;
      out.set(keyOf(q.label), q);
    }
    return [...out.values()];
  };
  const periodCosts = byLabel('period_cost');
  const oneTime = byLabel('one_time');
  const volumes = quantities.filter((q) => q.role === 'volume' && unit(q));
  const volumeHere = volumes.filter((q) => q.source === last_);
  if (new Set(volumeHere.map((q) => q.low)).size > 1 && volumeHere.every((q) => q.soft !== true))
    doubt = true;
  const sureVolumes = volumeHere.filter((q) => q.soft !== true);
  return {
    reads,
    noun: thing ?? last(quantities.filter((q) => q.role === 'unit_cost' && q.noun !== null))?.noun ?? null,
    nouns,
    price,
    costs: merged.costs,
    shares,
    doubt,
    unplaced:
      reads.some((r) => unplacedIn(r) || r.foreign) ||
      // "Blanks 7, printing 5": numbers with a price beside them and no unit.
      reads.some(
        (r) =>
          (r.quantities.some((q) => q.role === 'price') || r === here) &&
          r.counts.some(
            (c) =>
              c.bare &&
              c.value !== 1 &&
              !r.quantities.some((q) => q.low === c.value || q.low === c.value * 60),
          ),
      ) ||
      (price === null && merged.costs.some((c) => c.soft === true)) ||
      quantities.some(
        (q) => (q.role === 'price' && q.period !== null) || (q.role === 'period_cost' && q.soft === true),
      ),
    periodCosts,
    oneTime,
    fixedDoubt: unlabelled,
    volume: last(sureVolumes) ?? last(volumeHere) ?? last(volumes.filter((q) => q.soft !== true)),
    unitTime: last(quantities.filter((q) => q.role === 'unit_time')),
    weekHours: last(quantities.filter((q) => q.role === 'week_hours')),
    cash: last(quantities.filter((q) => q.role === 'cash')),
    revenue: last(quantities.filter((q) => q.role === 'revenue' && q.period !== 'hour')),
    here,
    quarter: texts.some((t) =>
      /\bby the quarter[- ]hour\b|\bquarter[- ]hour(?:s|ly)?\b/.test(saidNumbers(t)),
    ),
  };
}

interface Left {
  readonly low: number;
  readonly high: number;
  readonly line: string;
}

const one = (b: Book): string => b.noun ?? 'sale';
const many = (b: Book, n: number): string => (n === 1 ? one(b) : plural(one(b)));

/** What one sale leaves, with its working. */
function leftOf(b: Book): Left | null {
  const { price, costs, shares } = b;
  if (price === null || costs.length + shares.length === 0) return null;
  const taken = shares.map((x) => ({ x, amount: (price.low * x.low) / 100 }));
  if (shares.length > 0 && price.low !== price.high) return null;
  const off = taken.reduce((sum, t) => sum + t.amount, 0);
  const low = price.low - costs.reduce((sum, c) => sum + c.high, 0) - off;
  const high = price.high - costs.reduce((sum, c) => sum + c.low, 0) - off;
  const working = [
    `${range(price.low, price.high)} price`,
    ...costs.map((c) => `${range(c.low, c.high)} ${c.label === '' ? 'cost' : c.label}`),
    ...taken.map((t) => `${money(t.amount)} ${t.x.label} (${number(t.x.low)}%)`),
  ].join(' - ');
  const result =
    high < 0 ? `${range(low, high)}: each ${one(b)} loses money` : `${range(low, high)} left per ${one(b)}`;
  return { low, high, line: `${working} = ${result}.` };
}

const whatIsMissing = {
  price: (b: Book) => `What do you charge for one ${one(b)}?`,
  cost: (b: Book) => `What does one ${one(b)} cost you to make and deliver?`,
  volume: (b: Book) => `How many ${plural(one(b))} do you sell in a month?`,
  oneTime: () => 'What is the one-time cost you want to earn back?',
  time: (b: Book) => `How long does one ${one(b)} take you?`,
  cash: () => 'How much money do you have for this now?',
  monthlyCost: () => 'What do you spend on it in a month?',
  ratio: () => 'How many did you ask, and how many said yes with money?',
  which: (b: Book) => `Which one: ${b.nouns.map(plural).join(' or ')}?`,
  batch: (b: Book, batch: string) => `How many ${plural(one(b))} do you sell in one ${batch}?`,
} as const;

interface Sum {
  readonly lines: string[];
  readonly missing: string | null;
  readonly unsure: boolean;
}
const need = (missing: string, lines: string[] = []): Sum => ({ lines, missing, unsure: false });
const got = (...lines: string[]): Sum => ({ lines, missing: null, unsure: false });
const UNSURE: Sum = { lines: [], missing: null, unsure: true };
/** Nothing they said is what the sum would be of: no sum is asked. */
const NO_SUM: Sum = { lines: [], missing: null, unsure: false };
/** A number is asked for only when nothing they said could be it. */
const lacks = (b: Book, missing: string, lines: string[] = []): Sum =>
  b.unplaced || b.doubt ? UNSURE : need(missing, lines);

function perMonth(q: Quantity): { readonly value: number; readonly label: string } | null {
  if (q.period === 'month') return { value: q.low, label: 'a month' };
  if (q.period === 'week') return { value: q.low * 4, label: 'in four weeks' };
  return null;
}

/** What one sale leaves, when it may be told: both its sides said, read one way only. */
function sureLeft(b: Book): Left | null {
  const left = leftOf(b);
  if (left === null || b.doubt) return null;
  // At or below zero only when both sides are said in so many words.
  if (left.low <= 0 && (b.price?.soft === true || b.costs.some((c) => c.soft === true))) return null;
  return left;
}

function contribution(b: Book): Sum {
  if (b.nouns.length > 1) return need(whatIsMissing.which(b));
  if (b.price === null) return lacks(b, whatIsMissing.price(b));
  const batched = b.costs.length === 0 ? b.periodCosts.filter((c) => c.batch !== undefined) : [];
  const batch = batched[0]?.batch;
  if (batch !== undefined) {
    // A cost of a whole morning: what one leaves needs how many a morning sells.
    if (b.volume?.batch !== batch) return b.doubt ? UNSURE : need(whatIsMissing.batch(b, batch));
    const n = b.volume.low;
    const out = batched.reduce((sum, c) => sum + c.low, 0);
    const named = batched.map((c) => (c.label === '' ? 'costs' : c.label)).join(' and ');
    if (b.doubt) return UNSURE;
    return got(
      `${number(n)} ${many(b, n)} x ${range(b.price.low, b.price.high)} - ${money(out)} ${named} = ${range(n * b.price.low - out, n * b.price.high - out)} left for one ${batch}.`,
    );
  }
  if (b.costs.length + b.shares.length === 0) return lacks(b, whatIsMissing.cost(b));
  const left = sureLeft(b);
  return left === null ? UNSURE : got(left.line);
}

function margin(b: Book): Sum {
  const base = contribution(b);
  const left = leftOf(b);
  if (base.missing !== null || base.unsure || left === null || b.price === null) return base;
  if (left.low !== left.high || b.price.low !== b.price.high) return base;
  return got(
    left.line,
    `Margin: ${money(left.low)} of ${money(b.price.low)} = ${percent(left.low, b.price.low)} of the price.`,
  );
}

/** The one-time costs a message brings, or names by their word. */
function namedOnce(b: Book, message: string): readonly Quantity[] {
  const t = saidNumbers(message);
  const here = b.here.quantities.filter((q) => q.role === 'one_time');
  if (here.length > 0) return here;
  return b.oneTime.filter((q) => {
    const word = keyOf(q.label);
    return word.length > 2 && new RegExp(`\\b${word}(?:e?s)?\\b`).test(t);
  });
}

/** So many of them, less a cost the message brings. */
function total(b: Book, message: string): Sum {
  const base = contribution(b);
  const left = sureLeft(b);
  if (base.missing !== null || base.unsure || left === null) return base;
  if (b.volume === null) return UNSURE;
  const n = b.volume.low;
  const once = namedOnce(b, message);
  // A cost a month beside so many of them: whose month?
  if (b.here.quantities.some((q) => q.role === 'period_cost' || q.role === 'spend' || q.role === 'cash'))
    return UNSURE;
  const out = once.reduce((sum, c) => sum + c.low, 0);
  const named = once.map((c) => (c.label === '' ? 'cost' : c.label)).join(' and ');
  const line =
    once.length === 0
      ? `${number(n)} ${many(b, n)} x ${range(left.low, left.high)} left per ${one(b)} = ${range(n * left.low, n * left.high)} before other costs.`
      : `${number(n)} ${many(b, n)} x ${range(left.low, left.high)} left per ${one(b)} - ${money(out)} ${named} = ${range(n * left.low - out, n * left.high - out)} left.`;
  return got(line, left.line);
}

function monthly(b: Book): Sum {
  const base = contribution(b);
  const left = sureLeft(b);
  if (base.missing !== null || base.unsure || left === null) return base;
  if (b.volume === null) return lacks(b, whatIsMissing.volume(b), [left.line]);
  const n = b.volume.low;
  const period = b.volume.period ?? 'month';
  if (period !== 'month' && period !== 'week' && period !== 'day' && period !== 'year')
    return need(whatIsMissing.volume(b), [left.line]);
  const low = n * left.low;
  const high = n * left.high;
  const when = period === 'month' ? 'a month' : `a ${period}`;
  const lines = [
    `${number(n)} ${many(b, n)} x ${range(left.low, left.high)} left per ${one(b)} = ${range(low, high)} ${when} before other costs.`,
  ];
  if (period === 'week') lines.push(`Four weeks of that: ${range(low * 4, high * 4)}.`);
  const fixed = b.periodCosts.filter((c) => c.period === 'month');
  if (period === 'month' && fixed.length > 0 && !b.fixedDoubt) {
    const out = fixed.reduce((sum, c) => sum + c.low, 0);
    const named = fixed.map((c) => (c.label === '' ? 'monthly costs' : c.label)).join(' and ');
    lines.push(`${range(low, high)} - ${money(out)} ${named} = ${range(low - out, high - out)} a month.`);
  }
  return got(...lines);
}

function revenue(b: Book, message: string): Sum {
  if (b.nouns.length > 1) return need(whatIsMissing.which(b));
  if (b.price === null) return lacks(b, whatIsMissing.price(b));
  if (b.doubt) return UNSURE;
  if (b.volume === null) return lacks(b, whatIsMissing.volume(b));
  // "If I sell 100": so many, not so many a month.
  const supposed = /\bif (?:i|we) (?:sell|sold) \d/.test(saidNumbers(message));
  const period = b.volume.period ?? (supposed ? 'other' : 'month');
  const n = b.volume.low;
  return got(
    `${number(n)} ${many(b, n)} x ${range(b.price.low, b.price.high)} = ${range(n * b.price.low, n * b.price.high)} ${period === 'other' ? '' : `a ${period} `}in sales, before any cost.`,
  );
}

function breakEven(b: Book, message: string): Sum {
  const base = contribution(b);
  if (base.missing !== null || base.unsure) return base;
  const left = sureLeft(b);
  if (left === null) return base;
  if (b.fixedDoubt) return UNSURE;
  if (left.low <= 0)
    return got(left.line, `No number of ${plural(one(b))} covers a cost while one ${one(b)} loses money.`);
  const t = saidNumbers(message);
  const named = (q: Quantity): boolean => {
    const word = keyOf(q.label);
    return word.length > 2 && new RegExp(`\\b${word}(?:e?s)?\\b`).test(t);
  };
  const hereCosts = b.here.quantities.filter(
    (q) => q.role === 'one_time' || (q.role === 'period_cost' && q.period === 'month'),
  );
  // The cost the message brings, or names; else all of them.
  const pick = (all: readonly Quantity[], role: QuantityRole): readonly Quantity[] => {
    const here = hereCosts.filter((q) => q.role === role);
    if (hereCosts.length > 0) return here;
    const byName = [...b.oneTime, ...b.periodCosts].some(named);
    return byName ? all.filter(named) : all;
  };
  const once = pick(b.oneTime, 'one_time');
  const fixed = pick(
    b.periodCosts.filter((c) => c.period === 'month'),
    'period_cost',
  );
  const lines: string[] = [];
  const count = (cost: number): string =>
    left.low === left.high
      ? number(Math.ceil(cost / left.low - 1e-9), 0)
      : `${number(Math.ceil(cost / left.high - 1e-9), 0)} to ${number(Math.ceil(cost / left.low - 1e-9), 0)}`;
  if (once.length > 0) {
    const out = once.reduce((sum, c) => sum + c.low, 0);
    const label = once.map((c) => (c.label === '' ? 'one-time cost' : c.label)).join(' and ');
    lines.push(
      `${money(out)} ${label} / ${range(left.low, left.high)} left per ${one(b)} = ${count(out)} ${plural(one(b))} to pay for it.`,
    );
  }
  if (fixed.length > 0) {
    const out = fixed.reduce((sum, c) => sum + c.low, 0);
    const label = fixed.map((c) => (c.label === '' ? 'monthly costs' : c.label)).join(' and ');
    lines.push(
      `${money(out)} a month ${label} / ${range(left.low, left.high)} left per ${one(b)} = ${count(out)} ${plural(one(b))} a month to cover it.`,
    );
  }
  const after =
    once.length > 0 && fixed.length === 0 && left.low === left.high
      ? [`Each ${one(b)} after that leaves ${money(left.low)}.`]
      : [];
  return lines.length === 0
    ? lacks(b, whatIsMissing.oneTime(), [left.line])
    : got(...lines, left.line, ...after);
}

function hourly(b: Book): Sum {
  if (b.nouns.length > 1) return need(whatIsMissing.which(b));
  if (b.price === null) return lacks(b, whatIsMissing.price(b));
  if (b.unitTime === null) return need(whatIsMissing.time(b));
  if (b.doubt) return UNSURE;
  const hours = b.unitTime.low / 60;
  const time =
    b.unitTime.low % 60 === 0
      ? `${number(hours)} ${hours === 1 ? 'hour' : 'hours'}`
      : `${number(b.unitTime.low)} minutes`;
  const left = leftOf(b);
  const p = b.price;
  if (left !== null) {
    if (sureLeft(b) === null) return UNSURE;
    return got(
      left.line,
      `${range(left.low, left.high)} left / ${time} = ${range(left.low / hours, left.high / hours)} an hour.`,
    );
  }
  return got(
    `${range(p.low, p.high)} / ${time} = ${range(p.low / hours, p.high / hours)} an hour, before any cost.`,
  );
}

/** What a part of an hour is, from what an hour is. */
function slotPrice(b: Book, message: string): Sum {
  const rates = [
    ...new Set(b.reads.flatMap((r) => r.quantities.filter((q) => q.role === 'rate').map((q) => q.low))),
  ];
  const [rate] = rates;
  if (rate === undefined || rates.length !== 1 || b.reads.some((r) => r.foreign)) return UNSURE;
  const t = saidNumbers(message);
  const minutes = /\bquarter[- ](?:of an )?hour\b/.test(t)
    ? 15
    : Number(/\b(\d+) minutes\b/.exec(t)?.[1] ?? Number.NaN);
  if (!(minutes > 0 && minutes < 60)) return UNSURE;
  return got(slotLine(rate, minutes));
}

function slotLine(rate: number, minutes: number): string {
  const parts = 60 / minutes;
  const what =
    minutes === 15 ? 'a quarter hour' : minutes === 30 ? 'a half hour' : `${number(minutes)} minutes`;
  return Number.isInteger(parts)
    ? `${money(rate)} an hour / ${number(parts)} = ${money(rate / parts)} for ${what}.`
    : `${money(rate)} an hour x ${number(minutes)} / 60 = ${money((rate * minutes) / 60)} for ${what}.`;
}

// Shares --------------------------------------------------------------------------------------------------------------

const stem = (w: string): string => singular(w).replace(/(?:ed|ing|s|d)$/, '');

/** A whole and the part of it that left, told in one text; null when there is not exactly one of each. */
function lostOf(
  b: Pick<Book, 'reads'>,
  message: string,
): { readonly part: Count; readonly whole: Count; readonly read: Read } | null {
  const asked = nounOf(
    /\b(?:share|percent|percentage|fraction|proportion|part|many|rate) of (?:my |our |the )?([a-z-]+)/.exec(
      saidNumbers(message),
    )?.[1],
  );
  for (const read of [...b.reads].reverse()) {
    const lost = read.counts.filter((c) => LOST.test(c.clause));
    if (lost.length === 0) continue;
    // "We lost 3 of 24 members."
    const [ratio] = read.ratios;
    if (ratio !== undefined && read.ratios.length === 1 && lost.length === 2 && read.counts.length === 2) {
      const of = (v: number): Count | undefined => lost.find((c) => c.value === v);
      const part = of(ratio.part);
      const whole = of(ratio.whole);
      if (part !== undefined && whole !== undefined && part !== whole)
        return { part: { ...part, noun: whole.noun }, whole, read };
    }
    const [part] = lost;
    // A third count of the same text: which of them went, of which?
    if (read.counts.length > 2) return null;
    const wholes = read.counts.filter(
      (c) =>
        !LOST.test(c.clause) &&
        c.noun !== null &&
        (asked === null || c.noun === asked) &&
        (part?.noun == null || part.noun === c.noun || part.value <= c.value),
    );
    const [whole] = wholes;
    if (lost.length !== 1 || wholes.length !== 1 || part === undefined || whole === undefined) return null;
    return part.value > whole.value || whole.value === 0 ? null : { part, whole, read };
  }
  return null;
}

const wholeNoun = (c: Count, n: number): string =>
  c.noun === null ? '' : ` ${n === 1 ? c.noun : plural(c.noun)}`;

function churn(b: Book, message: string): Sum {
  const l = lostOf(b, message);
  if (l === null) return UNSURE;
  return got(
    `${number(l.part.value)} of ${number(l.whole.value)}${wholeNoun(l.whole, l.whole.value)} = ${percent(l.part.value, l.whole.value)}.`,
  );
}

/** What is left when the same share goes again. */
function sameRate(b: Book, message: string): Sum {
  const l = lostOf(b, message);
  if (l === null) return UNSURE;
  const stays = l.whole.value - l.part.value;
  const goes = (stays * l.part.value) / l.whole.value;
  const what = wholeNoun(l.whole, stays);
  const left = stays - goes;
  const about = Number.isInteger(Math.round(goes * 1e6) / 1e6) ? '' : 'about ';
  const rate = `${percent(l.part.value, l.whole.value)} of ${number(stays)}${what}`;
  return got(
    about === ''
      ? `${rate} is ${number(goes)}, so ${number(stays)} - ${number(goes)} = ${number(left)}${what}.`
      : `${rate} is about ${number(goes)}, so about ${number(Math.round(left), 0)}${what} stay.`,
  );
}

/** What comes in a month from those who pay by the month. */
function income(b: Book, message: string): Sum {
  for (const read of [...b.reads].reverse()) {
    const prices = read.quantities.filter((q) => q.role === 'price' && q.period === 'month');
    if (prices.length === 0) continue;
    const [price] = prices;
    if (
      price === undefined ||
      prices.length !== 1 ||
      price.low !== price.high ||
      read.foreign ||
      read.loose.length > 0
    )
      return UNSURE;
    // Who left, told beside what they pay; the same told again elsewhere changes nothing.
    const l = lostOf({ reads: [read] }, message);
    const elsewhere = l === null ? lostOf(b, message) : null;
    if (elsewhere !== null) return UNSURE;
    if (l !== null) {
      const stays = l.whole.value - l.part.value;
      const what = wholeNoun(l.whole, stays);
      return got(
        `${number(l.whole.value)} - ${number(l.part.value)} = ${number(stays)}${what}, and ${number(stays)} x ${money(price.low)} = ${money(stays * price.low)} a month.`,
      );
    }
    if (read.counts.some((c) => LOST.test(c.clause))) return UNSURE;
    const wholes = read.counts.filter((c) => c.noun !== null);
    const [whole] = wholes;
    if (wholes.length !== 1 || whole === undefined) return UNSURE;
    return got(
      `${number(whole.value)}${wholeNoun(whole, whole.value)} x ${money(price.low)} = ${money(whole.value * price.low)} a month.`,
    );
  }
  return UNSURE;
}

/** The words of a share they ask for: "what share of the flyers turned into an order". */
function namedShare(b: Book, message: string): (Ratio & { readonly of: string }) | null {
  const t = saidNumbers(message);
  const m =
    /\b(?:share|percent|percentage|fraction|proportion|part|many|rate) of (?:my |our |the |those )?([a-z-]+)(?: that| who)? ([^?.]*)/.exec(
      t,
    );
  const of = nounOf(m?.[1]);
  if (of === null) return null;
  const did = (m?.[2] ?? '')
    .split(' ')
    .map(stem)
    .filter(
      (w) =>
        w.length > 2 &&
        !/^(?:the|into|turn|became|becom|did|was|were|end|and|then|for|with|actual|real)$/.test(w),
    );
  if (did.length === 0) return null;
  for (const read of [...b.reads].reverse()) {
    const wholes = read.counts.filter((c) => c.noun === of);
    if (wholes.length === 0) continue;
    const parts = read.counts.filter(
      (c) =>
        !wholes.includes(c) &&
        c.clause
          .split(/[^a-z-]+/)
          .map(stem)
          .some((w) => did.includes(w)),
    );
    const [whole] = wholes;
    const [part] = parts;
    if (wholes.length !== 1 || parts.length !== 1 || whole === undefined || part === undefined) return null;
    return part.value <= whole.value && whole.value > 0 ? { part: part.value, whole: whole.value, of } : null;
  }
  return null;
}

const POINTS_BACK = /\b(?:that|it|this|those)\b/;

function conversion(b: Book, message: string): Sum {
  const named = namedShare(b, message);
  if (named !== null)
    return got(
      `${number(named.part)} of the ${number(named.whole)} ${plural(named.of)} = ${percent(named.part, named.whole)}.`,
      // A small share is easier to hold as one in so many.
      ...(named.part > 0 && named.whole / named.part >= 8
        ? [`That is about 1 in ${number(Math.round(named.whole / named.part), 0)}.`]
        : []),
    );
  const ratio = pointedRatio(b, message);
  // "My conversion is 5%. If I email 400…": the share is told already.
  if (ratio === 'unsure' || b.here.percents.length > 0) return UNSURE;
  if (ratio === null) {
    const any = b.reads.some((r) => r.counts.length > 1);
    if (any) return UNSURE;
    return /\bconversion\b|\b(?:close|response|success|reply) rate\b/.test(saidNumbers(message))
      ? need(whatIsMissing.ratio())
      : NO_SUM;
  }
  return got(`${number(ratio.part)} of ${number(ratio.whole)} = ${percent(ratio.part, ratio.whole)}.`);
}

/** The part of a whole they point at: this message's, the last message's that tells numbers, else the only one told. */
function pointedRatio(b: Book, message: string): Ratio | 'unsure' | null {
  const [here, ...others] = b.here.ratios;
  // A third number beside the two: of which is the share?
  const alone = (r: Read, x: Ratio): boolean =>
    r.counts.every((c) => c.value === x.part || c.value === x.whole || c.value === 1);
  if (here !== undefined) return others.length === 0 && alone(b.here, here) ? here : 'unsure';
  const before = b.reads.slice(0, -1).reverse();
  if (POINTS_BACK.test(saidNumbers(message))) {
    // "What share is that?": of what they told last, or of nothing.
    const last = before.find((r) => r.counts.length > 0 || r.ratios.length > 0);
    if (last === undefined) return null;
    const [ratio, ...more] = last.ratios;
    return ratio === undefined || more.length > 0 || !alone(last, ratio) ? 'unsure' : ratio;
  }
  // A share of something they name is that thing's, or nobody's.
  if (
    /\b(?:share|percent|percentage|fraction|proportion|part) of (?:my |our |the )?[a-z]/.test(
      saidNumbers(message),
    )
  )
    return 'unsure';
  const all = before.flatMap((r) => r.ratios);
  const distinct = new Set(all.map((r) => `${String(r.part)}/${String(r.whole)}`));
  return distinct.size === 0 ? null : distinct.size === 1 ? (all[0] ?? null) : 'unsure';
}

/** The two shares they choose between, each with its label in the clause it stands in. */
function compare(b: Book, message: string): Sum {
  const pair = pairAsked(saidNumbers(message));
  if (pair === null) return UNSURE;
  for (const read of [...b.reads].reverse()) {
    const of = (label: string): { readonly ratio: Ratio; readonly clause: string } | null => {
      const found: { ratio: Ratio; clause: string }[] = [];
      for (const r of read.ratios) {
        const clauses = read.counts.filter(
          (c) => c.value === r.part && new RegExp(`\\b${label}\\b`).test(c.clause),
        );
        const [c] = clauses;
        if (c !== undefined && new RegExp(`\\b${String(r.whole)}\\b`).test(c.clause))
          found.push({ ratio: r, clause: c.clause });
      }
      const [first] = found;
      return found.length === 1 && first !== undefined ? first : null;
    };
    const a = of(pair[0]);
    const c = of(pair[1]);
    if (a === null || c === null) continue;
    const rate = (r: Ratio): number => r.part / r.whole;
    // The better first: a share that left is better small.
    const bad = LOST.test(a.clause) || LOST.test(c.clause);
    const firstWins = bad ? rate(a.ratio) <= rate(c.ratio) : rate(a.ratio) >= rate(c.ratio);
    const line = (label: string, r: Ratio): string =>
      `${label}: ${number(r.part)} of ${number(r.whole)} = ${percent(r.part, r.whole)}`;
    const up = (w: string): string => `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
    const [x, y] = firstWins
      ? [line(up(pair[0]), a.ratio), line(pair[1], c.ratio)]
      : [line(up(pair[1]), c.ratio), line(pair[0], a.ratio)];
    return got(`${x}; ${y}.`);
  }
  return NO_SUM;
}

/** What one of them cost to win: what was spent, over how many came. */
function acquisition(b: Book, message: string): Sum {
  const t = saidNumbers(message);
  const what =
    /\b(customer|order|client|buyer|sale|sign-?up|user|subscriber|member)s?\b/.exec(t)?.[1] ?? 'customer';
  for (const read of [...b.reads].reverse()) {
    const spent = read.quantities.filter((q) => q.role === 'spend');
    if (spent.length === 0) continue;
    if (read.foreign || read.loose.length > 0) return UNSURE;
    const verbs: Readonly<Record<string, RegExp>> = {
      order: /\border\w*\b/,
      sale: /\b(?:sales?|sold|bought|paid|order\w*)\b/,
      buyer: /\b(?:buyers?|bought|paid|order\w*)\b/,
      customer: /\b(?:customers?|bought|paid|order\w*|signed)\b/,
      client: /\b(?:clients?|signed|paid|hired|booked)\b/,
      user: /\b(?:users?|signed up|joined|installed)\b/,
      subscriber: /\b(?:subscribers?|subscribed)\b/,
      member: /\b(?:members?|joined)\b/,
    };
    const pattern = verbs[what] ?? /\bsign-?(?:ed )?ups?\b|\bsigned up\b/;
    const won = read.counts.filter((c) => pattern.test(c.clause));
    const [n] = won;
    if (won.length !== 1 || n === undefined || n.value === 0) return UNSURE;
    const total_ = spent.reduce((sum, q) => sum + q.low, 0);
    if (spent.some((q) => q.low !== q.high)) return UNSURE;
    return got(
      `${money(total_)} spent / ${number(n.value)} ${n.value === 1 ? what : plural(what)} = ${money(total_ / n.value)} to win one ${what}.`,
    );
  }
  return UNSURE;
}

/** The price that keeps a share of itself. */
function targetPrice(b: Book, message: string): Sum {
  const t = saidNumbers(message);
  const p = /(\d+(?:\.\d+)?) ?(?:%|percent)/.exec(t);
  const share = Number(p?.[1] ?? Number.NaN);
  if (!(share > 0 && share < 100) || (t.match(/\d+(?:\.\d+)? ?(?:%|percent)/g) ?? []).length !== 1)
    return UNSURE;
  const after = t.slice((p?.index ?? 0) + (p?.[0].length ?? 0));
  const before = t.slice(0, p?.index ?? 0);
  const markup = /\bmark-?up\b|\bon top\b|\badd(?:ing)?\b/.test(t);
  const keeps =
    /\bmargin\b/.test(t) ||
    /^ of (?:the |my |its |each )?(?:price|sale|it|that)\b/.test(after) ||
    /\bkeep(?:ing)?(?: about| at least)?\s*$/.test(before);
  // "To make 40 percent": of the price, or on the cost?
  if (markup === keeps) return UNSURE;
  if (b.doubt || b.shares.length > 0) return UNSURE;
  const hereCosts = b.costs;
  if (hereCosts.length === 0) return lacks(b, whatIsMissing.cost(b));
  if (hereCosts.some((c) => c.soft === true || c.low !== c.high)) return UNSURE;
  const cost = hereCosts.reduce((sum, c) => sum + c.low, 0);
  const rest = (100 - share) / 100;
  if (markup) {
    const price = cost * (1 + share / 100);
    return got(`${money(cost)} cost + ${number(share)}% of it = ${money(price)}.`);
  }
  return got(
    `${money(cost)} cost is the other ${number(100 - share)}% of the price, so ${money(cost)} / ${number(rest, 4)} = ${money(cost / rest)}.`,
  );
}

/** What the first one takes: everything once, and the first batch. */
function start(b: Book): Sum {
  for (const read of [...b.reads].reverse()) {
    const once = read.quantities.filter((q) => q.role === 'one_time');
    if (once.length === 0) continue;
    const batch = read.quantities.filter((q) => q.role === 'period_cost');
    if (read.foreign || read.loose.length > 0 || read.percentLoose) return UNSURE;
    if (batch.some((q) => q.batch === undefined) || new Set(batch.map((q) => q.batch)).size > 1)
      return UNSURE;
    const all = [...once, ...batch];
    if (all.some((q) => q.low !== q.high) || all.length < 2) return UNSURE;
    const out = all.reduce((sum, q) => sum + q.low, 0);
    const when = batch[0]?.batch === undefined ? 'to start' : `for the first ${batch[0].batch}`;
    return got(
      `${all.map((q) => `${money(q.low)}${q.label === '' ? '' : ` ${q.label}`}`).join(' + ')} = ${money(out)} ${when}.`,
    );
  }
  return UNSURE;
}

function payback(b: Book): Sum {
  if (b.fixedDoubt) return UNSURE;
  if (b.oneTime.length === 0) return lacks(b, whatIsMissing.oneTime());
  const out = b.oneTime.reduce((sum, c) => sum + c.low, 0);
  const base = contribution(b);
  const left = sureLeft(b);
  if (left === null || base.unsure) return base;
  const volume = b.volume === null ? null : perMonth({ ...b.volume, period: b.volume.period ?? 'month' });
  if (volume === null) return need(whatIsMissing.volume(b), [left.line]);
  if (left.low <= 0) return got(left.line);
  const month = volume.value * left.low;
  const months = out / month;
  return got(
    `${number(volume.value)} ${many(b, volume.value)} x ${money(left.low)} left per ${one(b)} = ${money(month)} ${volume.label}.`,
    `${money(out)} / ${money(month)} ${volume.label} = about ${number(months)} ${volume.label === 'a month' ? (months <= 1 ? 'month' : 'months') : 'times four weeks'} to earn it back.`,
  );
}

function runway(b: Book): Sum {
  if (b.reads.some((r) => r.foreign) || b.fixedDoubt) return UNSURE;
  if (b.cash === null) return lacks(b, whatIsMissing.cash());
  const fixed = b.periodCosts.filter((c) => c.period === 'month');
  // A cost a week, or a year, beside: not this sum's.
  if (b.periodCosts.some((c) => c.period !== 'month')) return UNSURE;
  if (fixed.length === 0) return lacks(b, whatIsMissing.monthlyCost());
  const out = fixed.reduce((sum, c) => sum + c.low, 0);
  const in_ = b.revenue?.period === 'month' ? b.revenue.low : 0;
  const net = out - in_;
  if (net <= 0)
    return got(
      `${money(in_)} a month in - ${money(out)} a month out = ${money(in_ - out)} a month: the money does not run out.`,
    );
  return got(
    in_ === 0
      ? `${money(b.cash.low)} / ${money(out)} a month = ${number(b.cash.low / out)} months.`
      : `${money(b.cash.low)} / (${money(out)} out - ${money(in_)} in a month) = ${number(b.cash.low / net)} months.`,
  );
}

function time(b: Book, message: string): Sum {
  if (b.unitTime === null) return NO_SUM;
  const counted = b.volume?.noun ?? null;
  if (counted !== null && b.unitTime.noun !== null && counted !== b.unitTime.noun) return UNSURE;
  if (!/\b(?:take|takes|make|do|finish|write|edit|build|need)\b/.test(saidNumbers(message))) return UNSURE;
  const n = b.volume?.low ?? Number(/(?<![\d.$])(\d+)/.exec(saidNumbers(message))?.[1] ?? Number.NaN);
  if (!Number.isFinite(n)) return need(whatIsMissing.volume(b));
  const all = n * b.unitTime.low;
  const noun = b.unitTime.noun ?? b.volume?.noun ?? null;
  const what = noun === null ? '' : ` ${n === 1 ? noun : plural(noun)}`;
  const lines = [
    `${number(n)}${what} x ${number(b.unitTime.low)} minutes = ${number(all)} minutes (${number(all / 60)} hours).`,
  ];
  if (b.weekHours !== null) lines.push(`You have ${number(b.weekHours.low)} hours a week for it.`);
  return got(...lines);
}

/** A change told by how much ("raise it by 2", "20 percent off"): no price of its own. */
const CHANGES =
  /\b(?:goes?|went|going|rises?|rose|drops?|dropped|falls?|fell|jumps?|climbs?|changes?) (?:up |down )?to \$?\d|\b(?:raise|raising|lower|lowering|cut|cutting|drop|dropping|increase|increasing|reduce|reducing|add|knock)\b[^?.]*\bby \$?\d|\b\d+ ?(?:%|percent) (?:off|discount|more|less|cheaper|higher|lower|increase|rise)\b|\b(?:half|double|triple|twice|discount|split)\b/;

/**
 * The sums of a turn: the asked one first, with the one number it lacks as a question; with no sum asked, what one sale
 * leaves when they gave both numbers of it in this conversation or the record (a fact the reply may use).
 */
export function calcOf(input: CalcInput): CalcResult {
  const said = saidNumbers(input.message);
  const own = calcAsked(input.message);
  const other =
    own === null && (NOT_THEIRS.test(said) || /\b(?:cac|ltv|lifetime value|acquisition|churn)\b/.test(said));
  const ask = other ? null : (own ?? followed(input) ?? input.ask ?? null);
  const b = bookOf(input, ask);
  if (ask === null) return { ask: null, lines: facts(b, input.message), missing: null };
  // Another month, another price, a change by so much: what it is worked out on is theirs to say.
  if (CHANGES.test(said) && ask !== 'target_price') return { ask, lines: [], missing: null, unsure: true };
  if (OF_ONE.has(ask) && !accounted(ask === 'target_price' ? { ...b.here, percents: [] } : b.here))
    return { ask, lines: [], missing: null, unsure: true };
  const sum: Sum = {
    contribution: () => contribution(b),
    margin: () => margin(b),
    total: () => total(b, input.message),
    monthly: () => monthly(b),
    revenue: () => revenue(b, input.message),
    income: () => income(b, input.message),
    break_even: () => breakEven(b, input.message),
    hourly: () => hourly(b),
    slot_price: () => slotPrice(b, input.message),
    conversion: () => conversion(b, input.message),
    churn: () => churn(b, input.message),
    same_rate: () => sameRate(b, input.message),
    compare: () => compare(b, input.message),
    acquisition: () => acquisition(b, input.message),
    target_price: () => targetPrice(b, input.message),
    start: () => start(b),
    payback: () => payback(b),
    runway: () => runway(b),
    time: () => time(b, input.message),
  }[ask]();
  // What comes in from those who pay by the month, when no price of one sale and no cost was told.
  if (
    sum.lines.length === 0 &&
    (ask === 'revenue' || ask === 'monthly') &&
    own === ask &&
    b.price === null &&
    b.costs.length + b.periodCosts.length + b.oneTime.length === 0
  ) {
    const coming = income(b, input.message);
    if (coming.lines.length > 0)
      return {
        ask: 'income',
        lines: coming.lines.map((l) => l.replace(/\.$/, ', before any cost.')),
        missing: null,
      };
  }
  // "North or south?" of nothing they counted asks for no sum.
  if (sum === NO_SUM) return { ask: null, lines: facts(b, input.message), missing: null };
  return {
    ask,
    lines: sum.unsure ? [] : sum.lines,
    missing: sum.unsure ? null : sum.missing,
    ...(sum.unsure ? { unsure: true } : {}),
  };
}

const PRICE_RIGHT =
  /\b(?:is|are|was|were|does|do) (?:[a-z0-9$.' -]+ )?(?:fee|price|rate|pricing|charge)\b(?:[^?.!]|\.(?=\d)){0,60}?\b(?:right|fair|ok|okay|good|reasonable|too (?:low|high|little|much|cheap|expensive)|enough|fine|make sense|sensible|realistic)\b|\bam i (?:charging|asking|pricing)(?: for)? (?:[a-z]+ )?(?:too (?:little|much|low|high)|enough|right|fairly|the right)\b|\bis (?:that|this|it|\$?\d+(?: dollars)?) (?:a )?(?:fair|right|good|reasonable|too (?:low|high|cheap|expensive|much|little))(?: a)?(?: (?:price|fee|rate))\b|\b(?:right|fair) (?:price|fee|rate)\b(?:[^?.!]|\.(?=\d)){0,30}\?|\b(?:should|could) (?:i|we) (?:be )?charg(?:e|ing) (?:more|less)\b/;

/** Whether they ask if what they charge is right: a verdict only buyers can give. */
export function asksIfPriceRight(message: string): boolean {
  return PRICE_RIGHT.test(saidNumbers(message));
}

/** What an hour brings at the price they told, when they said how long one takes; null: not both, or not one way only. */
export function hourlyOf(input: CalcInput): string | null {
  const b = bookOf(input, 'hourly');
  if (b.price === null || b.unitTime === null || b.nouns.length > 1) return null;
  const sum = hourly(b);
  return sum.unsure || sum.missing !== null ? null : (sum.lines.at(-1) ?? null);
}

/** What an hour brought at the price before, against the one now ("not $300", "from $300 to $450"); null: none told. */
export function hourlyBefore(input: CalcInput): string | null {
  const b = bookOf(input, 'hourly');
  if (b.price === null || b.unitTime === null || b.nouns.length > 1 || b.doubt || b.costs.length > 0)
    return null;
  const said = [...(input.record ?? []), ...(input.earlier ?? []), input.message].map(saidNumbers);
  const old = [...said]
    .reverse()
    .flatMap((t) => [
      ...t.matchAll(
        /\b(?:not|instead of|no longer|rather than|up from|down from|from|was)\s+(?:at |for )?\$?(\d+(?:\.\d+)?)\b(?! ?(?:%|percent|hours?|minutes?))/g,
      ),
    ])
    .map((m) => Number(m[1]))
    .find((n) => n > 0 && n !== b.price?.low);
  if (old === undefined || b.price.low !== b.price.high) return null;
  const hours = b.unitTime.low / 60;
  const was = old / hours;
  const now = b.price.low / hours;
  const change = now - was;
  return `Before: ${money(old)} / ${number(hours)} ${hours === 1 ? 'hour' : 'hours'} = ${money(was)} an hour, so the change is ${money(Math.abs(change))} an hour ${change >= 0 ? 'more' : 'less'}.`;
}

/** The sums of what one of them brings: a number of the message with no place in them may be the one that matters. */
const OF_ONE: ReadonlySet<CalcAsk> = new Set<CalcAsk>([
  'contribution',
  'margin',
  'total',
  'monthly',
  'revenue',
  'break_even',
  'hourly',
  'payback',
  'runway',
  'target_price',
]);

/** Every number of the message has its place: one that has none may be the one that matters. */
function accounted(here: Read): boolean {
  const placed = new Set([
    1,
    ...here.quantities.flatMap((q) => [q.low, q.high, q.low / 60]),
    ...here.ratios.flatMap((r) => [r.part, r.whole]),
  ]);
  const shares = new Set(here.quantities.filter((q) => q.role === 'unit_share').map((q) => q.low));
  if (!here.percents.every((x) => shares.has(x))) return false;
  return here.counts.every((c) => placed.has(c.value) || (c.value >= 1900 && c.value <= 2100));
}

/** With no sum asked: what their numbers come to, where the reply may use it. */
function facts(b: Book, message: string): string[] {
  const out: string[] = [];
  // On what they suppose or change, what stood before is no fact.
  if (CHANGES.test(saidNumbers(message)) || b.here.loose.length > 0) return out;
  const left = b.nouns.length > 1 ? null : sureLeft(b);
  if (left !== null) out.push(left.line);
  const [ratio, ...more] = b.here.ratios;
  if (
    ratio !== undefined &&
    more.length === 0 &&
    b.here.counts.every((x) => x.value === ratio.part || x.value === ratio.whole || x.value === 1)
  )
    out.push(`${number(ratio.part)} of ${number(ratio.whole)} = ${percent(ratio.part, ratio.whole)}.`);
  const t = saidNumbers(message);
  const inMessage = (q: Quantity | null): boolean =>
    q !== null && b.here.quantities.some((x) => x.role === q.role && x.low === q.low);
  // "It takes nine hours and I charge 300": what an hour brings.
  if (
    left === null &&
    !b.doubt &&
    b.price !== null &&
    b.unitTime !== null &&
    inMessage(b.price) &&
    inMessage(b.unitTime)
  ) {
    const sum = hourly(b);
    if (!sum.unsure && sum.missing === null) out.push(...sum.lines);
  }
  // "They go for 5, if I sell 100": what that brings in.
  if (
    left === null &&
    !b.doubt &&
    b.price !== null &&
    inMessage(b.price) &&
    b.volume !== null &&
    inMessage(b.volume) &&
    b.volume.period === null &&
    b.nouns.length <= 1
  ) {
    const n = b.volume.low;
    if (b.volume.noun === null || b.price.noun === null || b.volume.noun === b.price.noun)
      out.push(
        `${number(n)} ${many(b, n)} x ${range(b.price.low, b.price.high)} = ${range(n * b.price.low, n * b.price.high)} in sales, before any cost.`,
      );
  }
  // Sold by the quarter hour, with an hour's rate told: what it comes to.
  if (/\b(?:price|priced|pricing|charge|fee|rate)\b/.test(t)) {
    const rates = [
      ...new Set(b.reads.flatMap((r) => r.quantities.filter((q) => q.role === 'rate').map((q) => q.low))),
    ];
    const [rate] = rates;
    if (rate !== undefined && rates.length === 1 && b.quarter) out.push(slotLine(rate, 15));
  }
  return out;
}
