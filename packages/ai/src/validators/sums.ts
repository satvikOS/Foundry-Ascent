import { spelledNumbersIn } from './figures.js';
import { unitsOf } from './units.js';

/**
 * Sums in a reply, worked out by code. The model writes a sum of the founder's own numbers inside a marker
 * (`[[a - b dollars]]`) and never its result; the server puts the working and the result in its place ("a - b = c
 * dollars", on a call "a minus b, so c dollars"). A sum the model worked out itself all the same ("a minus b leaves c") is
 * checked, and its result put right. Deterministic, per unit, the same for a streamed reply and a whole one:
 *
 * 1. every number of a marker is theirs (their words, the record, the sources shown, the path), a result of a sum said
 *    before, or a plain constant (12 months, 52 weeks, 100 percent…) that only multiplies or divides; else the clause or
 *    the sentence that carries it goes, as any figure nobody gave does;
 * 2. the units must fit: money times money, a count less an amount, a count said as dollars are no sum of theirs;
 * 3. an amount below zero is told only by a sentence that says a loss;
 * 4. a marker that cannot be read never reaches the founder;
 * 5. a wrong result of a sum written out is corrected when its numbers are theirs and it can be read one way only; else it
 *    goes. What was wrong once ("12") is no figure to build on in the sentences after it.
 *
 * Read again, a rendered sum stays as it is.
 */

export type SumFinding = 'sum_rendered' | 'sum_repaired' | 'sum_dropped';

/** What a number is of: money, a count of things, or not known. */
type Dim = 'money' | 'count' | null;

const EPS = 1e-9;
const MAX_RESULT = 1e10;
const MAX_OPERANDS = 12;

// What is known ------------------------------------------------------------------------------------------------------

const CURRENCY_SIGN = '[$£€₦₵¥₹₩]';
const DOLLAR_WORD = '(?:dollars?|bucks?|usd)';
const CURRENCY_WORD =
  '(?:dollars?|bucks?|usd|euros?|pounds?|quid|cedis?|naira|shillings?|rand|rupees?|pesos?|reais|yen|yuan|dirhams?|riyals?|francs?|birr|kwacha|taka|ringgit|baht|lira|zloty)';
const CENT_WORD = '(?:cents?|pence|pesewas|kobo)';
const IS_CURRENCY = new RegExp(`^${CURRENCY_WORD}$`, 'iu');
const IS_CENTS = new RegExp(`^${CENT_WORD}$`, 'iu');
const IS_DOLLARS = new RegExp(`^${DOLLAR_WORD}$`, 'iu');
const STARTS_MONEY = new RegExp(`^(?:${CURRENCY_WORD}|${CENT_WORD})\\b`, 'iu');
const STARTS_DOLLARS = new RegExp(`^(?:${DOLLAR_WORD}|cents?)\\b`, 'iu');
const MONTH =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const DATES = new RegExp(
  String.raw`\b${MONTH}\.? \d{1,2}(?:st|nd|rd|th)?\b(?:,? \d{4}\b)?|\b\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH}\b(?: \d{4}\b)?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?::\d{2})? ?(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b\d{1,2}:\d{2}\b`,
  'giu',
);
const KEYS = /\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/giu;

const NUMBER_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)';
const NUMBER_RUN = new RegExp(
  String.raw`\b(?:a (?=hundred|thousand|million))?${NUMBER_WORD}(?:(?:[ -]|,? and (?=${NUMBER_WORD}\b))${NUMBER_WORD})*\b`,
  'giu',
);
const TEENS_UP =
  /^(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)$/iu;

/** The numbers a text spells, as digits ("sixteen clubs" → "16 clubs"); a run that is several numbers stays. */
export function spelledAsDigits(text: string): string {
  return text.replace(NUMBER_RUN, (run) => {
    // "Twelve fifty" is a price, as people say one.
    const price = TEENS_UP.exec(run);
    if (price !== null) {
      const [whole] = spelledNumbersIn(price[1] ?? '');
      const [part] = spelledNumbersIn(price[2] ?? '');
      return whole === undefined || part === undefined ? run : `${String(whole)}.${String(part)}`;
    }
    if (/^one$/iu.test(run)) return '1';
    const values = spelledNumbersIn(run);
    return values.length === 1 && values[0] !== undefined ? String(values[0]) : run;
  });
}

const FOREIGN = new RegExp(
  String.raw`[£€₦₵¥₹₩]|\d ?(?:(?!dollars?\b|bucks?\b|usd\b)${CURRENCY_WORD})\b|\b(?:GHS|NGN|KES|KSh|ZAR|INR|UGX|EUR|GBP) ?\d|\d ?(?:GHS|NGN|KES|KSh|ZAR|INR|UGX|EUR|GBP)\b`,
  'iu',
);

const KNOWN_NUMBER = new RegExp(
  String.raw`(${CURRENCY_SIGN}\s?)?(?<![\d.])(\d[\d,]*(?:\.\d+)?)(?:\s?(k\b|thousand\b|million\b|m\b|bn\b|billion\b))?(\s?(?:%|percent\b|per cent\b))?(?:[ -]?(${CENT_WORD})\b)?(?: ?(${CURRENCY_WORD})\b)?(?:\s+(\p{L}+))?`,
  'giu',
);

const SCALE: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
};

const NO_COUNT = new Set(
  'is was has us less minus plus times across this its as does goes costs sells pays always perhaps towards unless'.split(
    ' ',
  ),
);

/** A plain constant a sum may multiply or divide by: weeks, months, days, minutes, percent. */
const FACTORS = [4, 4.3, 4.33, 4.345, 7, 12, 52, 60, 100];

const same = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);

/** What a sum of this turn may use, with what each number is of; results of sums join it as they are said. */
export class SumFacts {
  readonly #dims = new Map<number, Set<'money' | 'count' | '?'>>();
  readonly #percents: number[] = [];
  /** Results of sums worked out or checked here, the latest last. */
  readonly results: { readonly value: number; readonly kind: ResultKind }[] = [];
  /** Wrong results put right: nothing after them builds on these. */
  readonly wrong: number[] = [];
  /** What the sums came to, as text: what the checks of a figure read besides what was known. */
  rendered = '';
  /** The money spoken of: dollars, another currency, or both. */
  #dollars = false;
  #foreign = false;

  constructor(known: string, earlierReplies: readonly (string | null | undefined)[] = []) {
    this.#read(known);
    // A result said in an earlier reply, when its own numbers are known.
    for (const reply of earlierReplies) {
      if (typeof reply !== 'string' || !/\d/.test(reply)) continue;
      for (const unit of unitsOf(reply)) plainSums(unit.raw, this, { repair: false });
    }
    this.wrong.length = 0;
    this.results.length = 0;
  }

