import { describe, expect, it } from 'vitest';

import { SqlUsageError } from './errors.js';
import { compileNamed, compilePositional } from './executor.js';
import { encodeTextArrayLiteral, p, paramToText } from './params.js';

describe('p.* parameter builders', () => {
  it('encodes each kind canonically', () => {
    expect(p.uuid('6F1C3A52-9D7E-4B0A-8F2E-3C5D7A9B1E04')).toEqual({
      type: 'uuid',
      value: '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04',
    });
    expect(p.text('héllo')).toEqual({ type: 'text', value: 'héllo' });
    expect(p.int(-5)).toEqual({ type: 'int', value: -5 });
    expect(p.bigint(2n ** 40n)).toEqual({ type: 'bigint', value: 2 ** 40 });
    expect(p.num(0.1)).toEqual({ type: 'num', value: 0.1 });
    expect(p.bool(false)).toEqual({ type: 'bool', value: false });
    expect(p.ts(new Date('2026-10-05T12:00:00Z'))).toEqual({ type: 'ts', value: '2026-10-05T12:00:00.000Z' });
    expect(p.ts('2026-10-05T12:00:00-05:00').value).toBe('2026-10-05T17:00:00.000Z');
    expect(p.json({ a: [1, null, 'x'] }).value).toBe('{"a":[1,null,"x"]}');
    expect(p.json(null).value).toBe('null');
    expect(p.vector([1, 0.25, -3]).value).toBe('[1,0.25,-3]');
    expect(p.textArray([]).value).toBe('{}');
    expect(p.uuidArray(['6F1C3A52-9D7E-4B0A-8F2E-3C5D7A9B1E04']).value).toBe(
      '{6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04}',
    );
  });

  it('escapes text arrays as PostgreSQL array literals', () => {
    expect(encodeTextArrayLiteral(['a', 'b c', 'quote"d', 'back\\slash', '{brace}', 'NULL', ''])).toBe(
      '{"a","b c","quote\\"d","back\\\\slash","{brace}","NULL",""}',
    );
  });

  it('maps null/undefined to SQL NULL in nullable variants', () => {
    expect(p.nullable.uuid(null)).toEqual({ type: 'uuid', value: null });
    expect(p.nullable.text(undefined)).toEqual({ type: 'text', value: null });
    expect(p.nullable.vector(null)).toEqual({ type: 'vector', value: null });
    expect(p.nullable.textArray(['x']).value).toBe('{"x"}');
    expect(paramToText(p.nullable.int(null))).toBeNull();
    expect(paramToText(p.bool(true))).toBe('true');
    expect(paramToText(p.int(3))).toBe('3');
  });

  it('rejects invalid values with SqlUsageError (never echoing the value)', () => {
    const cases: (() => unknown)[] = [
      () => p.uuid('not-a-uuid'),
      () => p.int(1.5),
      () => p.int(2 ** 31),
      () => p.bigint(Number.MAX_SAFE_INTEGER + 2),
      () => p.num(Number.NaN),
      () => p.num(Infinity),
      () => p.ts('not a date'),
      () => p.ts('2026-10-05T12:00:00'),
      () => p.json(undefined),
      () => p.vector([]),
      () => p.vector([1, Number.NaN]),
      () => p.uuidArray(['x']),
    ];
    for (const c of cases) expect(c).toThrow(SqlUsageError);
    try {
      p.uuid('secret-value');
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-value');
    }
  });
});

describe('named → positional/named compilation', () => {
  it('rewrites :name to typed casts and reuses positions for repeated names', () => {
    const { text, values } = compilePositional(
      'SELECT :a, :b::text, :a, \':ignored\', x::int, "col:x" -- :comment\nFROM t WHERE y = :b',
      { a: p.uuid('6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04'), b: p.textArray(['x']), unused: p.int(1) },
    );
    expect(text).toBe(
      'SELECT CAST($1 AS uuid), CAST($2 AS text[])::text, CAST($1 AS uuid), \':ignored\', x::int, "col:x" -- :comment\nFROM t WHERE y = CAST($2 AS text[])',
    );
    expect(values.map((v) => v.type)).toEqual(['uuid', 'textArray']);
  });

  it('keeps names for the Data API and drops unused parameters', () => {
    const { text, used } = compileNamed('SELECT :x, :y, :x', { x: p.int(1), y: p.json([]), z: p.bool(true) });
    expect(text).toBe('SELECT CAST(:x AS integer), CAST(:y AS jsonb), CAST(:x AS integer)');
    expect(used.map(([n]) => n)).toEqual(['x', 'y']);
  });

  it('fails on a placeholder without a value', () => {
    expect(() => compilePositional('SELECT :missing', {})).toThrow(
      /no value supplied for placeholder :missing/,
    );
    expect(() => compileNamed('SELECT :missing')).toThrow(SqlUsageError);
  });

  it('ignores placeholders in strings, identifiers, comments and dollar bodies; leaves casts and := alone', () => {
    const sql = [
      "SELECT 'a :b', E'it\\'s :c', \"d:e\", $$ :f $$, $tag$ :g $tag$, /* :h /* nested :i */ */ x::jsonb",
      'DO $$ DECLARE v int; BEGIN v := 1; END $$',
    ].join('\n');
    expect(compilePositional(sql, {}).text).toBe(sql);
  });
});
