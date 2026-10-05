import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  camelCase,
  camelRow,
  camelizeKeys,
  col,
  normalizeTimestamp,
  parseTextArrayLiteral,
  row,
} from './columns.js';
import { DbDecodeError } from './errors.js';

describe('column decoders', () => {
  it('normalises timestamps from both drivers to ISO UTC with milliseconds', () => {
    expect(normalizeTimestamp('2026-10-05 12:00:00.123456+00')).toBe('2026-10-05T12:00:00.123Z');
    expect(normalizeTimestamp('2026-10-05 14:00:00+02')).toBe('2026-10-05T12:00:00.000Z');
    expect(normalizeTimestamp('2026-10-05 07:30:00-04:30')).toBe('2026-10-05T12:00:00.000Z');
    expect(normalizeTimestamp('2026-10-05 12:00:00.5')).toBe('2026-10-05T12:00:00.500Z'); // Data API (UTC, no offset)
    expect(normalizeTimestamp('2026-10-05T12:00:00Z')).toBe('2026-10-05T12:00:00.000Z');
    expect(normalizeTimestamp(new Date('2026-10-05T12:00:00Z'))).toBe('2026-10-05T12:00:00.000Z');
    expect(() => normalizeTimestamp('yesterday')).toThrow(DbDecodeError);
    expect(col.ts.nullable.decode(null, 'x')).toBeNull();
  });

  it('decodes numbers, ints, booleans and text', () => {
    expect(col.int.decode('42', 'n')).toBe(42);
    expect(col.int.decode(42, 'n')).toBe(42);
    expect(() => col.int.decode('9007199254740993', 'n')).toThrow(DbDecodeError);
    expect(col.num.decode('0.50', 'n')).toBe(0.5);
    expect(col.num.decode(1.25, 'n')).toBe(1.25);
    expect(() => col.num.decode('', 'n')).toThrow(DbDecodeError);
    expect(col.bool.decode('t', 'b')).toBe(true);
    expect(col.bool.decode(false, 'b')).toBe(false);
    expect(col.text.decode('x', 't')).toBe('x');
    expect(() => col.text.decode(1, 't')).toThrow(DbDecodeError);
    expect(() => col.text.decode(null, 't')).toThrow(/got NULL/);
    expect(col.date.decode('2026-10-05', 'd')).toBe('2026-10-05');
  });

  it('decodes json from text or already-parsed values and validates with a schema', () => {
    expect(col.json().decode('{"a":1}', 'j')).toEqual({ a: 1 });
    expect(col.json().decode({ a: 1 }, 'j')).toEqual({ a: 1 });
    expect(col.json().decode('true', 'j')).toBe(true);
    const typed = col.json(z.object({ a: z.number() }));
    expect(typed.decode('{"a":2}', 'j')).toEqual({ a: 2 });
    expect(() => typed.decode('{"a":"x"}', 'j')).toThrow(DbDecodeError);
    expect(() => col.json().decode('{not json', 'j')).toThrow(DbDecodeError);
  });

  it('decodes text arrays from JS arrays, JSON and PostgreSQL literals', () => {
    expect(col.textArray.decode(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(col.textArray.decode('["a","b"]', 'a')).toEqual(['a', 'b']);
    expect(col.textArray.decode('{a,"b c","d\\"e"}', 'a')).toEqual(['a', 'b c', 'd"e']);
    expect(col.textArray.decode('{}', 'a')).toEqual([]);
    expect(parseTextArrayLiteral('{a,NULL,"NULL"}')).toEqual(['a', null, 'NULL']);
    expect(() => col.textArray.decode('{a,NULL}', 'a')).toThrow(DbDecodeError);
  });

  it('validates enums', () => {
    const e = col.enum(['a', 'b'] as const);
    expect(e.decode('a', 'e')).toBe('a');
    expect(() => e.decode('c', 'e')).toThrow(/one of a\|b/);
    expect(e.nullable.decode(null, 'e')).toBeNull();
  });
});

describe('row codecs', () => {
  const shape = { venture_id: col.uuid, created_at: col.ts, open_count: col.int, note: col.text.nullable };
  const raw = {
    venture_id: 'v',
    created_at: '2026-10-05 12:00:00+00',
    open_count: '3',
    note: null,
    extra: 1,
  };

  it('decodes snake_case rows and ignores extra columns', () => {
    expect(row(shape).decode(raw)).toEqual({
      venture_id: 'v',
      created_at: '2026-10-05T12:00:00.000Z',
      open_count: 3,
      note: null,
    });
  });

  it('maps to camelCase when opted in', () => {
    expect(camelRow(shape).decode(raw)).toEqual({
      ventureId: 'v',
      createdAt: '2026-10-05T12:00:00.000Z',
      openCount: 3,
      note: null,
    });
    expect(camelCase('a_b_c2_d')).toBe('aBC2D');
    expect(camelizeKeys({ first_name: 1, x: 2 })).toEqual({ firstName: 1, x: 2 });
  });

  it('fails loudly on a missing column (schema drift)', () => {
    const { note: _note, ...missing } = raw;
    expect(() => row(shape).decode(missing)).toThrow(/column missing from result/);
  });
});
