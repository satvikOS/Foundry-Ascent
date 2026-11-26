import {
  evaluate,
  mapLeaves,
  nameKey,
  nodesOf,
  parseExpr,
  renderExpr,
  type Expr,
  type Leaf,
} from './expr.js';
import {
  PERIODS,
  figuresIn,
  sameNumber,
  saidAmounts,
  type Figure,
  type FigureMark,
  type Period,
} from './figures.js';
import { lossLabel, phraseOf, withPeriod } from './labels.js';
import { meant, turnedShare, type SumMend } from './meaning.js';
import { slotWords } from './shapes.js';
import type { RawInput, RawSum, RawUnderstanding } from './schema.js';
import { type RecordLine, type SumUnit, type UnderstoodSum } from './types.js';

/** Where a number of a sum may come from: the founder's own words, the conversation, their record. */
export interface SumSources {
  readonly message: string;
  /** The conversation in view, both sides. */
  readonly history: string;
  readonly record: readonly RecordLine[];
}

/** Why a sum was left out (codes for logs and the bench, never words). */
export type SumDrop =
  'expr' | 'input' | 'literal' | 'units' | 'zero' | 'range' | 'currency' | 'trivial' | 'label';

export interface CheckedSums {
  readonly sums: readonly UnderstoodSum[];
  /** An input nobody gave, as it is named, of a sum that was left out for it. */
  readonly invented: string | null;
  readonly drops: readonly SumDrop[];
  /** What was put right where their words mean it the other way round (meaning.ts). */
  readonly mends: readonly SumMend[];
  /** Inputs that were found where the model says they are (or in the message), and anywhere of theirs, of all it named. */
  readonly inputs: { readonly named: number; readonly found: number; readonly anywhere: number };
}

/** Largest result said. */
const MAX_VALUE = 1e9;
const MAX_INPUTS = 12;
const MAX_SUMS = 3;
/** Sums read of one answer: the one they asked for may come after its parts. */
const MAX_READ = 6;

/** Plain constants (days, weeks, months, minutes, percent): they multiply and divide; only 1 and 100 also add and subtract. */
const STANDARD = [1, 4, 4.3, 4.33, 4.345, 7, 12, 24, 30, 52, 60, 100, 365, 0.01];
const ADDS = [1, 100];
/** Nodes of one expression, the sums it is built on included. */
const MAX_NODES = 80;
const isStandard = (n: number): boolean => STANDARD.some((v) => sameNumber(v, n));

interface Found extends Pick<Figure, 'time' | 'onTop' | 'counts' | 'takes' | 'ofPrice'> {
  readonly value: number;
  /** `said`: an amount in a word ("half"). */
  readonly mark: FigureMark | 'unmarked' | 'said';
}

/** Who a share goes to and what it is of, where every place that holds it says the same. */
function sharesOf(figures: readonly Figure[]): Pick<Figure, 'takes' | 'ofPrice'> {
  const [takes, ...others] = [...new Set(figures.map((f) => f.takes))];
  return {
    ...(takes === undefined || others.length > 0 ? {} : { takes }),
    ...(figures.every((f) => f.ofPrice === true) ? { ofPrice: true as const } : {}),
  };
}

/**
 * The value as a text gives it: the number itself, "12%" for 0.12, "half" for 0.5. `mark`: what the text says it is, when
 * it says one thing only.
 */
export function foundIn(value: number, text: string): Found | null {
  const figures = figuresIn(text);
  const wanted = Math.abs(value);
  const exact = figures.filter((f) => sameNumber(f.value, wanted));
  if (exact.length > 0) {
    const marks = new Set(exact.map((f) => f.mark));
    const [only] = marks;
    const times = new Set(
      exact.map((f) => (f.time === undefined ? '' : `${f.time.period}${String(f.time.by)}`)),
    );
    const [first] = exact;
    return {
      value,
      mark: marks.size === 1 ? (only ?? 'unmarked') : 'unmarked',
      ...(times.size === 1 && first?.time !== undefined ? { time: first.time } : {}),
      ...(exact.every((f) => f.onTop === true) ? { onTop: true as const } : {}),
      ...(exact.some((f) => f.counts === true) ? { counts: true as const } : {}),
      ...sharesOf(exact),
    };
  }
  if (wanted > 0 && wanted < 1) {
    const percent = figures.find((f) => f.mark === '%' && sameNumber(f.value, wanted * 100));
    if (percent !== undefined)
      return {
        value: Math.sign(value) * percent.value,
        mark: '%',
        ...(percent.onTop === true ? { onTop: true as const } : {}),
        ...sharesOf([percent]),
      };
  }
  const said = saidAmounts(text);
  const word = said.find((s) => sameNumber(s, wanted) || (s < 1 && Math.abs(s - wanted) < 0.004));
  if (word !== undefined) return { value: Math.sign(value) * word, mark: 'said' };
  return said.some((s) => s > 0 && s < 1 && sameNumber(s * 100, wanted)) ? { value, mark: '%' } : null;
}