  #read(text: string): void {
    const t = spelledAsDigits(
      text
        .normalize('NFKC')
        .replace(KEYS, ' ')
        .replace(DATES, ' ')
        .replace(/\bhalf a dozen\b/giu, '6')
        .replace(/\b(?:a|one) dozen\b/giu, '12')
        .replace(/\b(\d+) dozen\b/giu, (_m, n: string) => String(Number(n) * 12))
        .replace(/\bhour and a half\b/giu, '1.5 hours, 90 minutes')
        .replace(/\bhalf (?:an )?hour\b/giu, '0.5 hours, 30 minutes')
        .replace(/\b(?:a |one )?quarter[- ](?:of an )?hour\b/giu, '15 minutes, 0.25 hours')
        .replace(/\ba (dollar|buck)\b/giu, '1 $1'),
    );
    // "Twelve dollars and fifty cents", "a dollar fifty".
    for (const m of t.matchAll(
      new RegExp(String.raw`(\d+) ${CURRENCY_WORD}(?:,? and)? (\d{2})\b(?! \p{L}*s\b(?<!cents))`, 'giu'),
    ))
      this.#put(Number(m[1]) + Number(m[2]) / 100, 'money');
    if (/\$|\b(?:dollars?|bucks?|usd|cents?)\b/iu.test(t)) this.#dollars = true;
    if (FOREIGN.test(t)) this.#foreign = true;
    for (const m of t.matchAll(KNOWN_NUMBER)) {
      const base = Number((m[2] ?? '').replace(/,/g, '')) * (SCALE[(m[3] ?? '').toLowerCase()] ?? 1);
      if (!Number.isFinite(base)) continue;
      if (m[4] !== undefined) {
        this.#percents.push(base);
        this.#put(base, '?');
      } else if (m[5] !== undefined) this.#put(base / 100, 'money');
      else if (m[1] !== undefined || m[6] !== undefined) this.#put(base, 'money');
      else {
        const next = (m[7] ?? '').toLowerCase();
        const counts = /[^s]s$/u.test(next) && !NO_COUNT.has(next);
        this.#put(base, counts || next === 'people' ? 'count' : '?');
      }
    }
  }

  #put(value: number, dim: 'money' | 'count' | '?'): void {
    const key = Math.round(value * 1e6) / 1e6;
    const set = this.#dims.get(key) ?? new Set();
    set.add(dim);
    this.#dims.set(key, set);
  }

  /** A result of a sum: later sums may use it. */
  addResult(value: number, kind: ResultKind, expr: Expr | null = null): void {
    this.#put(value, kind === 'money' ? 'money' : '?');
    if (kind === 'percent') this.#percents.push(value);
    // As it was said, too.
    const said = kind === 'money' ? Math.round(value * 100) / 100 : Math.round(value * 10) / 10;
    this.#put(said, kind === 'money' ? 'money' : '?');
    this.results.push({ value, kind });
    // What is added and taken off in a sum of money is money too ("the shade 4").
    if (kind === 'money' && expr !== null && onlyAdds(expr))
      for (const l of leavesOf(expr)) if (!l.percent) this.rendered += `\n$${amount(Math.abs(l.value))}`;
    const r = kind === 'money' ? amount(Math.abs(said)) : decimals(Math.abs(value), 2);
    this.rendered +=
      kind === 'money'
        ? `\n$${r}, ${r} dollars`
        : kind === 'percent'
          ? `\n${r}%, ${decimals(Math.abs(value), 1)}%, ${decimals(Math.abs(value), 0)}%`
          : `\n${r}, ${decimals(Math.abs(value), 1)}, ${decimals(Math.abs(value), 0)}`;
  }

  /** Whether a number was given as it is. */
  given(value: number): boolean {
    return this.#dims.has(Math.round(value * 1e6) / 1e6);
  }

  /** Whether a percentage was given, or is the rest of one. */
  givenPercent(value: number): boolean {
    return same(value, 100) || this.#percents.some((p) => same(p, value) || same(100 - p, value));
  }

  /** Whether a number may stand in a sum: given, or a share of a given percentage ("0.4", "0.6"). */
  operand(value: number, percent: boolean): boolean {
    if (percent) return this.givenPercent(value) || this.given(value);
    if (this.given(value)) return true;
    return value > 0 && value < 1 && this.#percents.length > 0 && this.givenPercent(value * 100);
  }

  /** What a number is of, when everything that gave it agrees. */
  dimOf(value: number): Dim {
    const set = this.#dims.get(Math.round(value * 1e6) / 1e6);
    if (set?.size !== 1) return null;
    const [only] = set;
    return only === 'money' || only === 'count' ? only : null;
  }

  /** Their money is in another currency than dollars. */
  get otherCurrency(): boolean {
    return this.#foreign && !this.#dollars;
  }

  /** Their money is in dollars alone, or in no currency said. */
  get dollarsOnly(): boolean {
    return !this.#foreign;
  }

  get values(): number[] {
    return [...this.#dims.keys()];
  }
}

// An expression -------------------------------------------------------------------------------------------------------

export type ResultKind = 'money' | 'percent' | 'count' | 'time' | 'plain';

type Op = '+' | '-' | '*' | '/';

interface Leaf {
  readonly t: 'num';
  readonly value: number;
  readonly percent: boolean;
  /** As it is shown: digits only. */
  readonly shown: string;
  /** Written as money (a sign, a currency word, cents). */
  readonly money: boolean;
}
interface Bin {
  readonly t: 'bin';
  readonly op: Op;
  readonly left: Expr;
  readonly right: Expr;
  /** "a of b": a share, not a product. */
  readonly of?: boolean;
}
type Expr = Leaf | Bin | { readonly t: 'paren'; readonly inner: Expr };

type Tok =
  | Leaf
  | { readonly t: 'op'; readonly op: Op; readonly of?: boolean }
  | { readonly t: 'lp' }
  | { readonly t: 'rp' };

/** Builds the tree of a token list, or null when it is none. */
function parse(tokens: readonly Tok[]): Expr | null {
  let i = 0;
  const primary = (): Expr | null => {
    const tok = tokens[i];
    if (tok === undefined) return null;
    if (tok.t === 'num') {
      i += 1;
      return tok;
    }
    if (tok.t !== 'lp') return null;
    i += 1;
    const inner = sum();
    if (inner === null || tokens[i]?.t !== 'rp') return null;
    i += 1;
    return { t: 'paren', inner };
  };
  const level = (ops: readonly Op[], next: () => Expr | null): Expr | null => {
    let left = next();
    for (;;) {
      const tok = tokens[i];
      if (left === null || tok?.t !== 'op' || !ops.includes(tok.op)) return left;
      i += 1;
      const right = next();
      if (right === null) return null;
      left = { t: 'bin', op: tok.op, left, right, ...(tok.of === true ? { of: true } : {}) };
    }
  };
  const product = (): Expr | null => level(['*', '/'], primary);
  function sum(): Expr | null {
    return level(['+', '-'], product);
  }
  const out = sum();
  return out === null || i < tokens.length ? null : out;
}

const inner = (e: Expr): Exclude<Expr, { t: 'paren' }> => {
  let x = e;
  while (x.t === 'paren') x = x.inner;
  return x;
};

function leavesOf(e: Expr): Leaf[] {
  const x = inner(e);
  return x.t === 'num' ? [x] : [...leavesOf(x.left), ...leavesOf(x.right)];
}

function valueOf(e: Expr): number {
  const x = inner(e);
  if (x.t === 'num') return x.percent ? x.value / 100 : x.value;
  const a = valueOf(x.left);
  const b = valueOf(x.right);
  return x.op === '+' ? a + b : x.op === '-' ? a - b : x.op === '*' ? a * b : a / b;
}

/** Whether an expression only adds and takes off. */
const onlyAdds = (e: Expr): boolean => {
  const x = inner(e);
  return x.t === 'num' || ((x.op === '+' || x.op === '-') && onlyAdds(x.left) && onlyAdds(x.right));
};

/** Whether a side of "+" or "-" is a percentage alone. */
const isPercent = (e: Expr): boolean => {
  const x = inner(e);
  if (x.t === 'num') return x.percent;
  return (x.op === '+' || x.op === '-') && (isPercent(x.left) || isPercent(x.right));
};
const isOne = (e: Expr): boolean => {
  const x = inner(e);
  return x.t === 'num' && !x.percent && x.value === 1;
};

/** What an expression is of; `undefined` when its units do not fit. */
function dimOf(e: Expr, facts: SumFacts): Dim | undefined {
  const x = inner(e);
  if (x.t === 'num') return x.percent ? null : x.money ? 'money' : facts.dimOf(x.value);
  const a = dimOf(x.left, facts);
  const b = dimOf(x.right, facts);
  if (a === undefined || b === undefined) return undefined;
  if (x.op === '+' || x.op === '-') {
    // "16 minus 25%" is said two ways; "1 - 25%" and "100% - 25%" are not.
    if (isPercent(x.left) !== isPercent(x.right) && !isOne(x.left)) return undefined;
    if (a !== null && b !== null && a !== b) return undefined;
    return a === 'money' || b === 'money' ? 'money' : a === 'count' && b === 'count' ? 'count' : null;
  }
  if (x.op === '*') {
    if (a === 'money' && b === 'money') return undefined;
    return a === 'money' || b === 'money' ? 'money' : null;
  }
  if (b === 'money') return a === 'money' || a === null ? null : undefined;
  return a === 'money' ? 'money' : null;
}

/** Whether every number of an expression may stand in it (the constants only where they multiply or divide). */
function grounded(e: Expr, facts: SumFacts): boolean {
  let own = 0;
  const visit = (node: Expr, factor: boolean, share: boolean): boolean => {
    const x = inner(node);
    if (x.t === 'num') {
      if (facts.operand(x.value, x.percent)) {
        own += 1;
        return true;
      }
      if (x.percent) return false;
      return (
        (factor && FACTORS.some((f) => same(f, x.value))) ||
        (share && (x.value === 1 || x.value === 100)) ||
        (factor && x.value === 1)
      );
    }
    if (x.op === '*' || x.op === '/') return visit(x.left, true, false) && visit(x.right, true, false);
    // "1 - 0.4", "100 - 25": the whole of a share.
    const restOf = x.op === '-' && (isPercent(x.right) || inner(x.right).t === 'num');
    const right = inner(x.right);
    const isShare =
      restOf &&
      right.t === 'num' &&
      (right.percent || facts.givenPercent(right.value) || facts.givenPercent(right.value * 100));
    return visit(x.left, false, isShare) && visit(x.right, false, false);
  };
  return visit(e, false, false) && own > 0;
}

