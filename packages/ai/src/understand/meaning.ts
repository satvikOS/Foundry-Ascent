import type { Expr } from './expr.js';
import type { Figure, Period } from './figures.js';

/**
 * The meaning of a sum, corrected where the founder's words say the opposite: commissions earned against commissions paid,
 * margins against markups, conversions between periods without need, parts bigger than their wholes. Every correction
 * rewrites the expression over the same inputs; no number enters that was not given.
 */
export type SumMend = 'ours' | 'theirs' | 'margin' | 'time' | 'share';

type Leaf = Expr & { t: 'num' | 'name' };
/** A leaf as its source text describes it. */
export interface LeafFacts extends Pick<Figure, 'takes' | 'ofPrice' | 'onTop' | 'time'> {
  readonly percent: boolean;
  /** Standard constant. */
  readonly standard: boolean;
}

export interface SumMeaning {
  readonly label: string;
  /** Message and question together. */
  readonly asked: string;
  readonly unit: string;
  readonly of: (leaf: Leaf) => LeafFacts;
}

const num = (v: number): Expr => ({ t: 'num', v });
const bin = (op: '+' | '-' | '*' | '/', a: Expr, b: Expr): Expr => ({ t: 'bin', op, a, b });
const isNum = (e: Expr, v: number): boolean => e.t === 'num' && e.v === v;
const isLeaf = (e: Expr): e is Leaf => e.t === 'num' || e.t === 'name';

/** Bottom-up rewriting: `made` returns a replacement or null. */
function rebuilt(e: Expr, made: (node: Expr) => Expr | null): Expr {
  const inner: Expr =
    e.t === 'bin'
      ? { ...e, a: rebuilt(e.a, made), b: rebuilt(e.b, made) }
      : e.t === 'neg' || e.t === 'pct'
        ? { ...e, a: rebuilt(e.a, made) }
        : e;
  return made(inner) ?? inner;
}

/** The leaf of a share (`p`, `p%`, `p / 100`), else null. */
function shareOf(e: Expr, is: (leaf: Leaf) => boolean): Leaf | null {
  if (isLeaf(e)) return is(e) ? e : null;
  if (e.t === 'pct') return isLeaf(e.a) && is(e.a) ? e.a : null;
  return e.t === 'bin' && e.op === '/' && isNum(e.b, 100) && isLeaf(e.a) && is(e.a) ? e.a : null;
}

/** The complement of a share: `1 − p`, `1 − p / 100`, `100 − p`. */
function restOf(
  e: Expr,
  is: (leaf: Leaf) => boolean,
): { readonly share: Expr; readonly hundred: boolean } | null {
  if (e.t !== 'bin' || e.op !== '-') return null;
  if (isNum(e.a, 1) && shareOf(e.b, is) !== null) return { share: e.b, hundred: false };
  return isNum(e.a, 100) && isLeaf(e.b) && is(e.b) ? { share: e.b, hundred: true } : null;
}

/** Another person's part is wanted. */
const THEIR_PART =
  /\b(?:they|them|their|he|she|his|her|(?:lender|seller|owner|tutor|driver|maker|artist|provider|host|farmer|cook|supplier|cleaner|coach|baker|painter|teacher|sitter|rider|lister|creator|vendor)s?)\b/iu;
const YOUR_PART = /\b(?:you|your|we|our|us|i|me|my)\b/iu;

/** "We take 8%": income is that share, never its complement. */
function ours(e: Expr, m: SumMeaning): Expr | null {
  const is = (leaf: Leaf): boolean => {
    const f = m.of(leaf);
    return f.percent && f.takes === 'us' && f.onTop !== true && f.ofPrice !== true;
  };
  if (THEIR_PART.test(m.label) && !YOUR_PART.test(m.label)) return null;
  // Retention counts people, no money.
  if (/\b(?:lose|lost|leav\w*|drop\w*|cancel\w*|churn\w*|stay\w*)\b/iu.test(m.label)) return null;
  const hits: Expr[] = [];
  /** The share in place of its complement, as a factor alone: a divisor solves for a price. */
  const turned = (x: Expr): Expr | null => {
    const rest = restOf(x, is);
    if (rest !== null) return rest.share;
    const hundred = x.t === 'bin' && x.op === '/' && isNum(x.b, 100) ? restOf(x.a, is) : null;
    return hundred === null ? null : bin('/', hundred.share, num(100));
  };
  const out = rebuilt(e, (node) => {
    if (node.t !== 'bin' || node.op !== '*') return null;
    const [a, b] = [turned(node.a), turned(node.b)];
    if (a === null && b === null) return null;
    hits.push(e);
    return bin('*', a ?? node.a, b ?? node.b);
  });
  return hits.length > 0 ? out : null;
}