/** Numbers of one line beyond which two of them come to anything. */
const MAX_LINE_FIGURES = 8;

const recordText = (line: RecordLine): string => line.text;

/** The text an input says it comes from; null: no such place. */
function textOf(from: string, s: SumSources): string | null {
  const key = from.trim();
  if (/^(?:message|history|conversation)$/iu.test(key)) return `${s.message}\n${s.history}`;
  const line = s.record.find((r) => r.key.toLowerCase() === key.toLowerCase().replace(/[^r\d]/giu, ''));
  return line === undefined ? null : recordText(line);
}

const everywhere = (s: SumSources): string => [s.message, s.history, ...s.record.map(recordText)].join('\n');

interface Input extends Pick<Figure, 'time' | 'onTop' | 'takes' | 'ofPrice'> {
  readonly value: number;
  readonly unit: RawInput['unit'];
  readonly foreign: boolean;
  /** A plain constant, of nobody's. */
  readonly standard?: true;
  /** Its own words do not say whether it is money. */
  readonly open?: true;
  /** Two numbers of one line it is worked out of. */
  readonly expr?: Expr;
}

/** An input with the value and the unit its source gives it; null: nobody gave it. */
function inputOf(raw: RawInput, s: SumSources, strict: boolean): Input | null {
  if (!Number.isFinite(raw.value) || Math.abs(raw.value) > MAX_VALUE * 10) return null;
  if (/^standard$/iu.test(raw.from.trim()))
    return isStandard(raw.value) && (raw.unit === 'count' || raw.unit === 'time')
      ? { value: raw.value, unit: raw.unit, foreign: false, standard: true }
      : null;
  const place = textOf(raw.from, s);
  // The message itself is the nearest place: a number in it is theirs whatever line it was credited to.
  const found =
    (place === null ? null : foundIn(raw.value, place)) ??
    foundIn(raw.value, s.message) ??
    (strict ? null : foundIn(raw.value, everywhere(s)));
  if (found === null) return derivedInput(raw, s, place);
  // "Half" is a share as it is said, never half a percent.
  if (found.mark === 'said')
    return { value: found.value, unit: raw.unit === '%' ? 'count' : raw.unit, foreign: false };
  const unit = found.mark === '%' ? '%' : found.mark === '$' || found.mark === 'foreign' ? '$' : raw.unit;
  return {
    value: found.value,
    unit,
    foreign: found.mark === 'foreign',
    // "Glaze 3 and the box 2": a bare number that counts nothing may be money.
    ...((found.mark === null || found.mark === 'unmarked') && unit === 'count' && found.counts !== true
      ? { open: true as const }
      : {}),
    ...(found.time === undefined ? {} : { time: found.time }),
    ...(found.onTop === true ? { onTop: true as const } : {}),
    ...(found.takes === undefined ? {} : { takes: found.takes }),
    ...(found.ofPrice === true ? { ofPrice: true as const } : {}),
  };
}

const num = (v: number): Expr => ({ t: 'num', v });
const bin = (op: '+' | '-' | '*' | '/', a: Expr, b: Expr): Expr => ({ t: 'bin', op, a, b });

