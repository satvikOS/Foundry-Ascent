import { type z } from 'zod';

import { DbDecodeError } from './errors.js';

/**
 * Column decoders. Both executors return *raw* rows whose primitive representation differs by driver
 * (node-postgres: numbers, booleans, string arrays, PostgreSQL text output for timestamps/json/numeric;
 * Data API JSON records: numbers, booleans, strings, possibly array literals). The decoders accept every
 * representation and produce one canonical JS shape:
 *
 * | kind        | JS type   | notes                                                            |
 * | ----------- | --------- | ---------------------------------------------------------------- |
 * | uuid, text  | string    |                                                                  |
 * | int         | number    | int2/int4/int8 (int8 must be a safe integer)                    |
 * | num         | number    | numeric/real/double                                              |
 * | bool        | boolean   |                                                                  |
 * | ts          | string    | ISO-8601 UTC with milliseconds (`2026-10-05T12:00:00.000Z`)      |
 * | date        | string    | `YYYY-MM-DD`                                                     |
 * | json        | unknown   | parsed jsonb, optionally validated with a Zod schema             |
 * | textArray   | string[]  |                                                                  |
 *
 * Never select `vector` columns raw; select `embedding IS NOT NULL` instead.
 */
export interface Column<T> {
  readonly kind: string;
  decode(raw: unknown, column: string): T;
}

export interface BaseColumn<T> extends Column<T> {
  /** The same decoder accepting SQL NULL (→ `null`). */
  readonly nullable: Column<T | null>;
}

export type RawRow = Readonly<Record<string, unknown>>;
export type ColumnType<C> = C extends Column<infer T> ? T : never;
export type RowShape = Readonly<Record<string, Column<unknown>>>;

function withNullable<T>(kind: string, decode: (raw: unknown, column: string) => T): BaseColumn<T> {
  const nullable: Column<T | null> = {
    kind: `${kind}?`,
    decode: (raw, column) => (raw === null || raw === undefined ? null : decode(raw, column)),
  };
  return {
    kind,
    decode: (raw, column) => {
      if (raw === null || raw === undefined) throw new DbDecodeError(column, `${kind} (got NULL)`);
      return decode(raw, column);
    },
    nullable,
  };
}

function decodeString(raw: unknown, column: string): string {
  if (typeof raw === 'string') return raw;
  throw new DbDecodeError(column, 'text');
}

function decodeNumber(raw: unknown, column: string): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  throw new DbDecodeError(column, 'number');
}

function decodeInt(raw: unknown, column: string): number {
  const n = decodeNumber(raw, column);
  if (!Number.isSafeInteger(n)) throw new DbDecodeError(column, 'safe integer');
  return n;
}

function decodeBool(raw: unknown, column: string): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 't' || raw === 'true') return true;
  if (raw === 'f' || raw === 'false') return false;
  throw new DbDecodeError(column, 'boolean');
}

const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Normalises timestamps: Date objects, PostgreSQL text output (`2026-10-05 12:00:00.123456+00`), Data API
 * output (`2026-10-05 12:00:00.123456`, UTC without offset) and ISO strings.
 */
