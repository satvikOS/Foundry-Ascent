/**
 * Figures in a reply that nobody gave: a price, a percentage, a threshold or a target the coach made up as an example.
 *
 * Live pilot 42124259353: 32 replies carried a figure that appeared nowhere in what the student said or the program's
 * sources ("ask if they'd pay $2 a month", "if fewer than 15 percent keep using it, stop"), and 11 more proposed one as
 * an example ("say, $1 per seat"). Arithmetic on the student's own numbers was fine and stays fine. The doctrine that
 * asked for a kill criterion "in numbers" is gone (Thomas, ADR-0021) and the prompt says to use the founder's numbers,
 * compute openly, or say what to measure; on the way out:
 *
 * - {@link inventedFigures} reads which money and percentage figures of a reply nobody gave (neither the founder's
 *   messages, nor the sources shown, nor arithmetic on two of those numbers): counted on the turn record
 *   (`invented_figure:n`, `proposed_figure:n`), so the lab and production can see the rate;
 * - {@link withoutExampleFigures} leaves out an aside that only offers a made-up figure as an example ("(say, $10 a
 *   month)", "— e.g. 40 percent —", "(even $5–$10)"). The sentence around it stands; nothing else of the reply is touched.
 * - {@link withoutInventedFigures} (coaching v3: pilot v3 still stated 30 made-up figures) says a figure nobody gave by
 *   what it is, where the sentence reads as well without the number: "a $10 gift card" → "a gift card", "a 10 percent
 *   discount" → "a discount", "pay $2/month for it" → "pay a monthly price for it", "at $30 per unit" → "at a set price
 *   per unit". Any other made-up figure stays as written (and counted): the sentence would not read without it.
 */

/** A money or percentage figure ("$1,200", "$1.5k", "40%", "15 percent", "$2/month"). */
const FIGURE =
  /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion|thousand))?|\d[\d,]*(?:\.\d+)?\s?(?:%|percent|per cent))/giu;

/** Any number in known text ("40 firm orders", "$3.50", "70%"). */
const NUMBER = /\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion|thousand))?/giu;

function valueOf(token: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|million|billion|thousand)?/iu.exec(token);
  if (m?.[1] === undefined) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const scale =
    unit === 'k' || unit === 'thousand'
      ? 1e3
      : unit === 'm' || unit === 'million'
        ? 1e6
        : unit === 'bn' || unit === 'billion'
          ? 1e9
          : 1;
  return base * scale;
}

/** The numbers `text` holds, as values. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const v = valueOf(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.011);
}

/**
 * Everyday scalings said in words ("half of", "a third", "per year", "per week"): a money figure that is one of these of a
 * known number is arithmetic on it (never a percentage: too many would match by chance).
 */
const SCALES = [0.5, 0.25, 1 / 3, 2, 4, 12, 52, 1 / 12, 1 / 52];

/** Most known numbers combined pairwise (arithmetic on a long pasted table stays bounded). */
const MAX_KNOWN = 40;

/**
 * Whether `value` is one of the known numbers, or arithmetic on two of them (sum, difference, product, quotient, or a
 * quotient as a percentage), within rounding.
 */
function derivable(value: number, known: readonly number[], percent: boolean): boolean {
  const nums = known.slice(0, MAX_KNOWN);
  if (nums.some((k) => close(value, k) || (!percent && SCALES.some((f) => close(value, k * f))))) return true;
  for (let i = 0; i < nums.length; i += 1) {
    for (let j = 0; j < nums.length; j += 1) {
      const a = nums[i] ?? 0;
      const b = nums[j] ?? 0;
      if (i !== j) {
        if (close(value, a + b) || close(value, a - b) || close(value, a * b)) return true;
        if (b !== 0 && (close(value, a / b) || (percent && close(value, (a / b) * 100)))) return true;
        if (percent && b !== 0 && close(value, ((a - b) / b) * 100)) return true;
      }
    }
  }
  return false;
}