/** The one way two numbers of one text come to a value (16 − 4, 4 ÷ 16); null: none, or more than one. */
function workedFrom(value: number, text: string): Expr | null {
  const numbers = [
    ...new Set(figuresIn(text).flatMap((f) => (f.mark === null || f.mark === '$' ? [f.value] : []))),
  ];
  if (numbers.length > MAX_LINE_FIGURES) return null;
  const found: Expr[] = [];
  for (const a of numbers)
    for (const b of numbers) {
      if (a === b) continue;
      if (a > b && sameNumber(a - b, value)) found.push(bin('-', num(a), num(b)));
      if (b !== 0 && a < b && sameNumber(a / b, value)) found.push(bin('/', num(a), num(b)));
    }
  return found.length === 1 ? (found[0] ?? null) : null;
}
/** The same over several texts, each a line of its own. */
function workedInOne(value: number, texts: readonly string[]): Expr | null {
  const found = texts.flatMap((t) => workedFrom(value, t) ?? []);
  return found.length === 1 ? (found[0] ?? null) : null;
}
const linesOf = (s: SumSources): string[] => [s.message, ...s.record.map(recordText)];

/** An input nobody wrote, worked out of two numbers of one line: the operands stay in the working. */
function derivedInput(raw: RawInput, s: SumSources, place: string | null): Input | null {
  const calc = raw.calc === undefined ? null : parseExpr(raw.calc, new Set());
  const expr =
    calc?.expr.t === 'bin'
      ? [...(place === null ? [] : [place]), ...linesOf(s)].some((text) =>
          nodesOf(calc.expr).every((n) => n.t !== 'num' || foundIn(n.v, text) !== null),
        )
        ? calc.expr
        : null
      : ((place === null || /^(?:message|history|conversation)$/iu.test(raw.from.trim())
          ? null
          : workedFrom(raw.value, place)) ?? workedInOne(raw.value, linesOf(s)));
  return expr === null ? null : { value: raw.value, unit: 'count', foreign: false, expr };
}

const grouped = (n: number, places: number): string => {
  const [whole = '0', rest] = Math.abs(n).toFixed(places).split('.');
  const said = whole.replace(/\B(?=(?:\d{3})+$)/gu, ',');
  return rest === undefined ? said : `${said}.${rest}`;
};
const rounded = (n: number, places: number): number => {
  const by = 10 ** places;
  // A hair below a half (2.675 as 2.67499…) is the half it was meant as.
  const r = Math.sign(n) * (Math.round((Math.abs(n) + 1e-9) * by) / by);
  return Object.is(r, -0) ? 0 : r;
};

/** "$192.50", "$1,250,000", "-$45": cents only when it is not whole. */
export function saidMoney(value: number): string {
  const v = rounded(value, 2);
  return `${v < 0 ? '-' : ''}$${grouped(v, Number.isInteger(v) ? 0 : 2)}`;
}
const plainNumber = (value: number, places: number): string => {
  const v = rounded(value, places);
  const text = grouped(v, places);
  return `${v < 0 ? '-' : ''}${text.includes('.') ? text.replace(/\.?0+$/u, '') : text}`;
};

const counted = (n: number, noun: string | null, unit: 'people' | 'units'): string => {
  const what = noun ?? (unit === 'people' ? (n === 1 ? 'person' : 'people') : '');
  const one = n === 1 && noun !== null ? what.replace(/(?<=[^s])s$/u, '') : what;
  return `${grouped(n, 0)}${one === '' ? '' : ` ${one}`}`;
};

/** A result as it is said; null: not one of its unit. */
export function saidResult(
  value: number,
  unit: SumUnit,
  noun: string | null,
  round: 'none' | 'up' | 'down',
): { readonly value: number; readonly said: string } | null {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE) return null;
  switch (unit) {
    case '$': {
      // A thousand or more is said in whole dollars.
      const v = rounded(value, Math.abs(value) >= 1_000 ? 0 : 2);
      return v === 0 && Math.abs(value) > 1e-9 ? null : { value: v, said: saidMoney(v) };
    }
    case '%': {
      const v = rounded(value, 1);
      return { value: v, said: `${plainNumber(v, 1)}%` };
    }
    case 'people':
    case 'units': {
      if (value < 0) return null;
      const whole =
        round === 'up'
          ? Math.ceil(value - 1e-9)
          : round === 'down'
            ? Math.floor(value + 1e-9)
            : Math.round(value + 1e-9);
      const about = round === 'none' && Math.abs(value - whole) > 1e-6;
      return { value: whole, said: `${about ? 'about ' : ''}${counted(whole, noun, unit)}` };
    }
    case 'minutes':
    case 'hours':
    case 'days':
    case 'weeks':
    case 'months':
    case 'years': {
      if (value < 0) return null;
      const v = rounded(value, 1);
      const word = v === 1 ? unit.slice(0, -1) : unit;
      return { value: v, said: `${plainNumber(v, 1)} ${word}` };
    }
    case 'x': {
      if (value < 0) return null;
      const v = rounded(value, 1);
      return { value: v, said: `${plainNumber(v, 1)}x` };
    }
  }
}

