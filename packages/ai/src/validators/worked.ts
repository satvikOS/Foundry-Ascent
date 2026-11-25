import { numbersIn, spelledNumbersIn } from './figures.js';

/**
 * Whether a figure of a reply is worked out from numbers that were given and are shown beside it (heldout 2026-11-25: an
 * asked sum, rightly worked out in plain words, was taken out of the reply as a figure nobody gave: a share of an amount,
 * an amount over a percentage, three numbers in a row). Exact to what is shown: nothing that only comes near.
 */

/** A number as it is shown, and whether it is a percentage. */
export interface Operand {
  readonly value: number;
  readonly percent: boolean;
}

const PERCENT = /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/giu;
/** Most operands a figure is read on. */
const MOST = 12;

const near = (a: number, b: number): boolean =>
  Number.isFinite(a) && Math.abs(a - b) <= Math.max(0.0051, Math.abs(b) * 5e-4);

/** The numbers a text shows, in order. */
export function operandsIn(text: string): Operand[] {
  const shares = new Set([...text.matchAll(PERCENT)].map((m) => Number((m[1] ?? '').replace(/,/g, ''))));
  const all = [...numbersIn(text), ...spelledNumbersIn(text)];
  return all.map((value) => ({ value, percent: shares.has(value) }));
}

/** One step of arithmetic on two operands. */
function step(a: number, b: Operand): number[] {
  if (b.percent) {
    const p = b.value / 100;
    return p <= 0 ? [] : [a * p, a * (1 - p), a * (1 + p), a / p, a / (1 + p)];
  }
  return [a + b.value, a - b.value, a * b.value, ...(b.value === 0 ? [] : [a / b.value])];
}

/**
 * Whether `value` is one or two steps of arithmetic on the operands shown (each used once); two steps are counted only for
 * a figure that says something exact (three digits or cents), which nothing comes to by chance.
 */
export function workedFrom(value: number, shown: readonly Operand[]): boolean {
  const all = shown
    .filter((o, i) => shown.findIndex((x) => x.value === o.value && x.percent === o.percent) === i)
    .filter((o) => o.value > 0)
    .slice(-MOST);
  const exact = Math.abs(value) >= 100 || !Number.isInteger(value);
  return all.some((a, i) => {
    if (a.percent || near(a.value, value)) return false;
    return all.some((b, j) => {
      if (i === j) return false;
      return step(a.value, b).some((r) => {
        if (near(r, value)) return true;
        if (!exact || r <= 0) return false;
        return all.some((c, k) => k !== i && k !== j && step(r, c).some((x) => near(x, value)));
      });
    });
  });
}

/** Most numbers of theirs a sum they asked for is read on. */
const MOST_GIVEN = 16;

/**
 * Whether `value` is a sum of theirs in the shape such sums have: a count of what one costs or leaves (a price less up to
 * two costs, or two costs together). Only where a sum was asked for.
 */
export function workedShape(value: number, given: readonly number[]): boolean {
  const all = [...new Set(given)].filter((n) => n > 0 && n !== 100).slice(-MOST_GIVEN);
  const cents = all.some((n) => !Number.isInteger(n));
  if (Math.abs(value) < 20 && (Number.isInteger(value) || !cents)) return false;
  const ones: number[] = [...all];
  for (const [i, a] of all.entries())
    for (const [j, b] of all.entries()) {
      if (i === j) continue;
      if (i < j) ones.push(a + b);
      if (a > b) {
        ones.push(a - b);
        for (const [k, c] of all.entries()) if (k > j && k !== i && a - b > c) ones.push(a - b - c);
      }
    }
  return ones.some((one) => near(one, value) || all.some((n) => n > 1 && n !== one && near(one * n, value)));
}