/** Words before a figure that offer it as an example, a condition or a target ("say", "e.g.", "if it's under"). */
const PROPOSED_CUE =
  /(?:\bsay,?|\be\.?g\.?,?|\bfor (?:example|instance),?|\bsomething like|\blike|\bmaybe|\baround|\babout|\broughly|\baim (?:for|at)|\btarget(?:ing)?|\bif (?:it(?:'s| is)|you (?:get|hit|see)|fewer than|less than|more than|under|over|below|above)|\bat least|\bunder|\bover|\bbelow|\babove)\s*$/iu;

export interface InventedFigures {
  /** Figures stated as fact that nobody gave. */
  readonly unsourced: readonly string[];
  /** Figures offered as an example, a condition or a target that nobody gave. */
  readonly proposed: readonly string[];
}

/** The money and percentage figures of `answer` that `known` (what the founder said, the sources shown) does not give. */
export function inventedFigures(answer: string, known: string): InventedFigures {
  const knownNumbers = numbersIn(known);
  const unsourced: string[] = [];
  const proposed: string[] = [];
  for (const m of answer.matchAll(FIGURE)) {
    const value = valueOf(m[0]);
    if (value === null) continue;
    const percent = /%|percent|per cent/i.test(m[0]);
    if (derivable(value, knownNumbers, percent)) continue;
    const before = answer.slice(Math.max(0, m.index - 30), m.index);
    (PROPOSED_CUE.test(before) ? proposed : unsourced).push(m[0].trim());
  }
  return { unsourced, proposed };
}

/** An aside that offers an example: "(say, $10 a month)", "— e.g. 40% —", "(even $5–$10)". */
const EXAMPLE_ASIDE =
  /\s?\((?:say|e\.?g\.?|for example|for instance|something like|maybe|like|roughly|around|about|even|just|only)\b[^()\n]{0,120}\)|\s?[—–]\s?(?:say|e\.?g\.?|for example|for instance|something like|maybe)\b[^—–\n]{0,120}[—–]\s?/giu;

/**
 * `answer` without the asides that only offer a made-up figure as an example (see the module comment). An aside whose
 * figures the founder or a source gave stays.
 */
export function withoutExampleFigures(
  answer: string,
  known: string,
): { readonly text: string; readonly removed: number } {
  let removed = 0;
  const text = answer.replace(EXAMPLE_ASIDE, (aside) => {
    if (
      inventedFigures(aside, known).proposed.length + inventedFigures(aside, known).unsourced.length ===
      0
    ) {
      return aside;
    }
    removed += 1;
    // A dash aside joins the words around it ("of that — say $1 — so" → "of that so").
    return /^\s?[—–]/.test(aside) ? ' ' : '';
  });
  return removed === 0 ? { text: answer, removed: 0 } : { text: text.replace(/ {2,}/g, ' '), removed };
}

/** A money or percentage figure, or a range of two ("$5–$10", "10 to 15 percent"). */
const FIGURE_OR_RANGE = String.raw`(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion|thousand))?|\d[\d,]*(?:\.\d+)?\s?(?:%|percent|per cent))(?:\s?(?:-|–|—|to)\s?(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|%|percent|per cent))?)?`;

/** "a $10 gift card", "an 8% cut": an article, the figure, then the thing it prices. */
const PRICED_THING = new RegExp(
  String.raw`\b([Aa]n?) (${FIGURE_OR_RANGE}) (?!(?:per|a|an|each|for|to|or|and|in|of|on|at|from|off|more|less|or)\b)(?=(\p{L}[\p{L}'’-]*))`,
  'gu',
);

/** "$2/month", "$30 per unit", "$10 a session": a price per period or per item. */
const PRICE_PER = new RegExp(
  String.raw`(?<!\b(?:the|that|this|your|their|our|my|its|a|an) )(${FIGURE_OR_RANGE})\s?(?:/\s?|\ba |\bper |\beach )(month|week|year|seat|user|session|class|lesson|unit|order|head|person|student|household|customer|box|kit|test|visit|night|hour)\b`,
  'giu',
);

const PERIOD: Readonly<Record<string, string>> = { month: 'monthly', week: 'weekly', year: 'yearly' };

/** The article for a word ("a gift card", "an evening class"). */
function articleFor(word: string, capital: boolean): string {
  const an = /^(?:[aeio]|u(?!n[aeiou]|ni|s[aeiou]|r[aeiou]|tility)|hour|honest)/iu.test(word);
  const article = an ? 'an' : 'a';
  return capital ? `${article.charAt(0).toUpperCase()}${article.slice(1)}` : article;
}

/**
 * `answer` with each figure nobody gave said by what it is where that reads as well (see the module comment): figures
 * the founder or a source gave, arithmetic on theirs, and figures offered as an example, condition or target are left
 * as they are (the last are counted as proposed). `removed` counts the figures taken out.
 */
export function withoutInventedFigures(
  answer: string,
  known: string,
): { readonly text: string; readonly removed: number } {
  const invented = new Set(inventedFigures(answer, known).unsourced.map((f) => f.replace(/\s+/g, ' ')));
  if (invented.size === 0) return { text: answer, removed: 0 };
  const madeUp = (figure: string): boolean => {
    for (const m of figure.matchAll(FIGURE)) if (invented.has(m[0].trim().replace(/\s+/g, ' '))) return true;
    return false;
  };
  let removed = 0;
  let text = answer.replace(PRICED_THING, (whole, article: string, figure: string, next: string) => {
    if (!madeUp(figure)) return whole;
    removed += 1;
    return `${articleFor(next, article.startsWith('A'))} `;
  });
  text = text.replace(PRICE_PER, (whole, figure: string, per: string) => {
    if (!madeUp(figure)) return whole;
    removed += 1;
    const period = PERIOD[per.toLowerCase()];
    return period === undefined ? `a set price per ${per}` : `a ${period} price`;
  });
  return removed === 0 ? { text: answer, removed: 0 } : { text, removed };
}