/** What a count is of, when it is a plain word or two. */
export const nounOf = (noun: string | null): string | null => {
  const said = (noun ?? '').trim().toLowerCase();
  return /^[a-z][a-z'-]{1,20}(?: [a-z'-]{2,20}){0,2}$/u.test(said) ? said : null;
};

/** A label that counts things to reach something. */
const COUNTED =
  /^(?:the )?(?:fewest |number of |least )*([a-z]{2,20}s) (?:(?:that )?(?:you |they )?(?:need|needed|have|must|it takes)\b|(?:a (?:day|week|month|year) )?to (?:break|cover|pay|earn|reach|match|make|get|recover|win)\b)/iu;
/** A count to reach is a whole one, rounded up, whatever the model says of rounding. */
const TO_REACH =
  /\b(?:break.?even|fewest|at least|minimum|to cover|to pay (?:for|back|off)|pays? (?:for )?itself|to earn back|how many .{0,40}\b(?:need|needed|must|have to|it takes))\b/iu;

interface Literal extends Found {
  readonly money: 0 | 1 | null;
}

// Time ----------------------------------------------------------------------------------------------------------------

/** What an expression is of time: `{ month: -1 }` is a month's; null: it cannot be told. */
type Times = Readonly<Partial<Record<Period, number>>>;
const NO_TIME: Times = {};
const present = (t: Times): Period[] => PERIODS.filter((p) => (t[p] ?? 0) !== 0);
const sameTimes = (a: Times, b: Times): boolean => PERIODS.every((p) => (a[p] ?? 0) === (b[p] ?? 0));

function timesOf(e: Expr, of: (leaf: Expr & { t: 'num' | 'name' }) => Figure['time']): Times | null {
  switch (e.t) {
    case 'num':
    case 'name': {
      const time = of(e);
      return time === undefined ? NO_TIME : { [time.period]: time.by };
    }
    case 'neg':
    case 'pct':
      return timesOf(e.a, of);
    case 'bin': {
      const a = timesOf(e.a, of);
      const b = timesOf(e.b, of);
      if (a === null || b === null) return null;
      if (e.op === '*' || e.op === '/')
        return Object.fromEntries(
          PERIODS.map((p) => [p, (a[p] ?? 0) + (e.op === '*' ? 1 : -1) * (b[p] ?? 0)]),
        );
      // What says nothing of time goes with what does.
      if (present(a).length === 0) return b;
      return present(b).length === 0 || sameTimes(a, b) ? a : null;
    }
  }
}

/** How many of one period another holds, as it is worked out: `[52, 12]` is × 52 ÷ 12. */
const PER_PERIOD: Readonly<Record<Period, Readonly<Record<Period, readonly [number, number]>>>> = {
  day: { day: [1, 1], week: [7, 1], month: [30, 1], year: [365, 1] },
  week: { day: [1, 7], week: [1, 1], month: [52, 12], year: [52, 1] },
  month: { day: [1, 30], week: [12, 52], month: [1, 1], year: [12, 1] },
  year: { day: [1, 365], week: [1, 52], month: [1, 12], year: [1, 1] },
};
/** A leaf of one period as one of another: 5 hours a week are 5 × 52 ÷ 12 a month. */
function inPeriod(leaf: Expr, time: NonNullable<Figure['time']>, wanted: Period): Expr {
  // What lasts goes the other way: 6 weeks are 6 × 12 ÷ 52 months.
  const [up, down] = time.by === -1 ? PER_PERIOD[time.period][wanted] : PER_PERIOD[wanted][time.period];
  const times = up === 1 ? leaf : bin('*', leaf, num(up));
  return down === 1 ? times : bin('/', times, num(down));
}

