import type { Expr } from './expr.js';
import { figuresIn, type Figure, type Period } from './figures.js';

/**
 * The meaning of a sum, corrected where the founder's words say the opposite: commissions earned against commissions paid,
 * margins against markups, conversions between periods without need, parts bigger than their wholes. Every correction
 * rewrites the expression over the same inputs; no number enters that was not given.
 */
export type SumMend = 'ours' | 'theirs' | 'part' | 'margin' | 'time' | 'share' | 'instead';

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
  /** The value a leaf stands for. */
  readonly value?: (leaf: Leaf) => number;
  /** The message and the reply before it, for a follow-up that changes one number ("and at 25 instead?"). */
  readonly followUp?: { readonly message: string; readonly lastReply: string };
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
  /\b(?:they|them|their|he|she|his|her|(?:lender|seller|owner|tutor|driver|maker|artist|provider|host|farmer|cook|supplier|cleaner|coach|baker|painter|teacher|sitter|rider|lister|creator|vendor|helper|worker|assistant|guide|nanny|carer|freelancer|contractor|member|student)s?|staff|crew)\b/iu;
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

/**
 * "We hold back 10%" and the figure is the sitter's: what reaches them is the complement. A share of ours used as their part is
 * turned; a share already taken off is left.
 */
function part(e: Expr, m: SumMeaning): Expr | null {
  const is = (leaf: Leaf): boolean => {
    const f = m.of(leaf);
    return f.percent && f.takes === 'us' && f.onTop !== true && f.ofPrice !== true;
  };
  if (!THEIR_PART.test(m.label) || YOUR_PART.test(m.label)) return null;
  const done: Expr[] = [];
  // "x × p ÷ 100" is read as it stands.
  rebuilt(e, (node) => {
    if (node.t === 'bin' && node.op === '/' && isNum(node.b, 100)) done.push(node);
    return null;
  });
  rebuilt(e, (node) => {
    if (restOf(node, is) !== null || (node.t === 'bin' && node.op === '-' && holds(node.b, is)))
      done.push(node);
    return null;
  });
  if (done.length > 0) return null;
  const hits: Expr[] = [];
  const out = rebuilt(e, (node) => {
    if (node.t !== 'bin' || node.op !== '*') return null;
    const right = shareOf(node.b, is);
    const left = right === null ? shareOf(node.a, is) : null;
    if (right === null && left === null) return null;
    hits.push(node);
    return right === null
      ? bin('*', bin('-', num(1), node.a), node.b)
      : bin('*', node.a, bin('-', num(1), node.b));
  });
  return hits.length === 1 ? out : null;
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

/** A follow-up that changes one number: "and at 25 instead?", "what if it's 4.50". */
const INSTEAD =
  /\b(?:instead|in place of|rather than)\b|^\W*(?:(?:and|ok|okay|so|but|now)\W+)?(?:with|at|if (?:it(?:['’]?s| is| was)|we (?:charge|take|keep)))\b/iu;
/** The working of a reply's figure: what follows its colon ("You keep $270: $1,500 × (20% − 2%)."). */
const WORKING = /:\s*([^\n:]*?\d[^\n:]*?)(?:\.(?:\s|$)|\n|$)/u;

/**
 * The number a follow-up brings takes the place of the earlier number it is like, not of another: "and at 25 instead?"
 * after "$1,500 × (20% − 2%)" is 25% for 20%, never $25 for $1,500. Only where the sum is the reply's working
 * with one number changed, the number it put aside is far from the new one (ten times or more) and another is near it
 * (within three times) and still in the sum: then the two change places.
 */
function instead(e: Expr, m: SumMeaning): Expr | null {
  const f = m.followUp;
  const value = m.value;
  if (f === undefined || value === undefined || !INSTEAD.test(f.message)) return null;
  const told = figuresIn(f.message).filter((x) => x.value > 0);
  const [n] = told;
  if (told.length !== 1 || n === undefined) return null;
  const working = WORKING.exec(f.lastReply)?.[1];
  if (working === undefined) return null;
  const before = figuresIn(working).filter((x) => x.value > 0);
  const leaves: Leaf[] = [];
  /** Leaves written with their own %: "18%". */
  const marked = new Set<Expr>();
  rebuilt(e, (node) => {
    if (isLeaf(node)) leaves.push(node);
    if (node.t === 'pct') marked.add(node.a);
    return null;
  });
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  const valueOf = (leaf: Leaf): number => {
    const v = value(leaf);
    return m.of(leaf).percent && v < 1 ? v * 100 : v;
  };
  const newLeaves = leaves.filter((l) => same(valueOf(l), n.value));
  const [fresh] = newLeaves;
  if (newLeaves.length !== 1 || fresh === undefined) return null;
  const kept = leaves.filter((l) => l !== fresh).map(valueOf);
  const gone = before.filter((b) => !same(b.value, n.value) && !kept.some((k) => same(k, b.value)));
  const [put] = gone;
  if (gone.length !== 1 || put === undefined) return null;
  const far = (a: number, b: number): number => Math.abs(Math.log(a / b));
  const near = before
    .filter((b) => b !== put && !same(b.value, n.value))
    .sort((a, b) => far(a.value, n.value) - far(b.value, n.value))[0];
  if (near === undefined || far(near.value, n.value) >= Math.log(3) || far(put.value, n.value) < Math.log(10))
    return null;
  const nearLeaves = leaves.filter((l) => l !== fresh && same(valueOf(l), near.value));
  const [old] = nearLeaves;
  if (nearLeaves.length !== 1 || old === undefined) return null;
  // A share written with its own % that held the wrong number cannot take a sum of money.
  if (marked.has(fresh) && put.mark !== '%') return null;
  const as = (leaf: Leaf, v: number, percent: boolean): Expr =>
    percent && !marked.has(leaf) ? { t: 'pct', a: num(v) } : num(v);
  return rebuilt(e, (node) =>
    node === old
      ? as(old, n.value, near.mark === '%' || m.of(old).percent)
      : node === fresh
        ? as(fresh, put.value, put.mark === '%')
        : null,
  );
}

/** Expression and corrections. */
export function meant(e: Expr, m: SumMeaning): { readonly expr: Expr; readonly mends: readonly SumMend[] } {
  let expr = e;
  const mends: SumMend[] = [];
  for (const [code, mend] of [
    ['ours', ours],
    ['theirs', theirs],
    ['part', part],
    ['margin', margin],
    ['time', time],
    ['instead', instead],
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
