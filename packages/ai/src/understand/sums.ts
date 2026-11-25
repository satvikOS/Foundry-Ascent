import { evaluate, nameKey, nodesOf, parseExpr, renderExpr, type Expr, type Leaf } from './expr.js';
import { figuresIn, sameNumber, saidAmounts, type FigureMark } from './figures.js';
import type { RawUnderstanding } from './schema.js';
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
  /** Inputs that were found where the model says they are, of all it named. */
  readonly inputs: { readonly named: number; readonly found: number; readonly anywhere: number };
}

/** Largest result said. */
const MAX_VALUE = 1e9;
const MAX_INPUTS = 10;
const MAX_SUMS = 3;

/** Plain constants (days, weeks, months, minutes, percent): they multiply and divide; only 1 and 100 also add and subtract. */
const STANDARD = [1, 4, 4.3, 4.33, 4.345, 7, 12, 24, 30, 52, 60, 100, 365, 0.01];
const ADDS = [1, 100];
const isStandard = (n: number): boolean => STANDARD.some((v) => sameNumber(v, n));

type RawInput = RawUnderstanding['inputs'][number];

interface Found {
  readonly value: number;
  /** `said`: an amount in a word ("half"). */
  readonly mark: FigureMark | 'unmarked' | 'said';
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
    return { value, mark: marks.size === 1 ? (only ?? 'unmarked') : 'unmarked' };
  }
  if (wanted > 0 && wanted < 1) {
    const percent = figures.find((f) => f.mark === '%' && sameNumber(f.value, wanted * 100));
    if (percent !== undefined) return { value: Math.sign(value) * percent.value, mark: '%' };
  }
  const said = saidAmounts(text);
  if (said.some((s) => sameNumber(s, wanted))) return { value, mark: 'said' };
  return said.some((s) => s > 0 && s < 1 && sameNumber(s * 100, wanted)) ? { value, mark: '%' } : null;
}

const recordText = (line: RecordLine): string => line.text;

/** The text an input says it comes from; null: no such place. */
function textOf(from: string, s: SumSources): string | null {
  const key = from.trim();
  if (/^(?:message|history|conversation)$/iu.test(key)) return `${s.message}\n${s.history}`;
  const line = s.record.find((r) => r.key.toLowerCase() === key.toLowerCase().replace(/[^r\d]/giu, ''));
  return line === undefined ? null : recordText(line);
}

const everywhere = (s: SumSources): string => [s.message, s.history, ...s.record.map(recordText)].join('\n');

interface Input {
  readonly value: number;
  readonly unit: RawInput['unit'];
  readonly foreign: boolean;
}

