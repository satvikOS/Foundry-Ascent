import { SqlUsageError } from './errors.js';

/**
 * Typed SQL parameters. Every placeholder is rendered by the executors as `CAST(<placeholder> AS <type>)`,
 * so the SQL type is decided here (not inferred by the driver) and both drivers behave identically:
 * node-postgres receives `CAST($1 AS uuid)`, the RDS Data API receives `CAST(:id AS uuid)` plus a type hint.
 */
export type SqlParamType =
  'uuid' | 'text' | 'int' | 'bigint' | 'num' | 'bool' | 'ts' | 'json' | 'vector' | 'textArray' | 'uuidArray';

/** The PostgreSQL type each parameter kind is cast to. */
export const SQL_CAST: Readonly<Record<SqlParamType, string>> = {
  uuid: 'uuid',
  text: 'text',
  int: 'integer',
  bigint: 'bigint',
  num: 'numeric',
  bool: 'boolean',
  ts: 'timestamptz',
  json: 'jsonb',
  vector: 'vector',
  textArray: 'text[]',
  uuidArray: 'uuid[]',
};

/**
 * A bound parameter. `value` is the canonical text encoding (or a number/boolean for numeric/boolean
 * kinds), `null` for SQL NULL. Construct with the `p.*` helpers only.
 */
export interface SqlParam {
  readonly type: SqlParamType;
  readonly value: string | number | boolean | null;
}

export type SqlParams = Readonly<Record<string, SqlParam>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function fail(kind: string, why: string): never {
  throw new SqlUsageError(`invalid ${kind} parameter: ${why}`);
}

function encodeUuid(v: string): string {
  if (!UUID_RE.test(v)) fail('uuid', 'not a UUID');
  return v.toLowerCase();
}

function encodeInt(v: number): number {
  if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) fail('int', 'not a 32-bit integer');
  return v;
}

function encodeBigint(v: number | bigint): number {
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (!Number.isSafeInteger(n)) fail('bigint', 'not a safe integer');
  return n;
}

function encodeNum(v: number): number {
  if (!Number.isFinite(v)) fail('num', 'not a finite number');
  return v;
}

function encodeTs(v: Date | string): string {
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) fail('ts', 'invalid date');
  if (typeof v === 'string' && !/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(v.trim()) && /\d{2}:\d{2}/.test(v)) {
    fail('ts', 'timestamp strings must carry an explicit offset');
  }
  return d.toISOString();
}

function encodeJson(v: unknown): string {
  if (v === undefined) fail('json', 'undefined');
  const text = JSON.stringify(v);
  // JSON.stringify returns undefined for functions/symbols.
  if (typeof text !== 'string') fail('json', 'not JSON-serialisable');
  return text;
}

/** pgvector text literal (`[0.1,0.2,…]`) for a finite, non-empty vector. */
export function encodeVectorLiteral(v: readonly number[]): string {
  if (v.length === 0) fail('vector', 'empty');
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) fail('vector', 'non-finite component');
  return `[${v.join(',')}]`;
}

const encodeVector = encodeVectorLiteral;

/** PostgreSQL array literal for a one-dimensional text array: {"a","b \"c\""}. */
export function encodeTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function encodeTextArray(v: readonly string[]): string {
  for (const s of v) if (typeof s !== 'string') fail('textArray', 'non-string element');
  return encodeTextArrayLiteral(v);
}

function encodeUuidArray(v: readonly string[]): string {
  return `{${v.map(encodeUuid).join(',')}}`;
}

function make<T>(type: SqlParamType, encode: (v: T) => string | number | boolean) {
  return {
    required: (v: T): SqlParam => ({ type, value: encode(v) }),
    nullable: (v: T | null | undefined): SqlParam => ({
      type,
      value: v === null || v === undefined ? null : encode(v),
    }),
  };
}

const uuid = make<string>('uuid', encodeUuid);
const text = make<string>('text', (v) => {
  if (typeof v !== 'string') fail('text', 'not a string');
  return v;
});
const int = make<number>('int', encodeInt);
const bigint = make<number | bigint>('bigint', encodeBigint);
const num = make<number>('num', encodeNum);
const bool = make<boolean>('bool', (v) => {
  if (typeof v !== 'boolean') fail('bool', 'not a boolean');
  return v;
});
const ts = make<Date | string>('ts', encodeTs);
const json = make<unknown>('json', encodeJson);
const vector = make<readonly number[]>('vector', encodeVector);
const textArray = make<readonly string[]>('textArray', encodeTextArray);
const uuidArray = make<readonly string[]>('uuidArray', encodeUuidArray);

/**
 * Parameter builders. SQL references them by name (`:id`), the executor adds the cast:
 *
 * ```ts
 * await tx.query('SELECT … FROM memory_objects WHERE id = :id AND tags && :tags',
 *   { id: p.uuid(id), tags: p.textArray(['a', 'b']) });
 * ```
 *
 * `p.vector` is sent as text (`[0.1,0.2,…]`) and cast to `vector`; `p.textArray`/`p.uuidArray` are sent as
 * PostgreSQL array literals and cast to `text[]`/`uuid[]` (no JSON round trip needed);
 * `p.json` is sent as JSON text and cast to `jsonb`. `p.ts` accepts a Date or an ISO-8601 string with an
 * explicit offset and is cast to `timestamptz`.
 */
export const p = {
  uuid: uuid.required,
  text: text.required,
  int: int.required,
  bigint: bigint.required,
  num: num.required,
  bool: bool.required,
  ts: ts.required,
  json: json.required,
  vector: vector.required,
  textArray: textArray.required,
  uuidArray: uuidArray.required,
  /** Same builders accepting `null`/`undefined` (→ SQL NULL of the declared type). */
  nullable: {
    uuid: uuid.nullable,
    text: text.nullable,
    int: int.nullable,
    bigint: bigint.nullable,
    num: num.nullable,
    bool: bool.nullable,
    ts: ts.nullable,
    json: json.nullable,
    vector: vector.nullable,
    textArray: textArray.nullable,
    uuidArray: uuidArray.nullable,
  },
} as const;

/** Text form sent to node-postgres (which then parses it with the cast type's input function). */
export function paramToText(param: SqlParam): string | null {
  if (param.value === null) return null;
  if (typeof param.value === 'boolean') return param.value ? 'true' : 'false';
  return String(param.value);
}
