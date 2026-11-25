import { numbersIn } from '../validators/figures.js';
import { spelledAsDigits } from '../validators/sums.js';

/**
 * The figures of a text with what each is marked as ("$6.50", "8 percent", "40 boats"): what an input of a sum, or a
 * number of a claim, may come from. Dates and times of day are no figures.
 */
export type FigureMark = '$' | '%' | 'foreign' | null;

export interface Figure {
  readonly value: number;
  readonly mark: FigureMark;
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
  String.raw`(?:([$£€₦₵¥₹₩])\s?|\b(EUR|GBP|GHS|NGN|KES|KSh|ZAR|INR|UGX|USD)\s?)?((?<![\d.])\d[\d,]*(?:\.\d+)?|(?<![\d.])\.\d+)(?:\s?(k|thousand|million|m|bn|billion)(?![a-z]))?\s?(?:(%|percent\b|per cent\b)|-?\s?(dollars?\b|bucks?\b|usd\b)|(cents?\b)|(?:(${FOREIGN_WORD})\b))?`,
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

/** Every figure of a text, in order, spelled or in digits. */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  const joined = withoutDates(text).replace(SCALED, (_whole, digits: string, word: string) =>
    String(Number(digits.replace(/,/g, '')) * (WORD_SCALE[word.toLowerCase()] ?? 1)),
  );
  for (const m of spelledAsDigits(joined).matchAll(FIGURE)) {
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
    if (m[7] !== undefined && mark === null) out.push({ value: value / 100, mark: '$' });
    out.push({ value, mark });
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
