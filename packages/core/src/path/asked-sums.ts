import { type Understanding, type UnderstoodSum } from '@foundry/ai';

import { readText, saidNumbers, type Read } from './calc-read.js';
import { plain } from './words.js';

/**
 * A figure they ask for that the reading did not work out, where their own words hold every number of it one way only: what
 * an offer implies, and how many cover a cost. Arithmetic is no ruling: it is said whatever a person decides. Pure.
 */
export interface SumSource {
  readonly message: string;
  /** Their earlier messages here, oldest first. */
  readonly earlier: readonly string[];
  /** What is on record, as sentences. */
  readonly record: readonly string[];
}

const ASKS_WORTH =
  /\b(?:worth|valu(?:e[sd]?|ing|ation))\b(?![^.?!]{0,20}\b(?:it|my (?:time|hours?)|the (?:time|effort|trouble))\b)/i;
const OFFER =
  /(\$? ?\d[\d,.]*) ?(k|thousand|grand|m|mil|million)?(?: ?(?:dollars|bucks|usd))? (?:on the table )?(?:in exchange )?(?:for|to (?:get|own|have)|against|buys?) (?:an? )?(\d{1,2}(?:\.\d+)?) ?(?:%|percent|pct)(?! ?(?:off|discount|more|less|fee|commission|cut|interest))/i;
const SCALE: Readonly<Record<string, number>> = {
  k: 1_000,
  thousand: 1_000,
  grand: 1_000,
  m: 1_000_000,
  mil: 1_000_000,
  million: 1_000_000,
};
const money = (n: number): string =>
  `$${n.toLocaleString('en-US', n % 1 === 0 ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What an offer for a part makes the whole come to, when they ask for it. */
export const worthAsked = (s: SumSource): UnderstoodSum | null =>
  ASKS_WORTH.test(s.message) ? worthIn([s.message, ...[...s.earlier].reverse()]) : null;

/** What an offer for a part makes the whole come to, the first offer of the texts; null: none. */
export function worthIn(texts: readonly string[]): UnderstoodSum | null {
  for (const text of texts) {
    const m = OFFER.exec(text.replace(/\s+/g, ' '));
    if (m === null) continue;
    const amount = Number((m[1] ?? '').replace(/[^\d.]/g, '')) * (SCALE[(m[2] ?? '').toLowerCase()] ?? 1);
    const share = Number(m[3]);
    // Nobody pays so little for a part of a company.
    if (!(amount >= 500) || !(share > 0 && share < 100)) return null;
    const value = Math.round(amount / (share / 100));
    return {
      label: 'what the whole venture is worth',
      unit: '$',
      value,
      said: money(value),
      working: `${money(amount)} ÷ ${String(share / 100)}`,
      asked: true,
    };
  }
  return null;
}

const ASKS_COVER =
  /\b(?:fewest|least|minimum|smallest number|how many|when)\b.{0,90}\b(?:break(?:s|ing)? ?even|cover(?:s|ed|ing)?|(?:earn|make|get|pay|paid)\w*\b.{0,24}\b(?:back|off|for itself)|(?:do not|don['’]?t|not|without|no longer) (?:\w+ )?(?:los(?:e|ing|s)|a loss|paying)|at a loss)\b/i;

interface Part {
  readonly value: number;
  readonly noun: string | null;
}

/** The fixed cost: a thing bought once, or what a place takes a night. */
function fixedIn(reads: readonly Read[], message: string): Part | null {
  // "the 2800 back": which one it is, is said.
  const named = /\b(?:the|that|those|my|our) \$? ?(\d[\d,]*(?:\.\d+)?)(?: dollars)? (?:back|off)\b/i.exec(
    saidNumbers(message),
  )?.[1];
  const all = reads.flatMap((r) => [
    ...r.quantities
      .filter((q) => (q.role === 'one_time' || q.role === 'period_cost') && q.low === q.high)
      .map((q): Part => ({ value: q.low, noun: q.label })),
    // "The kitchen charges 45 a night": no role of a sale.
    ...r.loose
      .filter((l) => l.kind === 'unknown' && !l.first)
      .map((l): Part => ({ value: l.value, noun: null })),
  ]);
  const told = named === undefined ? all : [{ value: Number(named.replace(/,/g, '')), noun: null }];
  const values = [...new Set(told.map((p) => p.value))];
  return values.length === 1 && values[0] !== undefined && values[0] > 0 ? (told[0] ?? null) : null;
}

/** How many of them cover a cost, when they ask for it and every number has one reading. */
export function coverAsked(s: SumSource, ask: string): UnderstoodSum | null {
  if (!ASKS_COVER.test(plain(`${s.message} . ${ask}`)) && !ASKS_COVER.test(s.message)) return null;
  const record = s.record.map((t) => readText(t));
  const here = [...s.earlier, s.message].map((t) => readText(t));
  const all = [...record, ...here];
  if (all.some((r) => r.foreign)) return null;
  const last = <T>(xs: readonly T[]): T | undefined => xs.at(-1);
  const each = /(?<![\d.])(\d+(?:\.\d+)?)(?: dollars)? each\b/.exec(
    saidNumbers(s.message).replace(/\$ ?/g, ''),
  )?.[1];
  const prices = all.flatMap((r) => r.quantities.filter((q) => q.role === 'price' && q.low === q.high));
  const price = each === undefined ? last(prices)?.low : Number(each);
  if (price === undefined) return null;
  const unitCosts = new Map<string, number>();
  for (const r of all) {
    for (const q of r.quantities)
      if (q.role === 'unit_cost' && q.low === q.high) unitCosts.set(q.label, q.low);
  }
  // "Wire is 6 dollars a lamp": what one costs, told so.
  for (const t of [...s.record, ...s.earlier, s.message]) {
    const m =
      /\b(parts?|materials?|ingredients?|it costs?|costs?|making one)\b[^.;]{0,24}?\$? ?(\d+(?:\.\d+)?)(?: dollars)? (?:a|an|per|for each|each) (?:unit|piece|one|[a-z]+)\b/i.exec(
        saidNumbers(t).replace(/~/g, ''),
      );
    const n = Number(m?.[2]);
    if (m !== null && n > 0 && n < price && ![...unitCosts.values()].includes(n))
      unitCosts.set(m[1] ?? 'parts', n);
  }
  const fixed = fixedIn(all, s.message);
  if (fixed === null) return null;
  const costs = [...unitCosts.values()];
  // An amount nobody placed may be a cost of one: the figure is not theirs to be told.
  const placed = [price, fixed.value, ...costs];
  if (all.some((r) => r.loose.some((l) => !placed.includes(l.value)))) return null;
  const left = price - costs.reduce((sum, c) => sum + c, 0);
  if (left <= 0) return null;
  const noun = last(prices)?.noun ?? null;
  const value = Math.ceil(fixed.value / left - 1e-9);
  const plural = noun === null ? 'sales' : value === 1 ? noun : noun.endsWith('s') ? noun : `${noun}s`;
  const each1 = costs.length === 0 ? money(price) : `(${[price, ...costs].map(money).join(' − ')})`;
  return {
    label: `how many you need to cover the ${money(fixed.value)}`,
    unit: 'units',
    value,
    said: `${String(value)} ${plural}`,
    working: `${money(fixed.value)} ÷ ${each1}`,
    asked: true,
  };
}

/** The asked figure nobody worked out; null: none, or it has more than one reading. */
export function askedSum(u: Understanding | null, s: SumSource): UnderstoodSum | null {
  if (u?.sums.some((x) => x.asked) === true) return null;
  return worthAsked(s) ?? (u === null ? null : coverAsked(s, u.ask));
}
