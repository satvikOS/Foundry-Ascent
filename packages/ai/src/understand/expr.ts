/**
 * A sum as the model writes it ("boats * (price - fuel) - mooring"), read by a parser of its own: numbers, input names,
 * + - * / ( ), a trailing %, and `ceil(...)` around the whole. Nothing else is read, and nothing is ever evaluated as code.
 */
export type Expr =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'name'; readonly name: string }
  | { readonly t: 'neg'; readonly a: Expr }
  /** A percentage written as one ("12%"). */
  | { readonly t: 'pct'; readonly a: Expr }
  | { readonly t: 'bin'; readonly op: Operator; readonly a: Expr; readonly b: Expr };
export type Operator = '+' | '-' | '*' | '/';

export interface ParsedExpr {
  readonly expr: Expr;
  /** Written as a whole number to reach (`ceil(...)`). */
  readonly up: boolean;
}

const MAX_CHARS = 240;
const MAX_TOKENS = 64;
const MAX_DEPTH = 16;

/** An input's name as an expression writes it. */
export const nameKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

type Token =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'name'; readonly v: string }
  | { readonly k: 'op'; readonly v: string };

function tokensOf(text: string): Token[] | null {
  const out: Token[] = [];
  let rest = text;
  while (rest !== '') {
    const space = /^\s+/u.exec(rest);
    if (space !== null) {
      rest = rest.slice(space[0].length);
      continue;
    }
    const num = /^\$?((?:\d[\d,]*(?:\.\d+)?|\.\d+))(k\b)?/iu.exec(rest);
    const name = /^[a-z_][a-z0-9_]*/iu.exec(rest);
    const op = /^[-+*/()%]/u.exec(rest);
    if (num !== null) {
      const v = Number((num[1] ?? '').replace(/,/g, '')) * (num[2] === undefined ? 1 : 1e3);
      if (!Number.isFinite(v)) return null;
      out.push({ k: 'num', v });
      rest = rest.slice(num[0].length);
    } else if (name !== null) {
      out.push({ k: 'name', v: name[0] });
      rest = rest.slice(name[0].length);
    } else if (op !== null) {
      out.push({ k: 'op', v: op[0] });
      rest = rest.slice(1);
    } else return null;
    if (out.length > MAX_TOKENS) return null;
  }
  return out;
}

/** Reads an expression over `names`; null when it is anything else. */
export function parseExpr(raw: string, names: ReadonlySet<string>): ParsedExpr | null {
  if (raw.length > MAX_CHARS) return null;
  const text = raw
    .replace(/[×·✕]/gu, '*')
    .replace(/÷/gu, '/')
    .replace(/[−–—]/gu, '-')
    // "kept = a - b": what is worked out is on the right.
    .replace(/^\s*[a-z_][a-z0-9_ ]*=(?!=)/iu, '');
  const wrapped = /^\s*(?:ceil|ceiling|roundup|round_up|math\.ceil)\s*\((.*)\)\s*$/isu.exec(text);
  const body = wrapped?.[1] !== undefined && balanced(wrapped[1]) ? wrapped[1] : text;
  const tokens = tokensOf(body);
  if (tokens === null || tokens.length === 0) return null;
  // "3 x 4": a multiplication sign, unless x is an input.
  const read = tokens.map((t): Token =>
    t.k === 'name' && t.v.toLowerCase() === 'x' && !names.has('x') ? { k: 'op', v: '*' } : t,
  );
  let at = 0;
  const peek = (): string | null => {
    const t = read[at];
    return t?.k === 'op' ? t.v : null;
  };
  const sum = (depth: number): Expr | null => {
    let a = product(depth);
    while (a !== null && (peek() === '+' || peek() === '-')) {
      const op = peek() as Operator;
      at += 1;
      const b = product(depth);
      a = b === null ? null : { t: 'bin', op, a, b };
    }
    return a;
  };
  const product = (depth: number): Expr | null => {
    let a = unary(depth);
    while (a !== null && (peek() === '*' || peek() === '/')) {
      const op = peek() as Operator;
      at += 1;
      const b = unary(depth);
      a = b === null ? null : { t: 'bin', op, a, b };
    }
    return a;
  };
  const unary = (depth: number): Expr | null => {
    if (depth > MAX_DEPTH) return null;
    if (peek() === '-') {
      at += 1;
      const a = unary(depth + 1);
      return a === null ? null : { t: 'neg', a };
    }
    let a = atom(depth);
    if (a !== null && peek() === '%') {
      at += 1;
      a = { t: 'pct', a };
    }
    return a;
  };
  const atom = (depth: number): Expr | null => {
    const t = read[at];
    if (t === undefined) return null;
    at += 1;
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'name') {
      const key = nameKey(t.v);
      return names.has(key) ? { t: 'name', name: key } : null;
    }
    if (t.v !== '(') return null;
    const inner = sum(depth + 1);
    if (inner === null || peek() !== ')') return null;
    at += 1;
    return inner;
  };
  const expr = sum(0);
  if (expr === null || at !== read.length) return null;
  return { expr, up: wrapped !== null && body !== text };
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** The same expression with each leaf as `made` makes it. */
export function mapLeaves(e: Expr, made: (leaf: Expr & { t: 'num' | 'name' }) => Expr): Expr {
  switch (e.t) {
    case 'num':
    case 'name':
      return made(e);
    case 'neg':
    case 'pct':
      return { ...e, a: mapLeaves(e.a, made) };
    case 'bin':
      return { ...e, a: mapLeaves(e.a, made), b: mapLeaves(e.b, made) };
  }
}