// A marker ------------------------------------------------------------------------------------------------------------

const SYMBOLS: readonly (readonly [RegExp, string])[] = [
  [/[−–—‒]/gu, '-'],
  [/[×✕✖⋅·∙]/gu, '*'],
  [/[÷∕⁄]/gu, '/'],
];

const WORD_OPS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:multiplied by|times)\b/giu, '*'],
  [/\b(?:divided by|over)\b/giu, '/'],
  [/\b(?:minus|less)\b/giu, '-'],
  [/\bplus\b/giu, '+'],
  [/(?<=[\d)%a-z] ?)\bx\b(?= ?[$(\d£€])/giu, '*'],
  [/(?<=[\d)])x(?=[$(\d£€])/giu, '*'],
];

/** Words of a label inside a marker that are more than one: the marker cannot be read. */
const NOT_LABEL =
  /^(?:and|or|to|if|not|is|are|was|then|so|about|around|roughly|plus|minus|between|than|but|the|each|with)$/iu;

interface ReadMarker {
  readonly expr: Expr;
  /** The words of the result's unit ("dollars a week", "kits"); '' when none was given. */
  readonly unit: string;
  /** The marker was written in money ("$24 - $6") with a sign. */
  readonly sign: string | null;
  /** "/ 16 percent": the result is a percentage. */
  readonly percent: boolean;
}