const PERIOD_UNITS: Readonly<Partial<Record<SumUnit, Period>>> = {
  days: 'day',
  weeks: 'week',
  months: 'month',
  years: 'year',
};

/** The share of `whole` that `e` is, as it is written; null: it is none. */
function partOf(
  e: Expr,
  whole: Expr,
  share: (x: Expr) => boolean,
  onTop: (leaf: Expr) => boolean,
): Expr | null {
  if (e.t !== 'bin') return null;
  const same = (x: Expr): boolean => JSON.stringify(x) === JSON.stringify(whole);
  const other = (x: Expr, is: (of: Expr) => boolean): Expr | null =>
    x.t !== 'bin' || x.op !== '*' ? null : same(x.a) && is(x.b) ? x.b : same(x.b) && is(x.a) ? x.a : null;
  if (e.op === '*') return other(e, share);
  if (e.op !== '/' || e.b.t !== 'num' || e.b.v !== 100) return null;
  const of = other(e.a, onTop);
  return of === null ? null : bin('/', of, num(100));
}

/** A share put on top of a base never comes off the whole: "whole × (1 − 8%)" of one that is on top is whole ÷ (1 + 8%). */
function withOnTop(e: Expr, onTop: (leaf: Expr) => boolean): Expr {
  if (e.t === 'num' || e.t === 'name') return e;
  if (e.t === 'neg' || e.t === 'pct') return { ...e, a: withOnTop(e.a, onTop) };
  const a = withOnTop(e.a, onTop);
  const b = withOnTop(e.b, onTop);
  const share = (x: Expr): boolean =>
    onTop(x) ||
    (x.t === 'pct' && onTop(x.a)) ||
    (x.t === 'bin' && x.op === '/' && x.b.t === 'num' && x.b.v === 100 && onTop(x.a));
  const rest = (x: Expr): Expr | null =>
    x.t === 'bin' && x.op === '-' && x.a.t === 'num' && x.a.v === 1 && share(x.b)
      ? { t: 'bin', op: '+', a: x.a, b: x.b }
      : null;
  if (e.op === '*') {
    const right = rest(b);
    if (right !== null) return bin('/', a, right);
    const left = rest(a);
    if (left !== null) return bin('/', b, left);
  }
  // "whole − whole × 8%", "whole − whole × 8 ÷ 100".
  const part = e.op === '-' ? partOf(b, a, share, onTop) : null;
  if (part !== null) return bin('/', a, { t: 'bin', op: '+', a: num(1), b: part });
  return { ...e, a, b };
}

/** Bare numbers that are added to or taken off money: money themselves ("glaze 3" of "$24 − $6 − 3"). */
function moneyBeside(e: Expr, leafOf: (leaf: Expr & { t: 'num' | 'name' }) => Leaf): ReadonlySet<Expr> {
  const found = new Set<Expr>();
  const isMoney = (x: Expr): boolean => {
    const read = evaluate(x, leafOf);
    return typeof read !== 'string' && read.money === 1;
  };
  const mark = (x: Expr): void => {
    if (x.t === 'num' || x.t === 'name') {
      if (leafOf(x).money === null) found.add(x);
    } else if (x.t === 'bin' && (x.op === '+' || x.op === '-')) {
      mark(x.a);
      mark(x.b);
    }
  };
  for (const n of nodesOf(e)) {
    if (n.t !== 'bin' || (n.op !== '+' && n.op !== '-')) continue;
    if (isMoney(n.a)) mark(n.b);
    if (isMoney(n.b)) mark(n.a);
  }
  return found;
}

// One sum -------------------------------------------------------------------------------------------------------------

interface SumContext {
  readonly sources: SumSources;
  readonly inputs: ReadonlyMap<string, Input>;
  readonly unknown: ReadonlySet<string>;
  /** Sums read before this one, by the name their label gives them: "income - costs". */
  readonly earlier: Map<string, Expr>;
  readonly labelOk: (label: string) => string | null;
  readonly askText: string;
}

type Summed =
  | { readonly sum: UnderstoodSum; readonly mends: readonly SumMend[] }
  | { readonly drop: SumDrop; readonly invented?: string };