const KEEPS =
  /\b(?:keep|kept|left|leaves?|net|clear|take home|hits?|reach(?:es)?|comes? to (?:you|me|us)|stays?|get|gets|got)\b/iu;

/** "The site takes 15%": income is the complement. */
function theirs(e: Expr, m: SumMeaning): Expr | null {
  const is = (leaf: Leaf): boolean => {
    const f = m.of(leaf);
    return f.percent && f.takes === 'them' && f.onTop !== true;
  };
  if (!KEEPS.test(`${m.label}. ${m.asked}`) || (THEIR_PART.test(m.label) && !YOUR_PART.test(m.label)))
    return null;
  // Subtracted already.
  const minus: Expr[] = [];
  rebuilt(e, (node) => {
    if (node.t === 'bin' && node.op === '-' && holds(node.b, is)) minus.push(node);
    return null;
  });
  if (minus.length > 0) return null;
  const hits: Expr[] = [];
  const out = rebuilt(e, (node) => {
    if (node.t !== 'bin' || node.op !== '*') return null;
    const right = shareOf(node.b, is);
    const left = shareOf(node.a, is);
    if (right === null && left === null) return null;
    hits.push(e);
    const [whole, share] = right === null ? [node.b, node.a] : [node.a, node.b];
    return bin('*', whole, bin('-', num(1), share));
  });
  // "whole × p ÷ 100": `÷ 100` moves to its share.
  const tidy = rebuilt(out, (node) => {
    if (node.t !== 'bin' || node.op !== '/' || !isNum(node.b, 100)) return null;
    if (node.a.t !== 'bin' || node.a.op !== '*') return null;
    const rest = restOf(node.a.b, is);
    return rest === null || !isLeaf(rest.share)
      ? null
      : bin('*', node.a.a, bin('-', num(1), bin('/', rest.share, num(100))));
  });
  return hits.length > 0 ? tidy : null;
}

function holds(e: Expr, is: (leaf: Leaf) => boolean): boolean {
  switch (e.t) {
    case 'num':
    case 'name':
      return is(e);
    case 'bin':
      return holds(e.a, is) || holds(e.b, is);
    case 'neg':
    case 'pct':
      return holds(e.a, is);
  }
}

/** The share of `whole` that `e` is, as it is written; null: it is none. */
function partOf(e: Expr, whole: Expr, is: (leaf: Leaf) => boolean): Expr | null {
  if (e.t !== 'bin') return null;
  const same = (x: Expr): boolean => JSON.stringify(x) === JSON.stringify(whole);
  if (e.op === '*') return same(e.a) && shareOf(e.b, is) !== null ? e.b : null;
  if (e.op !== '/' || !isNum(e.b, 100) || e.a.t !== 'bin' || e.a.op !== '*') return null;
  return same(e.a.a) && isLeaf(e.a.b) && is(e.a.b) ? bin('/', e.a.b, num(100)) : null;
}

const PRICE_ASKED = /\b(?:price|charge|ask for|sell (?:it|them|one)? ?(?:for|at))\b/iu;

