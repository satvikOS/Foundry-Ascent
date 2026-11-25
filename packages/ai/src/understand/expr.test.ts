import { describe, expect, it } from 'vitest';

import { evaluate, nameKey, parseExpr, renderExpr, type Expr } from './expr.js';

const names = new Set(['a', 'b', 'c', 'x1']);
const values: Record<string, number> = { a: 38, b: 11, c: 0, x1: 2.5 };
const leaf = (n: Expr & { t: 'num' | 'name' }) => ({
  value: n.t === 'num' ? n.v : (values[n.name] ?? NaN),
  money: null,
});
const valueOf = (text: string): number | string | null => {
  const parsed = parseExpr(text, names);
  if (parsed === null) return null;
  const found = evaluate(parsed.expr, leaf);
  return typeof found === 'string' ? found : found.value;
};
const shown = (text: string): string => {
  const parsed = parseExpr(text, names);
  return parsed === null ? '' : renderExpr(parsed.expr, (n) => (n.t === 'num' ? String(n.v) : n.name));
};

describe('reading a sum', () => {
  it.each([
    ['a * b', 418],
    ['a*(b-1.5)-45', 316],
    ['a - b - 2', 25],
    ['a / 2 / 2', 9.5],
    ['-b + a', 27],
    ['2 * -3', -6],
    ['12% * 50', 6],
    ['(a + 2)%', 0.4],
    ['$1,250 + .50', 1250.5],
    ['3 x 4', 12],
    ['3 × 4 ÷ 2 − 1', 5],
    ['kept = a - b', 27],
    ['A * B', 418],
    ['15k / 5', 3000],
    ['ceil(a / b)', 38 / 11],
    ['((((a))))', 38],
    ['a / c', 'zero'],
    ['a / (b - b)', 'zero'],
  ])('%s', (text, value) => {
    const got = valueOf(text);
    if (typeof value === 'number') expect(got).toBeCloseTo(value, 9);
    else expect(got).toBe(value);
  });

  it.each([
    '',
    'a +',
    '* a',
    'a b',
    'd * 2',
    '(a',
    'a)',
    'a ** 2',
    'a ^ 2',
    'process.exit(1)',
    'a; b',
    'constructor',
    '__proto__',
    'a[0]',
    'Math.max(a, b)',
    'a == b',
    'a ? b : c',
    '1e9',
    '`a`',
    'a'.repeat(300),
    `${'('.repeat(40)}a${')'.repeat(40)}`,
    Array.from({ length: 60 }, () => 'a').join('+'),
  ])('reads nothing else: %s', (text) => {
    expect(parseExpr(text, names)).toBeNull();
  });

  it('marks a count to reach', () => {
    expect(parseExpr('ceil(a / b)', names)?.up).toBe(true);
    expect(parseExpr('a / b', names)?.up).toBe(false);
    // The call wraps a part alone: no function is read.
    expect(parseExpr('ceil(a) + ceil(b)', names)).toBeNull();
  });

  it('names as an expression writes them', () => {
    expect(nameKey(' Food cost ($) ')).toBe('food_cost');
    expect(nameKey('???')).toBe('');
  });
});

describe('units', () => {
  const money = (text: string): number | string | null => {
    const parsed = parseExpr(text, new Set(['price', 'cost', 'n']));
    if (parsed === null) return null;
    const found = evaluate(parsed.expr, (l) => ({
      value: 2,
      money: l.t === 'name' && l.name !== 'n' ? 1 : 0,
    }));
    return typeof found === 'string' ? found : found.money;
  };
  it.each([
    ['price * n - cost', 1],
    ['price / cost', 0],
    ['price * cost', 'units'],
    ['price + n', 'units'],
    ['n - cost', 'units'],
    ['n / price', -1],
    ['price / n * 12', 1],
  ])('%s', (text, dim) => {
    expect(money(text)).toBe(dim);
  });
});

describe('the working', () => {
  it.each([
    ['a*(b-c)-45', 'a × (b − c) − 45'],
    ['a-(b-c)', 'a − (b − c)'],
    ['a-b-c', 'a − b − c'],
    ['a/(b*c)', 'a ÷ (b × c)'],
    ['a*(b/c)', 'a × (b ÷ c)'],
    ['(a+b)+c', 'a + b + c'],
    ['a+(b+c)', 'a + b + c'],
    ['-(a+b)', '−(a + b)'],
    ['12%*a', '12% × a'],
    ['((a))', 'a'],
  ])('%s', (text, said) => {
    expect(shown(text)).toBe(said);
  });

  it('reads back to the same value, whatever the shape', () => {
    // A small seeded generator: the shown working, read again, is worth what the expression was.
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const make = (depth: number): string => {
      if (depth === 0 || next(4) === 0) return ['a', 'b', 'x1', String(1 + next(60))][next(4)] ?? 'a';
      return `(${make(depth - 1)} ${['+', '-', '*', '/'][next(4)] ?? '+'} ${make(depth - 1)})`;
    };
    for (let i = 0; i < 400; i += 1) {
      const text = make(4);
      const once = valueOf(text);
      const again = valueOf(shown(text));
      if (typeof once === 'number') expect(again).toBeCloseTo(once, 6);
      else expect(again).toBe(once);
    }
  });

  it('never throws on noise', () => {
    const chars = 'ab+-*/()%. 01,$x=';
    let seed = 3;
    for (let i = 0; i < 3_000; i += 1) {
      let text = '';
      for (let k = 0; k < 14; k += 1) {
        seed = (seed * 48_271) % 2_147_483_647;
        text += chars[seed % chars.length] ?? '';
      }
      const parsed = parseExpr(text, names);
      if (parsed !== null) evaluate(parsed.expr, leaf);
    }
  });
});