function sumOf(raw: RawSum, c: SumContext): Summed {
  const names = new Set([...c.inputs.keys(), ...c.unknown, ...c.earlier.keys()]);
  const parsed = parseExpr(raw.expr, names);
  if (parsed === null) return { drop: 'expr' };
  const text = everywhere(c.sources);
  const whole = mapLeaves(parsed.expr, (leaf) => {
    if (leaf.t === 'num')
      return isStandard(leaf.v) || foundIn(leaf.v, text) !== null
        ? leaf
        : (workedInOne(leaf.v, linesOf(c.sources)) ?? leaf);
    const input = c.inputs.get(leaf.name);
    if (input !== undefined) return input.expr ?? leaf;
    return c.unknown.has(leaf.name) ? leaf : (c.earlier.get(leaf.name) ?? leaf);
  });
  if (nodesOf(whole).length > MAX_NODES) return { drop: 'expr' };
  if (!nodesOf(whole).some((n) => n.t === 'bin')) return { drop: 'trivial' };
  for (const n of nodesOf(whole))
    if (n.t === 'name' && c.unknown.has(n.name)) return { drop: 'input', invented: n.name };
  const inputOfName = (name: string): Input =>
    c.inputs.get(name) ?? { value: NaN, unit: 'count', foreign: false };
  const facts = (leaf: Expr & { t: 'num' | 'name' }) => {
    const own = leaf.t === 'name' ? inputOfName(leaf.name) : foundIn(leaf.v, text);
    return {
      percent:
        leaf.t === 'name'
          ? inputOfName(leaf.name).unit === '%'
          : own !== null && 'mark' in own && own.mark === '%',
      standard: leaf.t === 'num' && isStandard(leaf.v) && own === null,
      ...(own?.takes === undefined ? {} : { takes: own.takes }),
      ...(own?.ofPrice === true ? { ofPrice: true as const } : {}),
      ...(own?.onTop === true ? { onTop: true as const } : {}),
      ...(own?.time === undefined || (leaf.t === 'num' && isStandard(leaf.v)) ? {} : { time: own.time }),
    };
  };
  const put = meant(whole, { label: raw.label, asked: c.askText, unit: raw.unit, of: facts });
  c.earlier.set(nameKey(raw.label), put.expr);
  const mends = [...put.mends];
  const shown = withOnTop(
    put.expr,
    (leaf) =>
      (leaf.t === 'name' && inputOfName(leaf.name).onTop === true) ||
      (leaf.t === 'num' && leaf.v !== 100 && foundIn(leaf.v, text)?.onTop === true),
  );
  const told = inOnePeriod(shown, raw.unit, inputOfName, text);
  const { period } = told;
  let { expr } = told;
  const nodes = nodesOf(expr);
  // Numbers written into it: theirs, or a plain constant where a constant may stand (what it is of is then open).
  const literals = new Map<Expr, Literal>();
  const readLiterals = (e: Expr, op: '+' | '-' | '*' | '/' | null): boolean => {
    if (e.t === 'num') {
      const own = foundIn(e.v, text);
      const scales = isStandard(e.v) && (op === '*' || op === '/');
      const standard = scales || (isStandard(e.v) && ADDS.includes(e.v) && own === null);
      literals.set(
        e,
        own === null
          ? { value: e.v, mark: null, money: 0 }
          : scales
            ? { value: e.v, mark: null, money: own.mark === '$' ? null : 0 }
            : {
                value: own.value,
                mark: own.mark,
                money: own.mark === '$' || own.mark === 'foreign' ? 1 : null,
              },
      );
      return standard || own !== null;
    }
    if (e.t === 'name') return true;
    if (e.t === 'neg') return readLiterals(e.a, op);
    if (e.t === 'pct') return readLiterals(e.a, '*');
    return readLiterals(e.a, e.op) && readLiterals(e.b, e.op);
  };
  if (!readLiterals(expr, null)) return { drop: 'literal' };
  const leaves = nodes.filter((n): n is Expr & { t: 'num' | 'name' } => n.t === 'num' || n.t === 'name');
  const foreign = leaves.some((n) =>
    n.t === 'name' ? inputOfName(n.name).foreign : literals.get(n)?.mark === 'foreign',
  );
  if (foreign && raw.unit === '$') return { drop: 'currency' };
  // "fee / 100" says itself that fee is a percentage; a percentage used as it is stands for its share.
  const isHundred = (e: Expr): boolean => e.t === 'num' && e.v === 100;
  const perHundred = nodes.some(
    (n) => (n.t === 'bin' && n.op === '/' && isHundred(n.b)) || (n.t === 'num' && n.v === 0.01),
  );
  const timesHundred = nodes.some((n) => n.t === 'bin' && n.op === '*' && (isHundred(n.a) || isHundred(n.b)));
  const pctArgs = new Set<Expr>(nodes.flatMap((n) => (n.t === 'pct' ? [n.a] : [])));
  const isPercent = (n: Expr & { t: 'num' | 'name' }): boolean =>
    n.t === 'name' ? inputOfName(n.name).unit === '%' : literals.get(n)?.mark === '%';
  const anyPercent = leaves.some(isPercent);
  const divides = nodes.some((n) => n.t === 'bin' && n.op === '/');
  const asShare = !perHundred && (raw.unit !== '%' || (!timesHundred && (divides || anyPercent)));
  const leafOf = (n: Expr & { t: 'num' | 'name' }): Leaf => {
    const value = n.t === 'num' ? (literals.get(n)?.value ?? n.v) : inputOfName(n.name).value;
    if (isPercent(n)) return { value: asShare && !pctArgs.has(n) ? value / 100 : value, money: 0 };
    if (n.t === 'num') {
      const literal = literals.get(n);
      return { value, money: literal === undefined ? 0 : literal.money };
    }
    const input = inputOfName(n.name);
    return { value, money: input.open === true ? null : input.unit === '$' ? 1 : 0 };
  };
  let found = evaluate(expr, leafOf);
  if (raw.unit === '%' && typeof found !== 'string' && (asShare ? found.value * 100 : found.value) > 100) {
    const turned = turnedShare(expr, `${raw.label}. ${c.askText}`);
    const again = turned === null ? null : evaluate(turned, leafOf);
    if (turned !== null && again !== null && typeof again !== 'string') {
      expr = turned;
      found = again;
      mends.push('share');
    }
  }
  const beside = moneyBeside(expr, leafOf);
  if (typeof found === 'string') return { drop: found };
  const wants = raw.unit === '$' ? 1 : 0;
  if (found.money !== null && found.money !== wants) return { drop: 'units' };
  const total = raw.unit === '%' && asShare ? found.value * 100 : found.value;
  // "kits to pay for the table": so many, however it is marked.
  const things = raw.unit === 'x' ? COUNTED.exec(raw.label)?.[1]?.toLowerCase() : undefined;
  const unit: SumUnit = things === undefined ? raw.unit : 'units';
  const noun = nounOf(things ?? raw.noun);
  const reach = TO_REACH.test(raw.label) || (raw.asked && TO_REACH.test(c.askText));
  const round = raw.round === 'up' || parsed.up || (raw.round === 'none' && reach) ? 'up' : raw.round;
  const result = saidResult(total, unit, noun, round);
  if (result === null) return { drop: 'range' };
  const named = c.labelOk(phraseOf(raw.label, raw.unit));
  if (named === null) return { drop: 'label' };
  const loss = raw.unit === '$' && result.value < 0 ? lossLabel(named) : null;
  const label = withPeriod(loss ?? named, raw.unit === '%' || raw.unit === 'x' ? null : period);
  const working = renderExpr(expr, (n) => {
    const value = n.t === 'num' ? (literals.get(n)?.value ?? n.v) : inputOfName(n.name).value;
    if (isPercent(n)) return `${plainNumber(value, 2)}%`;
    if (beside.has(n)) return saidMoney(value);
    const money =
      n.t === 'num'
        ? literals.get(n)?.mark === '$'
        : inputOfName(n.name).unit === '$' && !inputOfName(n.name).foreign;
    return money ? saidMoney(value) : plainNumber(value, 4);
  });
  return {
    sum: {
      label,
      unit,
      value: result.value,
      // "What you lose is $45", never "what you keep is -$45".
      said: loss === null ? result.said : saidMoney(-result.value),
      working,
      asked: raw.asked,
    },
    mends,
  };
}