/** Every node of an expression. */
export function nodesOf(e: Expr): Expr[] {
  if (e.t === 'num' || e.t === 'name') return [e];
  if (e.t === 'neg' || e.t === 'pct') return [e, ...nodesOf(e.a)];
  return [e, ...nodesOf(e.a), ...nodesOf(e.b)];
}

/** What a leaf is worth: its value and whether it is money (1), a count (0) or not known (null). */
export interface Leaf {
  readonly value: number;
  readonly money: 0 | 1 | null;
}

export type EvalFailure = 'zero' | 'units' | 'range';
export type Evaluated = { readonly value: number; readonly money: number | null } | EvalFailure;

/**
 * The value of an expression and of what it is: money times money, an amount added to a count and a division by zero are no
 * sum of anybody's.
 */
export function evaluate(e: Expr, leafOf: (leaf: Expr & { t: 'num' | 'name' }) => Leaf): Evaluated {
  switch (e.t) {
    case 'num':
    case 'name': {
      const leaf = leafOf(e);
      return { value: leaf.value, money: leaf.money };
    }
    case 'neg':
    case 'pct': {
      const a = evaluate(e.a, leafOf);
      if (typeof a === 'string') return a;
      return e.t === 'neg' ? { ...a, value: -a.value } : { value: a.value / 100, money: 0 };
    }
    case 'bin': {
      const a = evaluate(e.a, leafOf);
      if (typeof a === 'string') return a;
      const b = evaluate(e.b, leafOf);
      if (typeof b === 'string') return b;
      let value: number;
      let money: number | null;
      if (e.op === '+' || e.op === '-') {
        if (a.money !== null && b.money !== null && a.money !== b.money) return 'units';
        money = a.money ?? b.money;
        value = e.op === '+' ? a.value + b.value : a.value - b.value;
      } else if (e.op === '*') {
        value = a.value * b.value;
        money = a.money === null || b.money === null ? null : a.money + b.money;
        if (money !== null && money > 1) return 'units';
      } else {
        if (b.value === 0) return 'zero';
        value = a.value / b.value;
        money = a.money === null || b.money === null ? null : a.money - b.money;
      }
      return Number.isFinite(value) ? { value, money } : 'range';
    }
  }
}

const SIGN: Readonly<Record<Operator, string>> = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const RANK: Readonly<Record<Operator, number>> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** The working as it is shown, each leaf as it is said: "40 × ($9 − $3) − $20". */
export function renderExpr(e: Expr, said: (leaf: Expr & { t: 'num' | 'name' }) => string): string {
  /** "12% ÷ 100" is 12%. */
  const share = (x: Expr): string | null => {
    if (x.t !== 'bin' || x.op !== '/' || x.b.t !== 'num' || x.b.v !== 100) return null;
    const of = x.a.t === 'num' || x.a.t === 'name' ? said(x.a) : '';
    return of.endsWith('%') ? of : null;
  };
  const rank = (x: Expr): number => (x.t !== 'bin' || share(x) !== null ? 3 : RANK[x.op]);
  const draw = (x: Expr): string => {
    switch (x.t) {
      case 'num':
      case 'name':
        return said(x);
      case 'pct':
        return x.a.t === 'num' || x.a.t === 'name' ? `${said(x.a).replace(/%$/u, '')}%` : `(${draw(x.a)})%`;
      case 'neg':
        return rank(x.a) < 3 ? `−(${draw(x.a)})` : `−${draw(x.a)}`;
      case 'bin': {
        const percent = share(x);
        if (percent !== null) return percent;
        const left = rank(x.a) < RANK[x.op] ? `(${draw(x.a)})` : draw(x.a);
        // a − (b + c), a ÷ (b × c): what is on the right keeps its parentheses.
        const bare =
          rank(x.b) > RANK[x.op] ||
          (rank(x.b) === RANK[x.op] && (x.op === '+' || x.op === '*') && x.b.t === 'bin' && x.b.op === x.op);
        return `${left} ${SIGN[x.op]} ${bare ? draw(x.b) : `(${draw(x.b)})`}`;
      }
    }
  };
  return draw(e);
}
