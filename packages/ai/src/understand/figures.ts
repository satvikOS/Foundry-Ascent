import { numbersIn } from '../validators/figures.js';
import { spelledAsDigits } from '../validators/sums.js';

/**
 * The figures of a text with what each is marked as ("$6.50", "8 percent", "40 boats"): what an input of a sum, or a
 * number of a claim, may come from. Dates and times of day are no figures.
 */
export type FigureMark = '$' | '%' | 'foreign' | null;

/** Calendar periods a figure may be of, shortest first. */
export const PERIODS = ['day', 'week', 'month', 'year'] as const;
export type Period = (typeof PERIODS)[number];

export interface Figure {
  readonly value: number;
  readonly mark: FigureMark;
  /** What its own words say of time: "$85 a month" (`by` −1), "6 weeks" (`by` 1). */
  readonly time?: { readonly period: Period; readonly by: 1 | -1 };
  /** A share put on top of a base ("8% on top"): it never comes off the whole. */
  readonly onTop?: true;
  /** A share they take ("we skim 8%") or that is taken from them ("the site keeps 8%"). */
  readonly takes?: 'us' | 'them';
  /** A share of the price, not of the cost ("keep a third of what it sells for", "a 40% margin"). */
  readonly ofPrice?: true;
  /** A thing is counted ("30 kits"): never an amount of money. */
  readonly counts?: true;
}

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const DATE = new RegExp(
  String.raw`\b(\d{4})-(\d{2})-(\d{2})\b|\b(${MONTHS})\.? (\d{1,2})(?:st|nd|rd|th)?\b(?!\s?(?:%|percent|dollars))(?:,? \d{4}\b(?!-))?|\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTHS})\b(?: \d{4}\b(?!-))?`,
  'giu',
);
const CLOCK = /\b\d{1,2}:\d{2}(?: ?[ap]\.?m\.?)?|\b\d{1,2} ?[ap]\.?m\.?(?![a-z])/giu;
const MONTH_INDEX = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

/** The days of the year a text names, as `MM-DD`. */
export function daysIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE)) {
    const month = (m[4] ?? m[7] ?? '').slice(0, 3).toLowerCase();
    const at = m[2] ?? String(MONTH_INDEX.indexOf(month) + 1).padStart(2, '0');
    const day = (m[3] ?? m[5] ?? m[6] ?? '').padStart(2, '0');
    // "may 3 people" is no day of May: the word alone is the verb far more often.
    if (m[4] !== undefined && m[4] === 'may') continue;
    if (at !== '00') out.push(`${at}-${day}`);
  }
  return out;
}

/** A text without its dates and times of day. */
export const withoutDates = (text: string): string =>
  text.replace(DATE, (whole, ...parts: unknown[]) => (parts[3] === 'may' ? whole : ' ')).replace(CLOCK, ' ');

const FOREIGN_WORD =
  'euros?|pounds?|quid|cedis?|naira|shillings?|rand|rupees?|pesos?|reais|yen|yuan|dirhams?|riyals?|francs?|birr|kwacha|taka|ringgit|baht|lira|zloty|pence|pesewas|kobo|eur|gbp|ghs|ngn|kes|zar|inr|ugx';
const FIGURE = new RegExp(
  String.raw`(?:([$£€₦₵¥₹₩])\s?|\b(EUR|GBP|GHS|NGN|KES|KSh|ZAR|INR|UGX|USD)\s?)?((?<![\d.])\d(?:[\d,]*\d)?(?:\.\d+)?|(?<![\d.])\.\d+)(?:[^\S\n]?(k|thousand|million|m|bn|billion)(?![a-z]))?[^\S\n]?(?:(%|percent\b|per cent\b)|-?\s?(dollars?\b|bucks?\b|usd\b)|(cents?\b)|(?:(${FOREIGN_WORD})\b))?`,
  'giu',
);

const SCALE: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
};

/** Amounts people say without a number. */
const SAID: readonly (readonly [RegExp, number])[] = [
  [/\bhalf\b/iu, 0.5],
  [/\bhalf\b/iu, 2],
  [/\b(?:a|one) dozen\b/iu, 12],
  [/\bdozen\b/iu, 12],
  [/\b(?:twice|double|doubles|doubled|a couple of|both)\b/iu, 2],
  [/\b(?:triple|tripled)\b/iu, 3],
  [/\b(?:a|one|each|per)\b/iu, 1],
  [/\b(?:a|one) quarter (?:of|less|more|off)\b/iu, 0.25],
  [/\b(?:a|one) third\b/iu, 1 / 3],
  [/\btwo thirds\b/iu, 2 / 3],
  [/\bthirds?\b/iu, 3],
  [/\b(?:a|one) quarter\b/iu, 4],
  [/\b(?:a|one) quarter\b/iu, 0.25],
  [/\b(?:a|one) fifth\b/iu, 0.2],
  [/\b(?:a|one) tenth\b/iu, 0.1],
  [/\bquarter(?:[ -]of[ -]an)?[ -]hours?\b/iu, 0.25],
  [/\b(?:nobody|no one|none|nothing|zero)\b/iu, 0],
];