/** The expression with everything of one period, and the period its result is of. */
function inOnePeriod(
  e: Expr,
  unit: SumUnit,
  inputOfName: (name: string) => Input,
  text: string,
): { readonly expr: Expr; readonly period: Period | null } {
  const timeOf = (leaf: Expr & { t: 'num' | 'name' }): Figure['time'] =>
    leaf.t === 'name'
      ? inputOfName(leaf.name).time
      : isStandard(leaf.v)
        ? undefined
        : (foundIn(leaf.v, text)?.time ?? undefined);
  const leaves = nodesOf(e).filter((n): n is Expr & { t: 'num' | 'name' } => n.t === 'num' || n.t === 'name');
  // The model turned months into weeks itself: nothing is turned twice, and what the result is of is its own to say.
  const turned = leaves.some((n) =>
    n.t === 'name'
      ? inputOfName(n.name).standard === true
      : isStandard(n.v) && !ADDS.includes(n.v) && n.v !== 0.01,
  );
  if (turned) return { expr: e, period: null };
  const read = leaves.flatMap((n) => timeOf(n) ?? []);
  const units = [...new Set(read.map((t) => t.period))];
  const lasts = PERIOD_UNITS[unit] ?? null;
  const wanted = lasts ?? PERIODS.findLast((p) => units.includes(p)) ?? null;
  const net = timesOf(e, timeOf);
  const alone = net === null ? [] : present(net);
  const convert =
    wanted !== null &&
    (units.length > 1 ||
      (lasts !== null && alone.length === 1 && net?.[alone[0] ?? 'day'] === 1 && alone[0] !== lasts));
  const expr = convert
    ? mapLeaves(e, (leaf) => {
        const time = timeOf(leaf);
        return time === undefined || time.period === wanted ? leaf : inPeriod(leaf, time, wanted);
      })
    : e;
  if (lasts !== null) return { expr, period: null };
  const result = convert
    ? timesOf(e, (leaf) => {
        const time = timeOf(leaf);
        return time === undefined ? undefined : { ...time, period: wanted };
      })
    : net;
  const of = result === null ? [] : present(result);
  return { expr, period: of.length === 1 && result?.[of[0] ?? 'day'] === -1 ? (of[0] ?? null) : null };
}