export function normalizeTimestamp(raw: unknown, column = 'timestamp'): string {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new DbDecodeError(column, 'timestamp');
    return raw.toISOString();
  }
  if (typeof raw !== 'string') throw new DbDecodeError(column, 'timestamp');
  const m = TS_RE.exec(raw.trim());
  if (!m) throw new DbDecodeError(column, 'timestamp');
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m;
  const ms = (frac + '000').slice(0, 3);
  let offset = zone.toUpperCase();
  if (offset !== 'Z') {
    const sign = offset[0];
    const digits = offset.slice(1).replace(':', '');
    offset = `${sign}${digits.slice(0, 2)}:${(digits.slice(2) || '00').padEnd(2, '0')}`;
  }
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}${offset}`);
  if (Number.isNaN(date.getTime())) throw new DbDecodeError(column, 'timestamp');
  return date.toISOString();
}

function decodeDate(raw: unknown, column: string): string {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  throw new DbDecodeError(column, 'date');
}

function decodeJson(raw: unknown, column: string): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new DbDecodeError(column, 'json', err);
    }
  }
  return raw;
}

/** Parses a one-dimensional PostgreSQL array literal of text-like values: {a,"b c",NULL}. */
export function parseTextArrayLiteral(literal: string): (string | null)[] {
  const s = literal.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) throw new Error('not an array literal');
  const body = s.slice(1, -1);
  const out: (string | null)[] = [];
  if (body.length === 0) return out;
  let i = 0;
  while (i <= body.length) {
    if (body[i] === '"') {
      let value = '';
      i += 1;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i += 1;
        value += body[i] ?? '';
        i += 1;
      }
      i += 1; // closing quote
      out.push(value);
    } else {
      let j = body.indexOf(',', i);
      if (j === -1) j = body.length;
      const token = body.slice(i, j).trim();
      out.push(token.toUpperCase() === 'NULL' ? null : token);
      i = j;
    }
    if (body[i] === ',') i += 1;
    else break;
  }
  return out;
}

function decodeTextArray(raw: unknown, column: string): string[] {
  let values: unknown[];
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'string') {
    try {
      values = raw.trim().startsWith('[') ? (JSON.parse(raw) as unknown[]) : parseTextArrayLiteral(raw);
    } catch (err) {
      throw new DbDecodeError(column, 'text[]', err);
    }
  } else throw new DbDecodeError(column, 'text[]');
  return values.map((v) => {
    if (typeof v !== 'string') throw new DbDecodeError(column, 'text[] element');
    return v;
  });
}

function jsonColumn<T>(schema?: z.ZodType<T>): BaseColumn<T> {
  return withNullable<T>('json', (raw, column) => {
    const value = decodeJson(raw, column);
    if (!schema) return value as T;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DbDecodeError(column, 'json matching schema', parsed.error);
    return parsed.data;
  });
}

/** Column decoders; `col.ts.nullable` etc. accept NULL. */
export const col = {
  uuid: withNullable('uuid', decodeString),
  text: withNullable('text', decodeString),
  int: withNullable('int', decodeInt),
  num: withNullable('num', decodeNumber),
  bool: withNullable('bool', decodeBool),
  ts: withNullable('ts', (raw, column) => normalizeTimestamp(raw, column)),
  date: withNullable('date', decodeDate),
  textArray: withNullable('textArray', decodeTextArray),
  /** Parsed jsonb. Without a schema the value is returned as `T` unchecked (default `unknown`). */
  json: <T = unknown>(schema?: z.ZodType<T>): BaseColumn<T> => jsonColumn(schema),
  /** String enum validated against a fixed set of values. */
  enum: <const V extends string>(values: readonly V[]): BaseColumn<V> =>
    withNullable<V>('enum', (raw, column) => {
      if (typeof raw === 'string' && (values as readonly string[]).includes(raw)) return raw as V;
      throw new DbDecodeError(column, `one of ${values.join('|')}`);
    }),
} as const;

// ------------------------------------------------------------------------------------------------
// Row decoding
// ------------------------------------------------------------------------------------------------

/** `venture_id` → `ventureId` at the type level. */
export type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

export type DecodedRow<S extends RowShape> = { -readonly [K in keyof S]: ColumnType<S[K]> };
export type CamelRow<S extends RowShape> = {
  -readonly [K in keyof S as CamelCase<K & string>]: ColumnType<S[K]>;
};

export function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export interface RowCodec<T> {
  decode(raw: RawRow): T;
}

/**
 * Declares a row shape keyed by the SQL column names (snake_case). Columns are decoded with their
 * declared decoders; extra columns are ignored; a missing column is a decode error.
 */
export function row<S extends RowShape>(shape: S): RowCodec<DecodedRow<S>> {
  const entries = Object.entries(shape);
  return {
    decode(raw) {
      const out: Record<string, unknown> = {};
      for (const [name, column] of entries) {
        if (!(name in raw)) throw new DbDecodeError(name, `${column.kind} (column missing from result)`);
        out[name] = column.decode(raw[name], name);
      }
      return out as DecodedRow<S>;
    },
  };
}

/** Like {@link row} but returns camelCase keys (`created_at` → `createdAt`). Opt-in. */
export function camelRow<S extends RowShape>(shape: S): RowCodec<CamelRow<S>> {
  const entries = Object.entries(shape).map(([name, column]) => [name, camelCase(name), column] as const);
  return {
    decode(raw) {
      const out: Record<string, unknown> = {};
      for (const [name, key, column] of entries) {
        if (!(name in raw)) throw new DbDecodeError(name, `${column.kind} (column missing from result)`);
        out[key] = column.decode(raw[name], name);
      }
      return out as CamelRow<S>;
    },
  };
}

/** Converts every key of a raw row to camelCase without decoding values (use typed codecs where possible). */
export function camelizeKeys(raw: RawRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[camelCase(k)] = v;
  return out;
}