/** Margins: cost divided by the complement; markups multiply. */
function margin(e: Expr, m: SumMeaning): Expr | null {
  const is = (leaf: Leaf): boolean => {
    const f = m.of(leaf);
    return f.percent && f.ofPrice === true;
  };
  if (!PRICE_ASKED.test(`${m.label}. ${m.asked}`)) return null;
  const hits: Expr[] = [];
  const out = rebuilt(e, (node) => {
    if (node.t !== 'bin') return null;
    const up = (x: Expr): Expr | null =>
      x.t === 'bin' && x.op === '+' && isNum(x.a, 1) && shareOf(x.b, is) !== null ? x.b : null;
    const over = (whole: Expr, share: Expr): Expr => {
      hits.push(e);
      return bin('/', whole, bin('-', num(1), share));
    };
    if (node.op === '*') {
      const [right, left] = [up(node.b), up(node.a)];
      if (right !== null) return over(node.a, right);
      if (left !== null) return over(node.b, left);
    }
    // "cost + cost × 40%", "cost + cost × 40 ÷ 100".
    if (node.op === '+') {
      const part = partOf(node.b, node.a, is);
      if (part !== null) return over(node.a, part);
    }
    // "cost ÷ 40%".
    return node.op === '/' && shareOf(node.b, is) !== null ? over(node.a, node.b) : null;
  });
  return hits.length > 0 ? out : null;
}

/** Constants that turn one period into another. */
const TURNS = [4, 4.3, 4.33, 4.345, 7, 12, 30, 52, 365];
const TURNS_ON: Readonly<Record<Period, RegExp>> = {
  day: /\b(?:days?|daily|nights?)\b/iu,
  week: /\b(?:weeks?|weekly|weekends?)\b/iu,
  month: /\b(?:months?|monthly)\b/iu,
  year: /\b(?:years?|yearly|annual(?:ly)?)\b/iu,
};

/** Time constants among numbers that all share one period, with no other period wanted. */
function time(e: Expr, m: SumMeaning): Expr | null {
  if (/^(?:days|weeks|months|years)$/u.test(m.unit)) return null;
  const periods = new Set<Period>();
  const constants: Leaf[] = [];
  rebuilt(e, (node) => {
    if (!isLeaf(node)) return null;
    const f = m.of(node);
    if (f.time !== undefined) periods.add(f.time.period);
    if (f.standard && node.t === 'num' && TURNS.includes(node.v)) constants.push(node);
    return null;
  });
  const [only] = periods;
  if (periods.size !== 1 || only === undefined || constants.length === 0) return null;
  const asked = (Object.keys(TURNS_ON) as Period[]).filter((p) => TURNS_ON[p].test(m.label));
  if (asked.some((p) => p !== only)) return null;
  const isTurn = (x: Expr): boolean => isLeaf(x) && constants.includes(x);
  const hits: Expr[] = [];
  const out = rebuilt(e, (node) => {
    if (node.t !== 'bin' || (node.op !== '*' && node.op !== '/')) return null;
    if (isTurn(node.b)) {
      hits.push(e);
      return node.a;
    }
    if (node.op === '*' && isTurn(node.a)) {
      hits.push(e);
      return node.b;
    }
    return null;
  });
  return hits.length > 0 ? out : null;
}

/** Expression and corrections. */
export function meant(e: Expr, m: SumMeaning): { readonly expr: Expr; readonly mends: readonly SumMend[] } {
  let expr = e;
  const mends: SumMend[] = [];
  for (const [code, mend] of [
    ['ours', ours],
    ['theirs', theirs],
    ['margin', margin],
    ['time', time],
  ] as const) {
    const put = mend(expr, m);
    if (put === null) continue;
    expr = put;
    mends.push(code);
  }
  return { expr, mends };
}

const OF_A_WHOLE =
  /\b(?:share|rate|how often|percent(?:age)?|proportion|fraction|accura\w+|hits?|conver\w+|turned into|came back|of (?:the|all|them|those|your|my|our))\b/iu;
const OF_A_CHANGE =
  /\b(?:change|growth|grew|grow\w*|rise|rose|increase\w*|more|up|better|faster|gain|markup|mark-up|on top|jump\w*)\b/iu;

/** Part and whole were swapped: a share above 100%; null where no swap applies. */
export function turnedShare(e: Expr, label: string): Expr | null {
  if (!OF_A_WHOLE.test(label) || OF_A_CHANGE.test(label)) return null;
  const times = e.t === 'bin' && e.op === '*' && isNum(e.b, 100);
  const inner = times ? e.a : e;
  if (inner.t !== 'bin' || inner.op !== '/' || isNum(inner.b, 100)) return null;
  const turned = bin('/', inner.b, inner.a);
  return times ? bin('*', turned, num(100)) : turned;
}