/** The sums of a reading, worked out by code from numbers the founder gave. */
export function checkSums(
  raw: Pick<RawUnderstanding, 'inputs' | 'sums'>,
  sources: SumSources,
  options: {
    readonly labelOk: (label: string) => string | null;
    readonly askText: string;
  },
): CheckedSums {
  const inputs = new Map<string, Input>();
  const unknown = new Set<string>();
  let named = 0;
  let found = 0;
  let anywhere = 0;
  for (const input of raw.inputs.slice(0, MAX_INPUTS)) {
    const key = nameKey(input.name);
    if (key === '' || inputs.has(key)) continue;
    named += 1;
    const strict = inputOf(input, sources, true);
    const loose = inputOf(input, sources, false);
    if (strict !== null) found += 1;
    if (loose !== null) anywhere += 1;
    // Theirs wherever it stands: a number credited to the wrong line is still a number they gave.
    if (loose === null) unknown.add(key);
    else {
      inputs.set(key, strict ?? loose);
      unknown.delete(key);
    }
  }
  const sums: UnderstoodSum[] = [];
  const drops: SumDrop[] = [];
  const mends: SumMend[] = [];
  let invented: string | null = null;
  const earlier = new Map<string, Expr>();
  for (const raws of raw.sums.slice(0, MAX_READ)) {
    const summed = sumOf(raws, {
      sources,
      inputs,
      unknown,
      earlier,
      labelOk: options.labelOk,
      askText: options.askText,
    });
    if ('drop' in summed) {
      drops.push(summed.drop);
      // A slot's name says what it is in words ("cost12": what it costs you).
      if (summed.invented !== undefined && raws.asked)
        invented ??= slotWords(summed.invented) ?? summed.invented.replace(/_/g, ' ');
    } else if (!sums.some((s) => s.said === summed.sum.said && s.working === summed.sum.working)) {
      sums.push(summed.sum);
      mends.push(...summed.mends);
    }
  }
  // What they asked for first, as it was written.
  const kept = [...sums.filter((x) => x.asked), ...sums.filter((x) => !x.asked)].slice(0, MAX_SUMS);
  return { sums: kept, invented, drops, mends, inputs: { named, found, anywhere } };
}