/** An input with the value and the unit its source gives it; null: nobody gave it. */
function inputOf(raw: RawInput, s: SumSources, strict: boolean): Input | null {
  if (!Number.isFinite(raw.value) || Math.abs(raw.value) > MAX_VALUE * 10) return null;
  if (/^standard$/iu.test(raw.from.trim()))
    return isStandard(raw.value) && (raw.unit === 'count' || raw.unit === 'time')
      ? { value: raw.value, unit: raw.unit, foreign: false }
      : null;
  const place = textOf(raw.from, s);
  // The message itself is the nearest place: a number in it is theirs whatever line it was credited to.
  const found =
    (place === null ? null : foundIn(raw.value, place)) ??
    foundIn(raw.value, s.message) ??
    (strict ? null : foundIn(raw.value, everywhere(s)));
  if (found === null) return null;
  // "Half" is a share as it is said, never half a percent.
  if (found.mark === 'said')
    return { value: found.value, unit: raw.unit === '%' ? 'count' : raw.unit, foreign: false };
  const unit = found.mark === '%' ? '%' : found.mark === '$' || found.mark === 'foreign' ? '$' : raw.unit;
  return { value: found.value, unit, foreign: found.mark === 'foreign' };
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
      const v = rounded(value, 2);
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
    case 'months':
    case 'hours': {
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

/** A count to reach is a whole one, rounded up, whatever the model says of rounding. */
const TO_REACH =
  /\b(?:break.?even|fewest|at least|minimum|to cover|to pay (?:for|back|off)|pays? (?:for )?itself|to earn back|how many .{0,40}\b(?:need|needed|must|have to|it takes))\b/iu;

interface Literal extends Found {
  readonly money: 0 | 1 | null;
}

interface SumContext {
  readonly sources: SumSources;
  readonly inputs: ReadonlyMap<string, Input>;
  readonly unknown: ReadonlySet<string>;
  readonly labelOk: (label: string) => string | null;
  readonly askText: string;
}

type Summed = { readonly sum: UnderstoodSum } | { readonly drop: SumDrop; readonly invented?: string };

function sumOf(raw: RawUnderstanding['sums'][number], c: SumContext): Summed {
  const names = new Set([...c.inputs.keys(), ...c.unknown]);
  const parsed = parseExpr(raw.expr, names);
  if (parsed === null) return { drop: 'expr' };
  const { expr } = parsed;
  const nodes = nodesOf(expr);
  if (!nodes.some((n) => n.t === 'bin')) return { drop: 'trivial' };
  for (const n of nodes)
    if (n.t === 'name' && c.unknown.has(n.name)) return { drop: 'input', invented: n.name };
  // Numbers written into it: theirs, or a plain constant where a constant may stand (what it is of is then open).
  const literals = new Map<Expr, Literal>();
  const text = everywhere(c.sources);
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
  const inputOfName = (name: string): Input =>
    c.inputs.get(name) ?? { value: NaN, unit: 'count', foreign: false };
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
    if (n.t === 'num') return { value, money: literals.get(n)?.money ?? 0 };
    return { value, money: inputOfName(n.name).unit === '$' ? 1 : 0 };
  };
  const found = evaluate(expr, leafOf);
  if (typeof found === 'string') return { drop: found };
  const wants = raw.unit === '$' ? 1 : 0;
  if (found.money !== null && found.money !== wants) return { drop: 'units' };
  const total = raw.unit === '%' && asShare ? found.value * 100 : found.value;
  const reach = TO_REACH.test(raw.label) || (raw.asked && TO_REACH.test(c.askText));
  const round = raw.round === 'up' || parsed.up || (raw.round === 'none' && reach) ? 'up' : raw.round;
  const result = saidResult(total, raw.unit, nounOf(raw.noun), round);
  if (result === null) return { drop: 'range' };
  const label = c.labelOk(raw.label);
  if (label === null) return { drop: 'label' };
  const working = renderExpr(expr, (n) => {
    const value = n.t === 'num' ? (literals.get(n)?.value ?? n.v) : inputOfName(n.name).value;
    if (isPercent(n)) return `${plainNumber(value, 2)}%`;
    const money =
      n.t === 'num'
        ? literals.get(n)?.mark === '$'
        : inputOfName(n.name).unit === '$' && !inputOfName(n.name).foreign;
    return money ? saidMoney(value) : plainNumber(value, 4);
  });
  return {
    sum: { label, unit: raw.unit, value: result.value, said: result.said, working, asked: raw.asked },
  };
}

/** The sums of a reading, worked out by code from numbers the founder gave. */
export function checkSums(
  raw: Pick<RawUnderstanding, 'inputs' | 'sums'>,
  sources: SumSources,
  options: {
    readonly labelOk: (label: string) => string | null;
    readonly askText: string;
    /** Every input is in the place it names (or the message itself); else anywhere of theirs is enough. */
    readonly strict: boolean;
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
    const kept = options.strict ? strict : loose;
    if (kept === null) unknown.add(key);
    else {
      inputs.set(key, kept);
      unknown.delete(key);
    }
  }
  const sums: UnderstoodSum[] = [];
  const drops: SumDrop[] = [];
  let invented: string | null = null;
  for (const raws of raw.sums.slice(0, MAX_SUMS)) {
    const summed = sumOf(raws, {
      sources,
      inputs,
      unknown,
      labelOk: options.labelOk,
      askText: options.askText,
    });
    if ('drop' in summed) {
      drops.push(summed.drop);
      if (summed.invented !== undefined && raws.asked) invented ??= summed.invented.replace(/_/g, ' ');
    } else if (!sums.some((s) => s.said === summed.sum.said && s.working === summed.sum.working))
      sums.push(summed.sum);
  }
  return { sums, invented, drops, inputs: { named, found, anywhere } };
}
