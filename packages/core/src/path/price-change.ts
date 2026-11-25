import { money, quantitiesIn, saidNumbers, type Period, type Quantity } from './calc.js';
import { asksFor } from './kinds.js';

/**
 * "Do I raise the price to 40?", with the price they have on record: the share of the buyers the new one must keep to bring
 * the same money. Worked out by code from their two prices; a cost of one they told is taken off both, an unknown one is
 * said to be. Null when a price is missing, or can be read more than one way. Pure.
 */
export interface PriceChange {
  readonly text: string;
  readonly voice: string;
}

const MOVES =
  /\b(?:rais\w+|increas\w+|put(?:ting)?|bump\w*|hik\w+|mov\w+|lift\w*|chang\w+|lower\w*|drop\w*|cut(?:ting)?|reduc\w+|switch\w*|go(?:ing)?|set|charg\w+)\b/;
const OF_THE_PRICE =
  /\b(?:price[sd]?|pricing|fees?|rates?|charge|charging|subscription|it|them|tickets?|membership)\b/;
/** "40 customers", "40 percent": no price. */
const NO_PRICE = String.raw`(?! ?(?:%|percent|people|persons|customers?|users?|buyers?|clients?|students?|teams?|shops?|units?|days?|weeks?|months?|hours?|minutes?|in\b))`;
const AMOUNT = String.raw`\$?(\d+(?:\.\d+)?)(?![\d.])${NO_PRICE}`;
const FROM_TO = new RegExp(String.raw`\bfrom ${AMOUNT}(?: ?~ ?| to )${AMOUNT}`);
const INSTEAD = new RegExp(String.raw`${AMOUNT}[^?.!]{0,20}?\b(?:instead of|rather than|not) ${AMOUNT}`);
const TO = new RegExp(String.raw`\bto ${AMOUNT}`);
const CHARGE = new RegExp(String.raw`\bcharge ${AMOUNT}[^?.!]{0,24}\b(?:instead|now|from now on)\b`);

interface Prices {
  readonly from: number;
  readonly to: number;
  readonly period: Period | null;
  /** What one costs them, when it is sure. */
  readonly cost: number | null;
  /** How many pay the old price now. */
  readonly payers: number | null;
}

const only = (values: readonly number[]): number | null => {
  const [first, ...rest] = [...new Set(values)];
  return first === undefined || rest.length > 0 ? null : first;
};
const exact = (q: Quantity): boolean => q.low === q.high;

/** The two prices of the question, the old one from what they told (`told`: oldest first); null: not sure of one. */
function pricesIn(message: string, told: readonly string[]): Prices | null {
  const t = saidNumbers(message);
  if (!asksFor(message) || !MOVES.test(t)) return null;
  const pair = FROM_TO.exec(t);
  const instead = pair === null ? INSTEAD.exec(t) : null;
  const one = pair === null && instead === null ? (CHARGE.exec(t) ?? TO.exec(t)) : null;
  // "From $12 to $15" is a price whatever it is called; "from 4 to 10" is not.
  if (!OF_THE_PRICE.test(t) && !(pair ?? instead)?.[0].includes('$')) return null;
  const to = Number(pair?.[2] ?? instead?.[1] ?? one?.[1] ?? Number.NaN);
  if (!(to > 0)) return null;
  const read = told.map((text) => ({ text, quantities: quantitiesIn(text).quantities }));
  const prices = read.flatMap((r, at) =>
    r.quantities.filter((q) => q.role === 'price' && exact(q)).map((q) => ({ q, at })),
  );
  const latest = prices.at(-1);
  const newest = prices.filter((p) => p.at === latest?.at);
  const known = latest === undefined ? null : only(newest.map((p) => p.q.low));
  const from = Number(pair?.[1] ?? instead?.[2] ?? known ?? Number.NaN);
  if (!(from > 0) || from === to) return null;
  // Another price on record, and none of them named in the question.
  if (pair === null && instead === null && only(prices.map((p) => p.q.low)) === null) return null;
  const of = prices.filter((p) => p.q.low === from).at(-1);
  const costs = read.flatMap((r) => r.quantities.filter((q) => q.role === 'unit_cost' && exact(q)));
  const cost = costs.length === 1 && costs[0]?.soft !== true ? (costs[0]?.low ?? null) : null;
  const text = of === undefined ? '' : saidNumbers(read[of.at]?.text ?? '');
  const m = new RegExp(
    String.raw`(?<![\d.$])(\d+) (?:[a-z'-]+ ){0,4}?(?:pay|paying|paid|bought|buy)\b[^.;?!]{0,24}?\$?${String(from).replace('.', '\\.')}(?![\d.])`,
  ).exec(text);
  return {
    from,
    to,
    period: of?.q.period ?? null,
    cost: cost !== null && cost < Math.min(from, to) ? cost : null,
    payers: m?.[1] === undefined ? null : Number(m[1]),
  };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** Most buyers a share is said of ("5 of every 8"). */
const MOST_OF = 12;

/** `part` of `whole` money as buyers: in lowest terms, else of ten, rounded up. */
function buyers(
  part: number,
  whole: number,
): { readonly p: number; readonly q: number; readonly up: boolean } {
  const [a, b] = [Math.round(part * 100), Math.round(whole * 100)];
  const d = gcd(a, b);
  const [p, q] = [a / d, b / d];
  return q <= MOST_OF ? { p, q, up: false } : { p: Math.ceil((a / b) * 10 - 1e-9), q: 10, up: true };
}

export function priceChange(message: string, told: readonly string[]): PriceChange | null {
  const x = pricesIn(message, told);
  if (x === null) return null;
  const left = (price: number): number => price - (x.cost ?? 0);
  const [a, b] = [money(x.from), money(x.to)];
  const each = x.cost === null ? '' : ` (after the ${money(x.cost)} one costs you)`;
  const period = x.period === null ? '' : ` a ${x.period}`;
  if (x.to > x.from) {
    const { p, q, up } = buyers(left(x.from), left(x.to));
    const line = `${b} brings what ${a} does${each} when ${up ? 'about ' : ''}${String(p)} of every ${String(q)} who would pay ${a} still pay ${b}. Above that line it brings more, below it less.`;
    const n = x.payers;
    const need = n === null ? null : Math.ceil((n * left(x.from)) / left(x.to) - 1e-9);
    const yours =
      n === null || need === null || n < 2 || need > n
        ? ''
        : `Of the ${String(n)} who pay now, ${String(need)} at ${b} would ${need === 1 ? 'be' : 'bring'} ${money(need * x.to)}${period}, against ${money(n * x.from)} today.`;
    const keep = n === null ? 'the ones who pay now' : `the ${String(n)} who pay now`;
    const opens = `Yes, for the next ones you ask, and leave ${keep} at ${a} until you know.`;
    const cost =
      x.cost === null ? 'What one costs you is not in this; any cost makes the line easier to beat.' : '';
    return {
      text: [opens, line, yours, cost].filter((s) => s !== '').join(' '),
      voice: `${opens} ${line}`,
    };
  }
  const { p, q, up } = buyers(left(x.to), left(x.from));
  const line = `At ${b} it takes ${up ? 'about ' : ''}${String(q)} buyers to bring what ${String(p)} bring at ${a}${each}. So it pays only if it wins that many, and nobody has shown that it does.`;
  const opens = 'Not yet.';
  const cost =
    x.cost === null ? 'What one costs you is not in this; any cost makes the line harder to beat.' : '';
  return {
    text: [opens, line, cost].filter((s) => s !== '').join(' '),
    voice: `${opens} ${line.split(/(?<=\.)\s/u)[0] ?? line}`,
  };
}
