import { figuresIn, saidAmounts } from './figures.js';
import type { RawInput } from './schema.js';

/** "4 / 16": two numbers and what is done with them. */
const TWO_NUMBERS = /^\$?(\d[\d,]{0,12}(?:\.\d{1,6})?)\s?([-−+*×x/÷])\s?\$?(\d[\d,]{0,12}(?:\.\d{1,6})?)$/u;
const SHARE_SAID = /\b(?:half|thirds?|quarters?|fifths?|tenths?)\b(?! (?:an? )?hour)/iu;
const placeOf = (from: string): string => (/^conversation$/iu.test(from) ? 'history' : from);

/** `price=$70@R1` as a number of a sum; null: none. */
export function inputOf(said: string): RawInput | null {
  const cut = said.lastIndexOf('@');
  const body = cut < 0 ? said : said.slice(0, cut);
  const from = cut < 0 ? 'message' : said.slice(cut + 1).trim() || 'message';
  const eq = body.search(/[=:]/u);
  if (eq <= 0) return null;
  const name = body.slice(0, eq).trim();
  const shown = body.slice(eq + 1).trim();
  if (name === '' || shown === '') return null;
  const [figure] = figuresIn(shown);
  const calc = TWO_NUMBERS.exec(shown);
  if (calc !== null) {
    const [a, b] = [Number((calc[1] ?? '').replace(/,/gu, '')), Number((calc[3] ?? '').replace(/,/gu, ''))];
    const op = calc[2] ?? '';
    const value = op === '/' || op === '÷' ? a / b : op === '+' ? a + b : /[*×x]/u.test(op) ? a * b : a - b;
    return { name, value, unit: 'count', from: placeOf(from), calc: shown };
  }
  const negative = /^[-−]/u.test(shown) ? -1 : 1;
  const amounts = saidAmounts(shown);
  // "A third" is a share: of its readings (one, a third, three), the one between 0 and 1.
  const share = SHARE_SAID.test(shown) ? amounts.find((v) => v > 0 && v < 1) : undefined;
  const amount = share ?? amounts[0];
  if (figure === undefined && amount === undefined) return { name, value: Number.NaN, unit: 'count', from };
  const value = negative * (figure?.value ?? amount ?? Number.NaN);
  const mark = figure?.mark ?? null;
  const unit =
    mark === '$' || mark === 'foreign'
      ? '$'
      : mark === '%'
        ? '%'
        : // "5 hours", "3 weeks": a time; "350 every week" is an amount of each week.
          /(?<!\b(?:an?|per|every|each|that|this|last|next) )\b(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/iu.test(
              shown,
            )
          ? 'time'
          : 'count';
  return { name, value, unit, from: placeOf(from) };
}
