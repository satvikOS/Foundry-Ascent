import type { ChatMessage } from '../gateway/types.js';
import { escapeData, truncate } from '../prompts/escape.js';
import { readParts, type UnderstandContext } from './check.js';
import { nameKey } from './expr.js';
import { figuresIn, placedIn, sameNumber, type Figure } from './figures.js';
import { inputOf } from './merge.js';
import type { SumsReading } from './schema.js';

/**
 * A second opinion on a sum, asked for once and only where a cheap check disagrees with the first: a plan with no sum, a sum
 * code could not work out, a figure of what is kept or reached that leaves out a cost or a count told in the same line.
 */
export interface SumsDoubt {
  readonly code: 'plan' | 'drop' | 'unused';
  /** What to look at again, in words: ours, with numbers of theirs alone. */
  readonly hint: string;
  /** The numbers left out (`unused`). */
  readonly unused: readonly number[];
}

const said = (value: string | null): boolean => value !== null && !/^\s*(?:null|none)?\s*$/iu.test(value);

/** Figures that take every cost: what is kept, what is needed to reach something, a price that has to cover it. */
const TAKES_COSTS =
  /\b(?:keep|kept|left|leaves?|mak(?:e|es|ing)|made|earn\w*|profit\w*|clear|take home|stays?|remain\w*|pocket|net|los(?:e|es|ing|t)|margin|worth it|break ?even|cover\w*|pa(?:y|ys|id) (?:back|off|for)|fewest|at least|reach\w*|match\w*|price|charge)\b/iu;

/** The numbers a sum's expression works with. */
function usedIn(reading: SumsReading): number[] {
  const inputs = new Map(reading.n.flatMap((n) => inputOf(n) ?? []).map((i) => [nameKey(i.name), i.value]));
  return reading.s.flatMap((s) => [
    ...(s.e.match(/[a-z_][a-z0-9_]*/giu) ?? []).flatMap((w) => inputs.get(nameKey(w)) ?? []),
    ...(s.e.match(/\d[\d,]*(?:\.\d+)?/gu) ?? []).map((n) => Number(n.replace(/,/gu, ''))),
  ]);
}

const uses = (used: readonly number[], f: Figure): boolean =>
  used.some((n) => sameNumber(n, f.value) || sameNumber(n, f.value / 100));

/** A figure that comes off, or that says how many of them there are. */
const counts = (f: Figure, after: string): boolean =>
  f.mark === '$' ||
  f.mark === '%' ||
  (f.mark === null && f.time?.by === -1) ||
  (f.mark === null && f.counts !== true && f.value > 2 && /^\s?(?:each\b|per\b|and\b|,|\.|$)/iu.test(after));

/** Figures told in a line the sum takes a number from, which it leaves out. */
function leftOut(reading: SumsReading, context: UnderstandContext): number[] {
  const used = usedIn(reading);
  const lines = context.record.map((r) => r.text);
  const told = lines.filter((text) => figuresIn(text).some((f) => uses(used, f) && f.value > 1));
  const money = figuresIn(context.message).filter((f) => f.mark === '$' || f.mark === '%');
  const out = [
    ...told.flatMap((text) => placedIn(text).flatMap((p) => (counts(p.figure, p.after) ? [p.figure] : []))),
    ...money,
  ]
    .filter((f) => f.mark !== 'foreign' && f.value > 0 && !uses(used, f))
    .map((f) => f.value);
  return [...new Set(out)].slice(0, 4);
}

/** What to ask again about; null: the first answer stands. */
export function sumsDoubt(reading: SumsReading, context: UnderstandContext): SumsDoubt | null {
  if (!said(reading.q) || said(reading.m)) return null;
  if (reading.s.length === 0)
    return reading.n.length === 0 && !said(reading.w)
      ? null
      : { code: 'plan', hint: 'It has no sum. Write the sum in s.', unused: [] };
  const { understanding, report } = readParts({ sums: reading }, context);
  if (understanding === null || understanding.sums.length === 0) {
    const [drop] = report.sumDrops;
    const hint =
      drop === 'input' || drop === 'literal'
        ? 'It uses a number that stands nowhere. Use only numbers of the message, the conversation or the record, or name the missing one in m.'
        : drop === 'expr'
          ? 'Its expression names something that is not in n. Write it from the names in n.'
          : drop === 'units'
            ? 'It adds or multiplies things of different kinds. Write it again.'
            : drop === 'zero' || drop === 'range'
              ? 'It comes to nothing that can be. Write it again.'
              : null;
    return hint === null ? null : { code: 'drop', hint, unused: [] };
  }
  // A share, a rate or a time takes no cost.
  if (reading.s.every((s) => /^(?:%|percent|x$|months?|weeks?|days?|hours?|minutes?)/iu.test(s.u.trim())))
    return null;
  if (!TAKES_COSTS.test([reading.q, ...reading.s.map((s) => s.l)].join('. '))) return null;
  const unused = leftOut(reading, context);
  return unused.length === 0
    ? null
    : {
        code: 'unused',
        hint: `It leaves out ${unused.map(String).join(', ')}. If one of these is a cost, a fee, or how many of the same thing there are, the sum takes it: write it again with it. If none is, write the same.`,
        unused,
      };
}

/** The call made once more. */
export function sumsAgain(
  messages: readonly ChatMessage[],
  reading: SumsReading,
  doubt: SumsDoubt,
): ChatMessage[] {
  const last = messages.at(-1);
  if (last === undefined) return [];
  const answer = JSON.stringify({ q: reading.q, w: reading.w, n: reading.n, s: reading.s });
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: `${last.content}\n\nYou answered ${escapeData(truncate(answer, 700))}. Look again. ${doubt.hint}`,
    },
  ];
}

/** Which of the two stands: the second only where it answers the doubt. */
export function betterSums(
  first: SumsReading,
  second: SumsReading,
  doubt: SumsDoubt,
  context: UnderstandContext,
): SumsReading {
  const { understanding } = readParts({ sums: second }, context);
  const worked = (understanding?.sums.length ?? 0) > 0;
  if (doubt.code !== 'unused') return worked || said(second.m) ? second : first;
  const used = usedIn(second);
  return worked && doubt.unused.some((n) => used.some((u) => sameNumber(u, n) || sameNumber(u, n / 100)))
    ? second
    : first;
}