/** Reads what stands in a marker; null when it is no sum. */
function readMarker(content: string): ReadMarker | null {
  let t = content.normalize('NFKC');
  for (const [pattern, to] of SYMBOLS) t = t.replace(pattern, to);
  t = spelledAsDigits(t)
    .replace(/^\s*\p{L}[\p{L} ]{0,24}:\s*/u, '')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  for (const [pattern, to] of WORD_OPS) t = t.replace(pattern, to);
  // A result the model wrote all the same is not read; its unit is.
  let resultUnit = '';
  const eq = /\s*=\s*(.*)$/su.exec(t);
  if (eq !== null) {
    t = t.slice(0, eq.index);
    const tail = /^[$£€]?\s?\d[\d.]*\s?(%|[\p{L}][\p{L} ]*)?$/u.exec((eq[1] ?? '').trim());
    if ((eq[1] ?? '').trim() !== '' && tail === null) return null;
    resultUnit = (tail?.[1] ?? '').trim();
    if (/^[$]/.test((eq[1] ?? '').trim()) && resultUnit === '') resultUnit = 'dollars';
  }
  const tokens: Tok[] = [];
  let sign: string | null = null;
  let labelled = false;
  const labels = new Set<string>();
  let trailing: string[] = [];
  let percentLast = false;
  let i = 0;
  const RE =
    /\s*(?:([$£€₦₵¥₹₩])?\s?(\d+(?:\.\d+)?|\.\d+)(k\b)?\s?(%|percent\b|per cent\b)?|([-+*/()])|(\p{L}[\p{L}'’-]*)|(,)(?=\s*\p{L}))/uy;
  const asNumber = (last: Tok | undefined): last is Leaf => last?.t === 'num';
  while (i < t.length) {
    if (/^\s*$/u.test(t.slice(i))) break;
    RE.lastIndex = i;
    const m = RE.exec(t);
    if (m === null) return null;
    i = RE.lastIndex;
    if (m[2] !== undefined) {
      if (tokens.length > 0 && (asNumber(tokens.at(-1)) || tokens.at(-1)?.t === 'rp')) return null;
      const value = Number(m[2]) * (m[3] === undefined ? 1 : 1000);
      if (!Number.isFinite(value)) return null;
      if (m[1] !== undefined) sign = m[1];
      if (trailing.length > 0) {
        labelled = true;
        trailing = [];
      }
      percentLast = m[4] !== undefined;
      tokens.push({
        t: 'num',
        value,
        percent: m[4] !== undefined,
        shown: shownNumber(value, m[2]),
        money: m[1] !== undefined,
      });
      continue;
    }
    if (m[5] !== undefined) {
      if (trailing.length > 0) {
        if (trailing.length > 4 || trailing.some((w) => NOT_LABEL.test(w))) return null;
        const last = tokens.at(-1);
        const money = trailing.find((w) => IS_CURRENCY.test(w));
        const cents = trailing.some((w) => IS_CENTS.test(w));
        if (asNumber(last) && (money !== undefined || cents))
          tokens[tokens.length - 1] = {
            ...last,
            money: true,
            ...(cents ? { value: last.value / 100, shown: shownNumber(last.value / 100, '') } : {}),
          };
        if (money !== undefined && IS_DOLLARS.test(money)) sign ??= '$';
        for (const w of trailing) if (!IS_CURRENCY.test(w) && !IS_CENTS.test(w)) labels.add(w.toLowerCase());
        if (labels.size > 0) labelled = true;
        trailing = [];
      }
      if (m[5] === '(') tokens.push({ t: 'lp' });
      else if (m[5] === ')') tokens.push({ t: 'rp' });
      else tokens.push({ t: 'op', op: m[5] as Op });
      continue;
    }
    const word = m[6] ?? '';
    if (word === '') continue;
    // "4 of 16", "4 out of 16": a share; "25% of 16": a part.
    const ofRest = /^\s*(?:the |my |your |all )?(?=[$(\d])/iu.exec(t.slice(i));
    const of = /^of$/iu.test(word) && ofRest !== null;
    const outOf = /^out$/iu.test(word) && /^\s*of\s+(?=\d)/iu.test(t.slice(i));
    if (of || outOf) {
      const last = tokens.at(-1);
      const before = trailing.filter((w) => !IS_CURRENCY.test(w));
      if (!asNumber(last) || before.length > 3) return null;
      trailing = [];
      if (outOf) i += /^\s*of\s+/iu.exec(t.slice(i))?.[0].length ?? 0;
      else i += ofRest?.[0].length ?? 0;
      tokens.push(last.percent ? { t: 'op', op: '*' } : { t: 'op', op: '/', of: true });
      continue;
    }
    trailing.push(word);
    if (trailing.length > 7) return null;
  }
  if (tokens.length > MAX_OPERANDS * 2 + 8) return null;
  // "50 cents" at the end is an amount when the rest is not in cents.
  const last = tokens.at(-1);
  if (asNumber(last) && trailing.length > 0 && IS_CENTS.test(trailing[0] ?? '')) {
    if (tokens.length > 1 && tokens.some((x) => x.t === 'num' && x !== last && x.value < last.value)) {
      tokens[tokens.length - 1] = {
        ...last,
        value: last.value / 100,
        shown: shownNumber(last.value / 100, ''),
        money: true,
      };
      trailing = trailing.slice(1);
      sign ??= '$';
    }
  }
  let expr = parse(tokens);
  if (expr === null) return null;
  // "a / b percent", "100 - b percent": the percent is the result's; "a * 25%": the number's own.
  let percent = false;
  if (percentLast && trailing.length === 0 && asNumber(last)) {
    const root = inner(expr);
    const others = leavesOf(expr).slice(0, -1);
    const glued = /%\s*$/u.test(t.trim());
    const resultOwn =
      root.t === 'bin' &&
      (root.op === '/' ||
        ((root.op === '+' || root.op === '-') && others.length > 0 && others.every((l) => !l.percent))) &&
      !(glued && root.op !== '/');
    const hundred =
      others.some((l) => l.value === 100) || (last.value === 100 && hasDivision(expr) && !glued);
    if (resultOwn || hundred) {
      const plain = tokens.slice(0, -1).concat({ ...last, percent: false });
      expr = parse(plain);
      if (expr === null) return null;
      percent = true;
    }
  }
  let unit = trailing.join(' ');
  if (/^(?:%|percent|per cent)\b/iu.test(unit) || /^as (?:a )?(?:percent|percentage|share)\b/iu.test(unit)) {
    percent = true;
    unit = unit.replace(/^(?:as (?:a )?(?:percent(?:age)?|share)|percent|per cent)\s*/iu, '').trim();
  }
  // The last number's own label ("24 price - 6 clay") is no unit of the result.
  if (labelled && unit !== '' && !isUnit(unit) && !labels.has(unit.toLowerCase())) {
    const at = trailing.findIndex((w) => isUnit(w));
    unit = at < 0 ? '' : trailing.slice(at).join(' ');
  }
  if (unit === '' && resultUnit !== '') {
    if (/^(?:%|percent)/iu.test(resultUnit)) {
      percent = true;
      unit = resultUnit.replace(/^(?:%|percent)\s*/iu, '');
    } else unit = resultUnit;
  }
  return { expr, unit, sign, percent };
}

const TIME_UNIT = /^(?:hours?|minutes?|mins?|days?|weeks?|months?|years?)\b/iu;
const isUnit = (unit: string): boolean => STARTS_MONEY.test(unit) || TIME_UNIT.test(unit);

function grouped(digits: string): string {
  const [whole, rest] = digits.split('.');
  const g = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rest === undefined ? g : `${g}.${rest}`;
}

function shownNumber(value: number, written: string): string {
  if (Number.isInteger(value)) return grouped(String(value));
  const places = Math.min(4, Math.max((written.split('.')[1] ?? '').length, 1));
  const text = written === '' ? value.toFixed(2) : value.toFixed(places);
  return grouped(text);
}

const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round((value + Math.sign(value) * 1e-9) * f) / f;
};

/** A number with at most `places` decimals, none when it is whole. */
function decimals(value: number, places: number): string {
  const r = round(value, places);
  return grouped(Number.isInteger(r) ? String(r) : r.toFixed(places).replace(/0+$/, ''));
}

/** A percentage: "26.3", "3.75". */
const share = (value: number): string => decimals(value, Math.abs(value) < 5 ? 2 : 1);

function amount(value: number): string {
  const r = round(value, 2);
  return grouped(Number.isInteger(r) ? String(r) : r.toFixed(2));
}

/** A count that must cover something is the next whole one. */
const COVERS =
  /\b(?:cover\w*|pay(?:s|ing)? (?:\w+ ){0,3}(?:for|off|back)|paid (?:for|off|back)|paid (?:\w+ ){0,2}(?:for|off|back)|break[- ]?even|earn(?:s|ed)? (?:it |that )?back|at least|need|needs|to reach|pays? for itself|make up)\b/iu;

const LOSS =
  /\b(?:los(?:e|es|ing|s|t)|short|minus|negative|below zero|under water|underwater|in the red|behind|deficit|out of pocket|costs? you)\b/iu;

interface Rendered {
  readonly expr: Expr | null;
  readonly text: string;
  readonly value: number;
  readonly kind: ResultKind;
}

const startsMoney = (unit: string): boolean => STARTS_MONEY.test(unit);
const startsDollars = (unit: string): boolean => STARTS_DOLLARS.test(unit);

/** A marker's sum as it is said, or null when it may not be told. `before` and `after`: the sentence around it. */
function renderMarker(
  content: string,
  facts: SumFacts,
  around: { readonly before: string; readonly after: string; readonly spoken: boolean },
): Rendered | null {
  const read = readMarker(content);
  if (read === null) return null;
  const { expr, unit, spoken } = { ...read, spoken: around.spoken };
  const root = inner(expr);
  const next = /^\s*(%|\p{L}+)/u.exec(around.after.replace(/^\*+/u, ''))?.[1]?.toLowerCase() ?? '';
  const signBefore = /[$£€₦₵¥₹₩]\s?$/u.exec(around.before)?.[0].trim() ?? null;
  const nextPercent = unit === '' && /^(?:%|percent)$/u.test(next);
  const percent = read.percent || nextPercent;
  const nextMoney = unit === '' && startsMoney(next);
  if (root.t === 'num') {
    // No sum: a number that was given is said as it is; a result the model worked out is not.
    if (!facts.operand(root.value, root.percent || percent)) return null;
    if (root.percent || percent)
      return {
        expr: null,
        text: `${root.shown}${nextPercent ? '' : '%'}`,
        value: root.value,
        kind: 'percent',
      };
    const sign = signBefore === null ? (read.sign ?? '') : '';
    return {
      expr: null,
      text: unit === '' ? `${sign}${root.shown}` : `${root.shown} ${unit}`,
      value: root.value,
      kind: sign !== '' || signBefore !== null || startsMoney(unit) ? 'money' : 'plain',
    };
  }
  const leaves = leavesOf(expr);
  if (leaves.length > MAX_OPERANDS || !grounded(expr, facts)) return null;
  const dim = dimOf(expr, facts);
  if (dim === undefined) return null;
  const first = /^\p{L}+/u.exec(unit)?.[0]?.toLowerCase() ?? '';
  const counts = isCountWord(first) || TIME_UNIT.test(unit);
  const money =
    !percent &&
    (startsMoney(unit) ||
      nextMoney ||
      (!counts &&
        (read.sign !== null || signBefore !== null || dim === 'money') &&
        !(unit === '' && (isCountWord(next) || TIME_UNIT.test(next)))));
  // A count said as money, money said as a share or as a count, dollars where their money is another.
  if (money && dim === 'count') return null;
  if (percent && dim === 'money') return null;
  if (counts && dim === 'money') return null;
  if (
    facts.otherCurrency &&
    (startsDollars(unit) || (unit === '' && startsDollars(next)) || read.sign === '$')
  )
    return null;
  let value = valueOf(expr);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_RESULT) return null;
  if (percent) {
    const hundred = leaves.some((l) => !l.percent && l.value === 100);
    if (isPercent(expr) || (!hundred && hasDivision(expr))) value *= 100;
    else if (!hundred && (root.op === '*' || root.op === '/')) return null;
  }
  if (value < -EPS && !LOSS.test(`${around.before} ${around.after}`)) return null;
  const time = TIME_UNIT.test(unit === '' ? next : unit);
  const kind: ResultKind = money
    ? 'money'
    : percent
      ? 'percent'
      : time
        ? 'time'
        : counts || (unit === '' && isCountWord(next))
          ? 'count'
          : 'plain';
  const symbol =
    signBefore !== null || nextMoney
      ? ''
      : (read.sign ?? (facts.dollarsOnly && (startsDollars(unit) || dim === 'money') ? '$' : ''));
  return {
    expr,
    text: shownSum(expr, value, kind, {
      unit,
      symbol,
      unitFollows: nextMoney || nextPercent,
      spoken,
      linked: /\bso\b[^.!?]*$/iu.test(around.before),
      covers: COVERS.test(`${around.before} ${unit} ${around.after}`),
      resultOnly: signBefore !== null || /(?:=|\bequals)\s*[$£€]?$/iu.test(around.before),
    }),
    value,
    kind,
  };
}

const hasDivision = (e: Expr): boolean => {
  const x = inner(e);
  return x.t === 'bin' && (x.op === '/' || hasDivision(x.left) || hasDivision(x.right));
};
/** A noun that counts things ("kits", "clubs"). */
const isCountWord = (word: string): boolean =>
  /[^s]s$/u.test(word) &&
  !NO_COUNT.has(word) &&
  !IS_CURRENCY.test(word) &&
  !IS_CENTS.test(word) &&
  !TIME_UNIT.test(word);

const HEARD: Readonly<Record<Op, string>> = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by' };
const WRITTEN: Readonly<Record<Op, string>> = { '+': '+', '-': '-', '*': 'x', '/': '/' };
/** Most numbers of a working that is said aloud. */
const HEARD_OPERANDS = 5;

/** The working as it is shown; null when it is not said aloud. */
function workingOf(e: Expr, spoken: boolean, centsShown: boolean): string | null {
  const x = e;
  if (x.t === 'num') {
    // "0.5" of money is "0.50"; a share that divides or multiplies stays as it was written.
    const n = centsShown && !Number.isInteger(x.value) && !x.percent ? x.value.toFixed(2) : x.shown;
    return `${n}${x.percent ? (spoken ? ' percent' : '%') : ''}`;
  }
  if (x.t === 'paren') {
    const within = workingOf(x.inner, spoken, centsShown);
    return within === null || spoken ? null : inner(x.inner).t === 'num' ? within : `(${within})`;
  }
  const a = workingOf(x.left, spoken, centsShown);
  const b = workingOf(
    x.right,
    spoken,
    centsShown && !((x.op === '/' || x.op === '*') && valueOf(x.right) < 1),
  );
  if (a === null || b === null) return null;
  const op = x.of === true ? 'of' : spoken ? HEARD[x.op] : WRITTEN[x.op];
  return `${a} ${op} ${b}`;
}

/** A mix of "times" and "minus". */
const mixes = (e: Expr): boolean => {
  const ops = new Set<string>();
  const visit = (n: Expr): void => {
    const x = inner(n);
    if (x.t === 'num') return;
    ops.add(x.op === '+' || x.op === '-' ? 'sum' : 'product');
    visit(x.left);
    visit(x.right);
  };
  visit(e);
  return ops.size > 1;
};

/** The working as it can be heard one way only: what stands in brackets, or is taken off as a product, is its result. */
function heard(e: Expr): Expr {
  const done = (x: Expr): Leaf => {
    const v = valueOf(x);
    return { t: 'num', value: v, percent: false, shown: shownNumber(round(v, 2), ''), money: false };
  };
  const x = e;
  if (x.t === 'num') return x;
  if (x.t === 'paren') return inner(x).t === 'num' ? inner(x) : done(x);
  const right = inner(x.right);
  return {
    ...x,
    left: heard(x.left),
    right:
      (x.op === '+' || x.op === '-') && right.t === 'bin' && (right.op === '*' || right.op === '/')
        ? done(x.right)
        : heard(x.right),
  };
}

function shownSum(
  expr: Expr,
  value: number,
  kind: ResultKind,
  how: {
    readonly unit: string;
    /** The sign of their money, when the result shows one. */
    readonly symbol: string;
    /** The unit stands after the marker. */
    readonly unitFollows: boolean;
    readonly spoken: boolean;
    /** "So" was said in the sentence already. */
    readonly linked: boolean;
    readonly covers: boolean;
    readonly resultOnly: boolean;
  },
): string {
  const { spoken } = how;
  const root = inner(expr);
  const asShare =
    kind === 'percent' &&
    root.t === 'bin' &&
    root.op === '/' &&
    inner(root.left).t === 'num' &&
    inner(root.right).t === 'num';
  const full: Expr = asShare ? { ...root, of: true } : expr;
  const shown = spoken ? heard(full) : full;
  const cents = kind === 'money' && leavesOf(shown).some((l) => !l.percent && !Number.isInteger(l.value));
  const working =
    how.resultOnly || (spoken && leavesOf(shown).length > HEARD_OPERANDS)
      ? null
      : // A step of it that is below zero, or no round amount, is not said aloud: only the result.
        spoken && leavesOf(shown).some((l) => l.value < 0 || Math.abs(round(l.value, 2) - l.value) > 1e-9)
        ? null
        : workingOf(shown, spoken, cents);
  const minus = value < 0 ? (spoken ? 'minus ' : '-') : '';
  const abs = Math.abs(value);
  const rest = how.unit === '' ? '' : ` ${how.unit}`;
  let result: string;
  let rounded: string | null = null;
  if (kind === 'money') {
    const word = STARTS_MONEY.exec(how.unit)?.[0] ?? '';
    const tail = how.unit.slice(word.length).trim();
    const dollars = IS_DOLLARS.test(word);
    // "13 dollars a kit", "$2.50 a kit", "40 cedis".
    const inWords = word !== '' && (!dollars || Number.isInteger(round(abs, 2)));
    result =
      inWords || how.symbol === ''
        ? `${minus}${amount(abs)}${how.unitFollows ? '' : rest}`
        : `${minus}${how.symbol}${amount(abs)}${tail === '' ? '' : ` ${tail}`}`;
  } else if (kind === 'percent') {
    result = `${minus}${share(abs)}${how.unitFollows ? '' : spoken ? ' percent' : '%'}${rest}`;
  } else {
    const whole = Number.isInteger(round(abs, 6));
    if (!whole && kind === 'count' && how.covers && abs < 1e6) {
      rounded = `${grouped(String(Math.ceil(abs - 1e-9)))}${rest}`;
      result = decimals(abs, 1);
    } else result = `${whole ? '' : 'about '}${minus}${decimals(abs, 1)}${rest}`;
  }
  if (working === null) return rounded ?? result;
  if (spoken) return `${working}, ${how.linked ? 'that is' : 'so'} ${rounded ?? result}`;
  return `${working} = ${result}${rounded === null ? '' : `, so ${rounded}`}`;
}

// A unit of a reply ---------------------------------------------------------------------------------------------------

const MARKER = /\[\[([^[\]\n]{1,160})\]\]/gu;
/** A sum in single brackets: a marker written short. Never a citation, a link, or a place to fill in. */
const SINGLE =
  /(?<![[\p{L}\d])\[(?!\s*E\d)([^[\]\n]{0,60}\d[^[\]\n]{0,40}\s[-−–+*×x/÷]\s[^[\]\n]{0,60}\d[^[\]\n]{0,60})\](?![\](])/gu;
/** A place to fill in, in double brackets: no digit and no operator. */
const PLACE = /^[^\d+*/=]*$/u;
const FORMULA = /\s[-−–]\s|\b(?:minus|plus|times|divided by)\b|\sx\s/iu;

export interface SumsOptions {
  /** Said on a call. */
  readonly spoken?: boolean;
  /** A line of the server's, or a safety line: its own sums stand. */
  readonly protect?: boolean;
  /** Leaves out the clause around `[start, end)` of a sentence, '' when nothing is left (citation-support). */
  readonly cut?: (text: string, start: number, end: number) => string;
}

export interface SumsUnit {
  /** The unit as it may be shown; '' when nothing of it may. */
  readonly text: string;
  readonly findings: readonly SumFinding[];
}

/** Whether a unit may hold a sum at all (a cheap look before anything else). */
export const mayHoldSum = (unit: string): boolean => /\[\[|\]\]|\d/.test(unit);

/** One unit of a reply with its sums worked out, checked and put right: see the module comment. */
export function sumsUnit(unit: string, facts: SumFacts, options: SumsOptions = {}): SumsUnit {
  const findings = new Set<SumFinding>();
  const drop = (): SumsUnit => ({ text: '', findings: [...findings, 'sum_dropped'] });
  const cutAt = (text: string, start: number, end: number): string =>
    options.cut === undefined ? '' : options.cut(text, start, end);
  let text = unit;
  if (/[[\]]/.test(text)) {
    for (let round_ = 0; round_ < 8; round_ += 1) {
      MARKER.lastIndex = 0;
      SINGLE.lastIndex = 0;
      const m = MARKER.exec(text) ?? singleSum(text);
      if (m === null) break;
      const content = m[1] ?? '';
      const start = m.index;
      let end = start + m[0].length;
      if (PLACE.test(content)) {
        // "[[your price]]" is a place to fill in; "[[price - cost]]" is a sum of nothing.
        if (FORMULA.test(content)) {
          text = cutAt(text, start, end);
          findings.add('sum_dropped');
          if (text.trim() === '') return drop();
          continue;
        }
        text = `${text.slice(0, start)}[${content.trim()}]${text.slice(end)}`;
        continue;
      }
      // "[[a - b]] = c": the result the model wrote goes.
      const tail = /^\s*=\s*[$£€]?\s?\d[\d,]*(?:\.\d+)?/u.exec(text.slice(end));
      if (tail !== null) end += tail[0].length;
      const said = renderMarker(content, facts, {
        before: text.slice(0, start),
        after: text.slice(end),
        spoken: options.spoken === true,
      });
      if (said === null) {
        const cut = cutAt(text, start, end);
        findings.add('sum_dropped');
        if (cut.trim() === '' || cut === text) return drop();
        text = cut;
        continue;
      }
      findings.add('sum_rendered');
      facts.addResult(said.value, said.kind, said.expr);
      let after = text.slice(end);
      // The unit said twice ("[[24 - 6 dollars]] dollars").
      const own = /\p{L}+$/u.exec(said.text)?.[0] ?? '';
      if (own !== '' && new RegExp(`^ ${own}\\b`, 'iu').test(after)) after = after.slice(own.length + 1);
      text = `${text.slice(0, start)}${said.text}${after}`;
    }
    // What is left of a marker that never closed, or never opened.
    if (/\[\[|\]\]/.test(text)) return drop();
  }
  if (options.protect === true || !/\d/.test(text)) return finish(text, unit, findings);
  const plain = plainSums(text, facts, { repair: true, spoken: options.spoken === true, cut: cutAt });
  for (const f of plain.findings) findings.add(f);
  if (plain.text.trim() === '') return drop();
  text = plain.text;
  const built = onWrong(text, facts, cutAt);
  if (built !== text) findings.add('sum_dropped');
  if (built.trim() === '') return drop();
  return finish(built, unit, findings);
}

function finish(text: string, unit: string, findings: ReadonlySet<SumFinding>): SumsUnit {
  const lead = /^\s*/u.exec(unit)?.[0] ?? '';
  return { text: /^\s/u.test(text) || lead === '' ? text : `${lead}${text}`, findings: [...findings] };
}

/** A sum in single brackets, when it reads as one. */
function singleSum(text: string): RegExpExecArray | null {
  SINGLE.lastIndex = 0;
  for (let m = SINGLE.exec(text); m !== null; m = SINGLE.exec(text)) {
    const read = readMarker(m[1] ?? '');
    // A range to fill in ("[5 - 10 people]") is no sum.
    if (read === null) continue;
    const root = inner(read.expr);
    if (root.t === 'num') continue;
    if (root.op === '-' && valueOf(read.expr) <= 0) continue;
    return m;
  }
  return null;
}

/** Every unit of a whole text ({@link sumsUnit}); the spacing between them stays. */
export function sumsText(
  text: string,
  facts: SumFacts,
  options: Omit<SumsOptions, 'protect'> & { readonly protect?: (unit: string) => boolean } = {},
): { readonly text: string; readonly findings: readonly SumFinding[]; readonly edits: number } {
  if (!mayHoldSum(text)) return { text, findings: [], edits: 0 };
  const findings: SumFinding[] = [];
  const kept: string[] = [];
  let edits = 0;
  for (const u of unitsOf(text)) {
    const out = sumsUnit(u.raw, facts, {
      ...(options.spoken === undefined ? {} : { spoken: options.spoken }),
      ...(options.cut === undefined ? {} : { cut: options.cut }),
      protect: options.protect?.(u.raw) === true,
    });
    if (out.text !== u.raw) edits += 1;
    findings.push(...out.findings);
    if (out.text === '') {
      if (/\n\s*\n/.test(u.raw) && kept.length > 0 && !/\n\s*$/.test(kept.at(-1) ?? '')) kept.push('\n\n');
      continue;
    }
    kept.push(out.text);
  }
  if (edits === 0) return { text, findings, edits };
  return {
    text: kept
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    findings,
    edits,
  };
}

// A sum written out ---------------------------------------------------------------------------------------------------

type Lex =
  | (Leaf & { readonly start: number; readonly end: number; readonly sign: string | null })
  | {
      readonly t: 'op';
      readonly op: Op;
      readonly start: number;
      readonly end: number;
      readonly compact: boolean;
      readonly word: string | null;
    }
  | { readonly t: 'lp' | 'rp' | 'eq'; readonly start: number; readonly end: number }
  | { readonly t: 'word'; readonly word: string; readonly start: number; readonly end: number }
  | { readonly t: 'other'; readonly char: string; readonly start: number; readonly end: number };

const LEX =
  /([$£€₦₵¥₹₩]\s?)?(?<![\p{L}\d.])(\d[\d,]*(?:\.\d+)?)(?![\d\p{L}]|\.\d)(\s?(?:%|percent\b|per cent\b))?|([$£€₦₵¥₹₩]\s?)(\d[\d,]*(?:\.\d+)?)(k)\b|(\p{L}[\p{L}'’]*)|(=)|([()])|([-−–+*×/÷@])|([^\s])/gu;

function lex(text: string): Lex[] {
  const out: Lex[] = [];
  for (const m of text.matchAll(LEX)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[2] !== undefined || m[5] !== undefined) {
      const digits = (m[2] ?? m[5] ?? '').replace(/,(?=\d{3})/g, '').replace(/,$/, '');
      const value = Number(digits) * (m[6] === undefined ? 1 : 1000);
      // "1,200," ends a clause: the comma is not the number's.
      const trailing = (m[2] ?? '').endsWith(',') && m[3] === undefined;
      const sign = (m[1] ?? m[4] ?? '').trim();
      out.push({
        t: 'num',
        value,
        percent: m[3] !== undefined,
        shown: digits,
        money: sign !== '',
        sign: sign === '' ? null : sign,
        start,
        end: trailing ? end - 1 : end,
      });
      if (trailing) out.push({ t: 'other', char: ',', start: end - 1, end });
    } else if (m[7] !== undefined) out.push({ t: 'word', word: m[7].toLowerCase(), start, end });
    else if (m[8] !== undefined) out.push({ t: 'eq', start, end });
    else if (m[9] !== undefined) out.push({ t: m[9] === '(' ? 'lp' : 'rp', start, end });
    else if (m[10] !== undefined) {
      const spaced = /\s/.test(text.charAt(start - 1)) && /\s/.test(text.charAt(end));
      const c = m[10];
      const op: Op | null = /[-−–]/.test(c)
        ? '-'
        : c === '+'
          ? '+'
          : /[*×]/.test(c)
            ? '*'
            : /[/÷]/.test(c)
              ? '/'
              : null;
      if (op === null) out.push({ t: 'other', char: c, start, end });
      else out.push({ t: 'op', op, start, end, compact: !spaced, word: null });
    } else out.push({ t: 'other', char: m[11] ?? '', start, end });
  }
  return out;
}

/** Words that stand between a sum and its result; after the weak ones something else may follow. */
const EQUALS: readonly (readonly [readonly string[], boolean])[] = [
  ...(
    'so you are left with, so you would be left with, so you would keep, so you would make, ' +
    "so you would have, so you end up with, so you're left with, so you'd keep, so you'd make, " +
    "so you'd have, so you'd clear, so you keep, so you make, so you clear, so you earn, so that is, " +
    "so that's, which would be, which comes to, which leaves you with, which leaves you, " +
    'which leaves, which gives you, which gives, which makes, that comes to, that leaves you, ' +
    'that leaves, that gives you, that gives, that makes, that would be, leaving you with, ' +
    'leaving you, leaving, leaves you with, leaves you, leaves me, leaves us, leaves, leave you, ' +
    'leave, gives you, gives, give you, gets you, makes, equals, equal, comes out to, comes out at, ' +
    'comes to, works out to, works out at, adds up to, amounts to, totals, is equal to, becomes, ' +
    'and you keep, and you are left with, and you have left, means you keep'
  )
    .split(', ')
    .map((e) => [e.split(' '), false] as const),
  ...(
    "so you have, so you get, so it is, which is, that is, that's, left is, make, is, are, would be, " +
    'means, so, or'
  )
    .split(', ')
    .map((e) => [e.split(' '), true] as const),
].sort((a, b) => b[0].length - a[0].length);

const HEDGE = new Set(
  'about around roughly approximately only just almost nearly exactly a total of left with over under still now'.split(
    ' ',
  ),
);
/** Words a label of a number may not hold: they end it. */
const STOPS = new Set(
  (
    'is are was were leaves leave leaving gives give makes make equals so that which and or then but if to than comes ' +
    'means when because while until before after by you they we i it what how who says said would will can should'
  ).split(' '),
);

const isDollarWord = (w: string | undefined): boolean => w !== undefined && IS_CURRENCY.test(w);
const isCentWord = (w: string | undefined): boolean => w !== undefined && IS_CENTS.test(w);

interface Written {
  readonly expr: Expr;
  /** The result as written. */
  readonly result: Extract<Lex, { t: 'num' }>;
  /** Its place among the tokens. */
  readonly at: number;
  /** A "weak" word stood before the result ("so", "or"): what follows decides whether it is one. */
  readonly weak: boolean;
  readonly sign: boolean;
  readonly hedged: boolean;
  /** The operands' own nouns. */
  readonly nouns: ReadonlySet<string>;
  readonly unspaced: boolean;
  readonly ofShare: boolean;
  readonly wordOps: boolean;
  /** The result stands before the sum. */
  readonly reverse?: boolean;
}

/** Reads a sum written out that starts at token `from`; null when there is none. */
function readWritten(tokens: readonly Lex[], from: number): Written | null {
  const toks: Tok[] = [];
  const nouns = new Set<string>();
  let i = from;
  let depth = 0;
  let unspaced = false;
  let ofShare = false;
  let wordOps = false;
  const word = (k: number): string | null => {
    const x = tokens[k];
    return x?.t === 'word' ? x.word : null;
  };
  /** An operator at `k`: its tokens' count, and itself. */
  const opAt = (k: number): { readonly n: number; readonly op: Tok } | null => {
    const x = tokens[k];
    if (x === undefined) return null;
    // "24 minus 6 for clay, 3 for glaze and 2 for the box".
    if ((x.t === 'other' && x.char === ',') || (x.t === 'word' && x.word === 'and')) {
      const lastOp = toks.findLast((t) => t.t === 'op');
      if (depth > 0 || lastOp?.t !== 'op' || (lastOp.op !== '-' && lastOp.op !== '+')) return null;
      const both = x.t === 'other' && word(k + 1) === 'and';
      return { n: both ? 2 : 1, op: { t: 'op', op: lastOp.op } };
    }
    if (x.t === 'op') {
      if (x.compact) unspaced = true;
      return { n: 1, op: { t: 'op', op: x.op } };
    }
    if (x.t !== 'word') return null;
    const next = word(k + 1);
    const found = ((): { readonly n: number; readonly op: Tok } | null => {
      if (x.word === 'x') return { n: 1, op: { t: 'op', op: '*' } };
      if (x.word === 'minus' || (x.word === 'less' && next !== 'than'))
        return { n: 1, op: { t: 'op', op: '-' } };
      if (x.word === 'plus') return { n: 1, op: { t: 'op', op: '+' } };
      if (x.word === 'times') return { n: 1, op: { t: 'op', op: '*' } };
      if (x.word === 'multiplied' && next === 'by') return { n: 2, op: { t: 'op', op: '*' } };
      if (x.word === 'divided' && next === 'by') return { n: 2, op: { t: 'op', op: '/' } };
      if (x.word === 'out' && next === 'of') return { n: 2, op: { t: 'op', op: '/', of: true } };
      if (x.word === 'of') return { n: 1, op: { t: 'op', op: '/', of: true } };
      if (x.word === 'at') {
        // "30 kits at 13 dollars": a count at a price.
        const after = tokens[k + 1];
        if (after?.t === 'num' && (after.money || isDollarWord(word(k + 2) ?? undefined)))
          return { n: 1, op: { t: 'op', op: '*' } };
      }
      return null;
    })();
    if (found !== null && x.word !== 'x') wordOps = true;
    return found;
  };
  const operand = (): boolean => {
    // "the 6 dollars", "your 24".
    let k = i;
    if (toks.length > 0)
      for (let n = 0; n < 2 && /^(?:the|a|an|your|my|another|those|these|all)$/.test(word(k) ?? ''); n += 1)
        k += 1;
    const x = tokens[k];
    if (x?.t === 'lp') {
      i = k + 1;
      depth += 1;
      toks.push({ t: 'lp' });
      return operand();
    }
    if (x?.t !== 'num' || (k > i && toks.length === 0)) return false;
    let leaf: Leaf = x;
    i = k + 1;
    if (isCentWord(word(i) ?? undefined)) {
      leaf = { ...leaf, value: leaf.value / 100, shown: (leaf.value / 100).toFixed(2), money: true };
      i += 1;
    } else if (isDollarWord(word(i) ?? undefined)) {
      leaf = { ...leaf, money: true };
      i += 1;
    }
    toks.push(leaf);
    return true;
  };
  if (!operand()) return null;
  let ops = 0;
  for (;;) {
    while (tokens[i]?.t === 'rp' && depth > 0) {
      toks.push({ t: 'rp' });
      depth -= 1;
      i += 1;
    }
    // Up to four words of a label, then an operator or the result.
    let k = i;
    let found: { readonly n: number; readonly op: Tok } | null = null;
    const label: string[] = [];
    for (let n = 0; n <= 4; n += 1) {
      const wasUnspaced: boolean = unspaced;
      const wasWord: boolean = wordOps;
      found = opAt(k);
      if (found !== null) {
        // The operator is one only when a number follows.
        const save = { i, depth, len: toks.length };
        i = k + found.n;
        const op = found.op;
        toks.push(
          op.t === 'op' && op.of === true && toks.at(-1)?.t === 'num' && (toks.at(-1) as Leaf).percent
            ? { t: 'op', op: '*' }
            : op,
        );
        if (operand()) {
          if (op.t === 'op' && op.of === true && toks.some((t) => t.t === 'op' && t.of === true))
            ofShare = true;
          for (const w of label) nouns.add(w);
          ops += 1;
          break;
        }
        toks.length = save.len;
        i = save.i;
        depth = save.depth;
        unspaced = wasUnspaced;
        wordOps = wasWord;
        found = null;
      }
      const w = word(k);
      if (w === null || STOPS.has(w)) break;
      label.push(w);
      k += 1;
    }
    if (found === null) {
      for (const w of label) nouns.add(w);
      // The label before the result.
      let e = k;
      if (label.length > 4) return null;
      if (tokens[e]?.t === 'rp' && depth > 0) {
        i = e;
        continue;
      }
      if (ops === 0 || depth !== 0) return null;
      const comma = tokens[e];
      if (comma?.t === 'other' && /^[,;:]$/.test(comma.char)) e += 1;
      let weak = false;
      const sign = tokens[e]?.t === 'eq';
      if (sign) e += 1;
      else {
        // "left per kit is", "is left": the words are tried as they come.
        const eq = EQUALS.find(([words]) => words.every((w, n) => word(e + n) === w));
        if (eq === undefined) return null;
        weak = eq[1];
        e += eq[0].length;
      }
      let hedged = false;
      for (let n = 0; n < 4 && HEDGE.has(word(e) ?? ''); n += 1) {
        if (/^(?:about|around|roughly|approximately|almost|nearly|over|under)$/.test(word(e) ?? ''))
          hedged = true;
        e += 1;
      }
      // "= -$1", "is minus 3".
      let negative = false;
      const neg = tokens[e];
      if ((neg?.t === 'op' && neg.op === '-') || word(e) === 'minus') {
        negative = true;
        e += 1;
      }
      const result = tokens[e];
      if (result?.t !== 'num') return null;
      const expr = parse(toks);
      if (expr === null) return null;
      return {
        expr,
        result: negative ? { ...result, value: -result.value } : result,
        at: e,
        weak,
        sign,
        hedged,
        nouns,
        unspaced,
        ofShare,
        wordOps,
      };
    }
  }
}

/** "13 dollars a lamp (26 - 7 - 4 - 2)": the result before its working; null when there is none. */
function readReverse(tokens: readonly Lex[], from: number): Written | null {
  const result = tokens[from];
  if (result?.t !== 'num' || tokens[from - 1]?.t === 'op') return null;
  let k = from + 1;
  for (let n = 0; n < 4 && tokens[k]?.t === 'word'; n += 1) k += 1;
  if (tokens[k]?.t !== 'lp') return null;
  const close = tokens.findIndex((x, n) => n > k && x.t === 'rp');
  if (close < 0) return null;
  const within = tokens.slice(k + 1, close);
  if (within.some((x) => x.t === 'lp' || x.t === 'eq')) return null;
  const w = readWritten([...within, { t: 'eq', start: result.start, end: result.start }, result], 0);
  if (w?.at !== within.length + 1) return null;
  return { ...w, at: close, reverse: true };
}

const decimalsOf = (shown: string): number => (shown.split('.')[1] ?? '').length;

/** Whether the result written is the one worked out, as it was rounded. */
function agrees(
  value: number,
  stated: number,
  shown: string,
  how: { divides: boolean; hedged: boolean; count: boolean },
): boolean {
  if (Math.abs(value - stated) <= 0.0051) return true;
  if (how.divides || how.hedged) {
    const places = decimalsOf(shown);
    if (Math.abs(round(value, places) - stated) <= EPS + 1e-6) return true;
    if (how.count && Math.abs(Math.ceil(value - 1e-9) - stated) <= EPS) return true;
  }
  return how.hedged && Math.abs(value - stated) <= Math.abs(value) * 0.03;
}

/** Their own sum, said back. */
const QUOTES_THEM = /\byou (?:said|wrote|told me|put|reported|worked out|calculated)\b[^,.;:]*$/iu;

interface PlainOut {
  readonly text: string;
  readonly findings: readonly SumFinding[];
}

/** The sums a text writes out, checked: see the module comment, 5. `repair` false only reads them (their results). */
function plainSums(
  source: string,
  facts: SumFacts,
  options: {
    readonly repair: boolean;
    readonly spoken?: boolean;
    readonly cut?: (text: string, start: number, end: number) => string;
  },
): PlainOut {
  const findings: SumFinding[] = [];
  let text = source;
  for (let round_ = 0; round_ < 6; round_ += 1) {
    const tokens = lex(text);
    let changed = false;
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok?.t !== 'num' && tok?.t !== 'lp') continue;
      const w = readWritten(tokens, i) ?? readReverse(tokens, i);
      if (w === null) continue;
      const root = inner(w.expr);
      if (root.t === 'num' || (options.repair && QUOTES_THEM.test(text.slice(0, tok.start)))) continue;
      const leaves = leavesOf(w.expr);
      const [a, b] = leaves;
      const after = tokens[w.reverse === true ? i + 1 : w.at + 1];
      const unitWord = after?.t === 'word' ? after.word : null;
      const resultMoney =
        w.result.money || isDollarWord(unitWord ?? undefined) || isCentWord(unitWord ?? undefined);
      const cents = isCentWord(unitWord ?? undefined);
      // "5 - 10 people": a range.
      if (
        root.op === '-' &&
        !w.wordOps &&
        a !== undefined &&
        b !== undefined &&
        a.value <= b.value &&
        !w.sign
      )
        continue;
      // "8/10", "12/9": a fraction or a day, unless it is plainly a sum.
      if (w.unspaced && !w.sign && !(root.op === '/' && w.result.percent)) continue;
      if (w.unspaced && root.op === '-' && !w.sign) continue;
      if (w.ofShare && !w.result.percent) continue;
      // After "so", "or", "is" something else may come, and a noun of its own after any verb ("leaves 2 things to do").
      const own_ = closes(after, unitWord, w, resultMoney, leaves);
      if (!w.sign && !own_ && (w.weak || isCountWord(unitWord ?? ''))) continue;
      if (w.hedged && /^(?:of|out)$/.test(unitWord ?? '')) continue;
      let value = valueOf(w.expr);
      if (!Number.isFinite(value) || Math.abs(value) > MAX_RESULT) continue;
      if (
        w.result.percent &&
        !leaves.some((l) => !l.percent && l.value === 100) &&
        (hasDivision(w.expr) || isPercent(w.expr))
      )
        value *= 100;
      if (cents) value *= 100;
      const own = grounded(w.expr, facts);
      const dim = dimOf(w.expr, facts);
      const kind: ResultKind =
        resultMoney || dim === 'money' ? 'money' : w.result.percent ? 'percent' : 'count';
      const fits =
        dim !== undefined && !(resultMoney && dim === 'count') && !(w.result.percent && dim === 'money');
      const loose = (v: number): boolean =>
        agrees(v, w.result.value, w.result.shown, {
          divides: hasDivision(w.expr),
          hedged: w.hedged,
          count: !resultMoney && !w.result.percent,
        });
      if (loose(value)) {
        // A sum of an earlier reply was checked when it was said.
        if ((own || !options.repair) && fits) facts.addResult(cents ? value / 100 : value, kind, w.expr);
        i = w.at - 1;
        continue;
      }
      if (!options.repair) continue;
      // "12 dollars (8 x 2 sizes)": one operator after a number may be about something else.
      if (w.reverse === true && leaves.length < 3) continue;
      // Read left to right, as people say it.
      if (w.wordOps && mixes(w.expr) && !hasParens(w.expr) && loose(leftToRight(w.expr))) {
        i = w.at - 1;
        continue;
      }
      const clear = own && fits && !(w.wordOps && mixes(w.expr) && !hasParens(w.expr));
      if (!facts.given(w.result.value)) facts.wrong.push(Math.abs(w.result.value));
      if (!clear || (value < 0 && !LOSS.test(text))) {
        const cut = options.cut?.(text, w.result.start, w.result.end) ?? '';
        findings.push('sum_dropped');
        return { text: cut === text ? '' : cut, findings };
      }
      const places =
        resultMoney || kind === 'money'
          ? amount(Math.abs(value))
          : w.result.percent
            ? share(Math.abs(value))
            : decimals(Math.abs(value), 1);
      const said = `${value < 0 ? '-' : ''}${w.result.sign ?? ''}${places}${w.result.percent ? (text.slice(w.result.start, w.result.end).includes('%') ? '%' : ' percent') : ''}`;
      const back = w.result.value < 0 && text.charAt(w.result.start - 1) === '-' ? 1 : 0;
      text = `${text.slice(0, w.result.start - back)}${said}${text.slice(w.result.end)}`;
      facts.addResult(cents ? value / 100 : value, kind, w.expr);
      findings.push('sum_repaired');
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return { text, findings };
}

const hasParens = (e: Expr): boolean =>
  e.t === 'paren' || (e.t === 'bin' && (hasParens(e.left) || hasParens(e.right)));

/** A flat expression read left to right. */
function leftToRight(e: Expr): number {
  const ops: Op[] = [];
  const flat: Leaf[] = [];
  const walk = (n: Expr): void => {
    const x = inner(n);
    if (x.t === 'num') {
      flat.push(x);
      return;
    }
    walk(x.left);
    ops.push(x.op);
    walk(x.right);
  };
  walk(e);
  let v = flat[0] === undefined ? 0 : valueOf(flat[0]);
  ops.forEach((op, i) => {
    const b = flat[i + 1];
    if (b === undefined) return;
    const n = valueOf(b);
    v = op === '+' ? v + n : op === '-' ? v - n : op === '*' ? v * n : v / n;
  });
  return v;
}

/** Whether what follows the number after "so", "or", "is" lets it be the sum's result. */
function closes(
  after: Lex | undefined,
  unitWord: string | null,
  w: Written,
  resultMoney: boolean,
  leaves: readonly Leaf[],
): boolean {
  if (w.result.percent) return !/^(?:of|off|more|less|discount|higher|lower)$/.test(unitWord ?? '');
  if (after === undefined) return true;
  if (after.t === 'other') return /^[.,;:!?)"'”’*_]$/u.test(after.char);
  if (after.t === 'rp') return true;
  if (unitWord === null) return false;
  if (resultMoney) return leaves.some((l) => l.money) || leaves.every((l) => !l.percent);
  return (
    /^(?:left|profit|a|an|per|each|in|for|on|altogether|total|over)$/.test(unitWord) || w.nouns.has(unitWord)
  );
}

// What builds on a wrong result ----------------------------------------------------------------------------------------

const ANAPHOR =
  /^\s*(?:[-*+•]\s+)?(?:so |and |then )*(?:that|this|it)(?:['’]s| is| leaves| means| makes| gives| comes to| would be| works out)\b/iu;

/** A number of a sentence that builds on a result that was wrong, or says the sum before it otherwise: its clause goes. */
function onWrong(
  text: string,
  facts: SumFacts,
  cut: (text: string, start: number, end: number) => string,
): string {
  let out = text;
  for (let n = 0; n < 4; n += 1) {
    const tokens = lex(out);
    const bad = tokens.find((x, i) => {
      if (x.t !== 'num' || x.value === 0) return false;
      const next = tokens[i + 1];
      const money = x.money || (next?.t === 'word' && isDollarWord(next.word));
      const known = facts.given(x.value) || facts.results.some((r) => Math.abs(r.value - x.value) < 0.0051);
      if (known) return false;
      if (facts.wrong.some((v) => same(v, x.value))) return true;
      if (facts.wrong.length > 0 && (money || x.value > 12))
        for (const v of facts.wrong)
          for (const k of facts.values)
            if (
              k > 1 &&
              (Math.abs(v * k - x.value) < 0.005 ||
                Math.abs(v - k - x.value) < 0.005 ||
                Math.abs(v * k - x.value) / x.value < 0.001)
            )
              return true;
      // "That is 12 dollars." after a sum that came to 13.
      const last = facts.results.at(-1);
      return (
        money &&
        last?.kind === 'money' &&
        ANAPHOR.test(out) &&
        tokens.filter((t) => t.t === 'num').length === 1 &&
        !facts.values.some(
          (k) => k > 1 && facts.results.some((r) => Math.abs(r.value * k - x.value) < 0.0051),
        ) &&
        ![4, 4.33, 12, 52].some((k) => Math.abs(last.value * k - x.value) < 0.0051) &&
        Math.abs(Math.round(last.value) - x.value) > 0.0051
      );
    });
    if (bad === undefined) return out;
    const next = cut(out, bad.start, bad.end);
    if (next.trim() === '' || next === out) return '';
    out = next;
  }
  return out;
}