/** "900 million", "3 hundred": one number, before the words alone are read as one. */
const SCALED = /(?<![\d.]|\d,)(\d[\d,]*(?:\.\d+)?)\s?(hundred|thousand|million|billion)\b/giu;
const WORD_SCALE: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

/** What stands right after a figure: "a month", "hours a week", "per seat per year", "monthly", "/mo". */
const PER =
  /^\s?(?:(?:[\p{L}'’-]{1,16} ){0,3}?(?=(?:an?|per) (?:day|week|month|year)\b)|(?:[\p{L}'’-]{1,16} )?(?:(?:per|an?|each) [\p{L}-]{1,16} )?)(?:(?:an? |per |each |every |\/ ?)(day|week|month|year|mo|wk|yr)\b|(daily|weekly|monthly|yearly|annually)\b)/iu;
const LASTS = /^\s?(day|week|month|year)s\b/iu;
const ON_TOP = /^\s?(?:[\p{L}'’-]{1,16} ){0,3}on top\b/iu;
/** Who a share goes to, by the words right before it and right after. */
const WE_TAKE =
  /\b(?:we|i|you)(?:['’](?:ll|d|re|m))? (?:\w+ ){0,2}(?:skim\w*|tak(?:e|ing)|get|keep|charg(?:e|ing)|earn|add|collect|pocket)(?: (?:a|an|the|about|like|only|just|around|maybe))*\s*$|\b(?:our|my|your) (?:\w+ )?(?:cut|commission|fee|share|take|skim|service fee)(?: (?:is|of|at|would be|will be|was))?(?: (?:a|about|like|only|just))*\s*$/iu;
const FOR_US =
  /^\s?(?:cut|commission|fee|share|skim)\b.{0,14}\b(?:to|for) (?:us|me|you)\b|^\s?(?:is|goes|going) (?:ours|mine|yours|to (?:us|me|you))\b/iu;
const THEY_TAKE =
  /\b(?:store|site|platform|app|bank|school|university|college|club|landlord|shop|gallery|marketplace|processor|card|stripe|paypal|etsy|agency|agent|partner|it|they|he|she|who|which|that)(?:['’]s)? (?:\w+ ){0,2}(?:tak(?:e|es|ing)|keep(?:s|ing)?|charg(?:e|es|ing)|gets?|skims?|wants?|takin|kept|took)(?: (?:a|an|the|about|like|around|me|us|you))*\s*$|\b(?:their|his|her|its) (?:\w+ )?(?:cut|commission|fee|share)(?: (?:is|of|at|was))?(?: (?:a|about|like))*\s*$|\b(?:processing|card|platform|payment|store|booking|listing|transaction) fees?(?: (?:is|are|of|at))? (?:a |about )?$/iu;
const OF_PRICE =
  /^\s?(?:(?:of|on|off) (?:the |each |every |my |our |your |its |a )?(?:price|sales?|selling price|ticket|order|sticker|retail)\b|(?:gross |profit )?margins?\b)/iu;
const A_MARGIN = /\b(?:gross |profit )?margin (?:of|is|at)(?: (?:a|about|around|like))* ?$/iu;
const takesOf = (before: string, after: string): Figure['takes'] | undefined => {
  // A discount is nobody's.
  if (/^\s?(?:off|less|cheaper|discount)\b/iu.test(after)) return undefined;
  if (WE_TAKE.test(before) || FOR_US.test(after)) return 'us';
  return THEY_TAKE.test(before) ? 'them' : undefined;
};

const AFTER = 48;
/** A word right after a figure that counts nothing: the figure may be money, as the words around it leave it open. */
const NO_THING = new Set(
  (
    'and the for but now how per each every from with plus minus less more off out into apiece total all altogether today then when ' +
    'what why who which that this they you she him her his its our your their was were are has had have not too also only just extra flat ' +
    'daily weekly monthly yearly last next after before until till because since while than some any one other others make makes ' +
    'instead again maybe though rather about already still yet please pls bc cause because so or if even please left over under up down in on of at to'
  ).split(' '),
);
const NEXT_WORD = /^[ -]?(\p{L}{3,20})/u;
/** Plurals that do not end in s. */
const PLURAL = new Set(
  'people children men women sheep fish deer staff crew cattle geese mice teeth feet police folk'.split(' '),
);
/** "40 hives" counts hives; "the 600 website" is what one website costs, not 600 of them. */
const countsSomething = (after: string, value: number): boolean => {
  const word = NEXT_WORD.exec(after)?.[1]?.toLowerCase();
  if (word === undefined || NO_THING.has(word)) return false;
  return value === 1 || word.endsWith('s') || PLURAL.has(word);
};

const periodOf = (word: string): Period => {
  const w = word.toLowerCase();
  if (w.startsWith('d')) return 'day';
  if (w.startsWith('w')) return 'week';
  return w.startsWith('m') ? 'month' : 'year';
};

function timeAfter(after: string): Figure['time'] | undefined {
  const per = PER.exec(after);
  const word = per?.[1] ?? per?.[2];
  if (word !== undefined) return { period: periodOf(word), by: -1 };
  const lasts = LASTS.exec(after)?.[1];
  return lasts === undefined ? undefined : { period: periodOf(lasts), by: 1 };
}

/** A figure with the words around it. */
export interface Placed {
  readonly figure: Figure;
  readonly before: string;
  readonly after: string;
}

/** Every figure of a text, in order, spelled or in digits. */
export const figuresIn = (text: string): Figure[] => placedIn(text).map((p) => p.figure);

/** They charge it, were paid it or asked for it. */
const PRICED =
  /\b(?:charg\w+|pric\w+|pay(?:s|ing)?|paid|sell\w*|sold|fees?|rents?|renting|rented|deposit|prepa\w+|asked|asking|offer(?:s|ed|ing)?|worth of)\b/giu;
/** They have it, spend it or owe it. */
const HELD =
  /\b(?:have|has|had|having|got|budget|left|saved?|savings|spend\w*|spent|burn\w*|raised?|stipend|grants?|awards?|loans?|owe[sd]?|costs?|costing|tool\w*|gets?|takes?|keeps?|rent is|bank|cash|total)\b|['’]ve\b/giu;
const A_TIME = /^\s?(?:each\b|apiece\b|per\b|an?\b|\/)/iu;
const AROUND = 60;
const lastAt = (pattern: RegExp, text: string): number => [...text.matchAll(pattern)].at(-1)?.index ?? -1;

/** The amounts of a text that are a price or a fee of theirs: what somebody pays, never what they have or spend. */
export function pricesIn(text: string): number[] {
  return placedIn(text).flatMap(({ figure, before, after }) => {
    const said = before.split(/[.!?;]\s/u).at(-1) ?? '';
    const priced = lastAt(PRICED, said);
    const held = lastAt(HELD, said);
    if (figure.mark === '%' || figure.mark === 'foreign' || figure.counts === true) return [];
    if (held > priced) return [];
    return priced >= 0 || (figure.mark === '$' && (A_TIME.test(after) || /\b(?:is|are|at) $/iu.test(said)))
      ? [figure.value]
      : [];
  });
}

export function placedIn(text: string): Placed[] {
  const out: Placed[] = [];
  const joined = withoutDates(text).replace(SCALED, (_whole, digits: string, word: string) =>
    String(Number(digits.replace(/,/g, '')) * (WORD_SCALE[word.toLowerCase()] ?? 1)),
  );
  const said = spelledAsDigits(joined);
  for (const m of said.matchAll(FIGURE)) {
    const base = Number((m[3] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const value = base * (SCALE[(m[4] ?? '').toLowerCase()] ?? 1);
    const sign = m[1];
    const code = m[2]?.toUpperCase();
    const mark: FigureMark =
      sign === '$' || code === 'USD' || m[6] !== undefined
        ? '$'
        : sign !== undefined || code !== undefined || m[8] !== undefined
          ? 'foreign'
          : m[5] !== undefined
            ? '%'
            : null;
    const end = m.index + m[0].length;
    const after = said.slice(end, end + AFTER);
    const time = timeAfter(after);
    const before = said.slice(Math.max(0, m.index - AROUND), m.index);
    const takes = mark === '%' ? takesOf(before, after) : undefined;
    const more = {
      ...(time === undefined ? {} : { time }),
      ...(mark === '%' && ON_TOP.test(after) ? { onTop: true as const } : {}),
      ...(takes === undefined ? {} : { takes }),
      ...(mark === '%' && (OF_PRICE.test(after) || A_MARGIN.test(before)) ? { ofPrice: true as const } : {}),
      ...(mark === null && m[7] === undefined && countsSomething(after, value)
        ? { counts: true as const }
        : {}),
    };
    if (m[7] !== undefined && mark === null)
      out.push({ figure: { value: value / 100, mark: '$', ...more }, before, after });
    out.push({ figure: { value, mark, ...more }, before, after });
  }
  return out;
}

/** Amounts a text says in a word ("half", "a dozen", "twice"). */
export const saidAmounts = (text: string): number[] =>
  SAID.flatMap(([pattern, value]) => (pattern.test(text) ? [value] : []));

export const sameNumber = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);

/** Every number of a text as a claim may repeat it: its figures, what its words say, and the digits inside its labels. */
export function claimNumbers(text: string): number[] {
  return [...figuresIn(text).map((f) => f.value), ...numbersIn(withoutDates(text))];
}
