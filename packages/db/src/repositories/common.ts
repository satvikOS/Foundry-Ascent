import { type PrincipalView } from '@foundry/contracts';

import { col, type RawRow } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor } from '../executor.js';
import { p, type SqlParam, type SqlParams } from '../params.js';
import { rewritePlaceholders } from '../sql-lexer.js';

/** Maximum excerpt length returned by list/retrieval queries. */
export const EXCERPT_CHARS = 600;

/**
 * SQL expression for an excerpt of at most {@link EXCERPT_CHARS} characters (an ellipsis marks truncation).
 * `expr` must be trusted SQL (a column reference), never user input.
 */
export function excerptSql(expr: string): string {
  return `CASE WHEN length(${expr}) > ${EXCERPT_CHARS} THEN left(${expr}, ${EXCERPT_CHARS - 1}) || '…' ELSE ${expr} END`;
}

/**
 * Selects a principal as prefixed columns (`<prefix>__id`, `<prefix>__display_name`, …) for
 * {@link principalFrom}. `alias` is a trusted table alias.
 */
export function principalSelect(alias: string, prefix: string): string {
  return [
    `${alias}.id AS ${prefix}__id`,
    `${alias}.display_name AS ${prefix}__display_name`,
    `${alias}.title AS ${prefix}__title`,
    `${alias}.synthetic AS ${prefix}__synthetic`,
  ].join(', ');
}

/**
 * Decodes the columns produced by {@link principalSelect}. When the joined principal is missing (NULL id)
 * returns `null`, or a placeholder for `fallbackId` when the reference is known but not visible.
 */
export function principalFrom(raw: RawRow, prefix: string, fallbackId?: string | null): PrincipalView | null {
  const id = raw[`${prefix}__id`];
  if (id === null || id === undefined) {
    return fallbackId
      ? { id: fallbackId, displayName: 'Unknown person', title: null, synthetic: false }
      : null;
  }
  return {
    id: col.uuid.decode(id, `${prefix}__id`),
    displayName: col.text.decode(raw[`${prefix}__display_name`], `${prefix}__display_name`),
    title: col.text.nullable.decode(raw[`${prefix}__title`], `${prefix}__title`),
    synthetic: col.bool.decode(raw[`${prefix}__synthetic`], `${prefix}__synthetic`),
  };
}

/** Like {@link principalFrom} for a NOT NULL reference: always returns a principal. */
export function requiredPrincipalFrom(raw: RawRow, prefix: string, fallbackId: string): PrincipalView {
  return (
    principalFrom(raw, prefix, fallbackId) ?? {
      id: fallbackId,
      displayName: 'Unknown person',
      title: null,
      synthetic: false,
    }
  );
}

/**
 * Builds `col = :param` assignments for a partial update. Column names come from code (never input);
 * entries whose parameter is `undefined` are skipped.
 */
export function setClause(entries: readonly (readonly [column: string, param: SqlParam | undefined])[]): {
  sql: string;
  params: Record<string, SqlParam>;
} {
  const parts: string[] = [];
  const params: Record<string, SqlParam> = {};
  for (const [column, param] of entries) {
    if (param === undefined) continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new SqlUsageError('invalid column name in update');
    parts.push(`${column} = :set_${column}`);
    params[`set_${column}`] = param;
  }
  return { sql: parts.join(', '), params };
}

/** Runs a statement and returns the decoded rows. */
export async function queryRows<T>(
  ex: SqlExecutor,
  sql: string,
  params: SqlParams,
  decode: (raw: RawRow) => T,
): Promise<T[]> {
  const result = await ex.query(sql, params);
  return result.rows.map(decode);
}

/** Runs a statement and returns the first decoded row or `null`. */
export async function queryFirst<T>(
  ex: SqlExecutor,
  sql: string,
  params: SqlParams,
  decode: (raw: RawRow) => T,
): Promise<T | null> {
  const result = await ex.query(sql, params);
  const first = result.rows[0];
  return first ? decode(first) : null;
}

/** Returns the first row or throws (for INSERT … RETURNING that must produce a row). */
export async function queryOne<T>(
  ex: SqlExecutor,
  sql: string,
  params: SqlParams,
  decode: (raw: RawRow) => T,
  what: string,
): Promise<T> {
  const value = await queryFirst(ex, sql, params, decode);
  if (value === null) throw new SqlUsageError(`${what}: statement returned no row`);
  return value;
}

/** Reads a single numeric column (e.g. `count(*) AS n`). */
export async function queryNumber(
  ex: SqlExecutor,
  sql: string,
  params: SqlParams,
  column = 'n',
): Promise<number> {
  const result = await ex.query(sql, params);
  const first = result.rows[0];
  if (!first) return 0;
  return col.num.nullable.decode(first[column], column) ?? 0;
}

/**
 * Lexical query used for retrieval (OR semantics over the stemmed words of the query, phrases kept): the
 * output of `websearch_to_tsquery` with top-level `&` turned into `|`. `param` is the placeholder name.
 */
export function orTsQuerySql(param: string): string {
  return `replace(websearch_to_tsquery('english', :${param})::text, ' & ', ' | ')::tsquery`;
}

/** Strict lexical query (AND semantics) for search boxes. */
export function andTsQuerySql(param: string): string {
  return `websearch_to_tsquery('english', :${param})`;
}

/** Clamps a page size. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

/**
 * Rows of large tables (turns with their response, escalation packets, session recaps) are read in
 * batches of ids, so no single statement's result approaches the RDS Data API's 1 MB response limit
 * however many rows a caller lists. Each batch must stay well below it (see the batch sizes at the call
 * sites, sized for the largest row a table can hold).
 */
export const DATA_API_RESULT_LIMIT_BYTES = 1_000_000;

/**
 * Fetches `ids` in batches of `batchSize` with `fetch` and returns the rows in the order of `ids` (ids
 * without a row, e.g. hidden by RLS, are skipped). `idOf` extracts a row's id.
 */
export async function fetchByIdsInBatches<T>(
  ids: readonly string[],
  batchSize: number,
  fetch: (batch: readonly string[]) => Promise<readonly T[]>,
  idOf: (row: T) => string,
): Promise<T[]> {
  const byId = new Map<string, T>();
  const size = Math.max(1, Math.trunc(batchSize));
  for (let i = 0; i < ids.length; i += size) {
    for (const row of await fetch(ids.slice(i, i + size))) byId.set(idOf(row), row);
  }
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

// ------------------------------------------------------------------------------------------------
// Reads in one statement
// ------------------------------------------------------------------------------------------------

/**
 * One read of {@link readTogether}, or run alone ({@link readPart}): a SELECT, its parameters and how its rows decode.
 */
export interface ReadPart<T> {
  readonly sql: string;
  readonly params: SqlParams;
  readonly decode: (rows: readonly RawRow[]) => T;
}

export type ReadPartValue<P> = P extends ReadPart<infer T> ? T : never;

/** A read whose rows all decode with `decode`. */
export function rowsPart<T>(sql: string, params: SqlParams, decode: (raw: RawRow) => T): ReadPart<T[]> {
  return { sql, params, decode: (rows) => rows.map(decode) };
}

/** A read of its first row (null when there is none). */
export function firstPart<T>(sql: string, params: SqlParams, decode: (raw: RawRow) => T): ReadPart<T | null> {
  return {
    sql,
    params,
    decode: (rows) => {
      const first = rows[0];
      return first ? decode(first) : null;
    },
  };
}

/** A read of a single numeric column (`count(*) AS n`; 0 without a row). */
export function numberPart(sql: string, params: SqlParams, column = 'n'): ReadPart<number> {
  return {
    sql,
    params,
    decode: (rows) => {
      const first = rows[0];
      return first ? (col.num.nullable.decode(first[column], column) ?? 0) : 0;
    },
  };
}

/** Runs one read as its own statement. */
export async function readPart<T>(ex: SqlExecutor, part: ReadPart<T>): Promise<T> {
  const result = await ex.query(part.sql, part.params);
  return part.decode(result.rows);
}

/**
 * An identifier a read is keyed by: a value, or a trusted SQL expression (a scalar subquery built from code, never
 * from input) for a key that another read of the same statement resolves, so reads that depend on each other still
 * take one round trip. Its parameters are merged into the read's.
 */
export type IdRef = string | { readonly sql: string; readonly params: SqlParams };

/** The SQL for `ref` and the parameters it needs (`name` is the placeholder of a value). */
export function idRef(ref: IdRef, name: string): { readonly sql: string; readonly params: SqlParams } {
  if (typeof ref === 'string') return { sql: `:${name}`, params: { [name]: p.uuid(ref) } };
  return ref;
}

/**
 * Several reads in one statement: one round trip on the RDS Data API, where a transaction runs its statements one at
 * a time and each is an HTTPS call. Each part's rows come back as a JSON array that the part's own decoder reads, as
 * when it runs alone (the column decoders accept JSON's forms of timestamps, numerics, arrays and jsonb values); the
 * order of a part's rows is the order its SELECT gives. Rules for a part: a jsonb column that may hold a bare JSON
 * string is selected as text (`value::text`), and the parts together stay well under the Data API's 1 MB response
 * (large rows, such as turns, stay in batches of their own). All parts read one snapshot, as one statement does.
 */
export async function readTogether<P extends Readonly<Record<string, ReadPart<unknown>>>>(
  ex: SqlExecutor,
  parts: P,
): Promise<{ [K in keyof P]: ReadPartValue<P[K]> }> {
  const entries = Object.entries(parts);
  const params: Record<string, SqlParam> = {};
  const columns = entries.map(([, part], i) => {
    const prefix = `r${String(i)}_`;
    const sql = rewritePlaceholders(part.sql, (name) => `:${prefix}${name}`).text;
    for (const [name, param] of Object.entries(part.params)) params[`${prefix}${name}`] = param;
    return `(SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q) AS r${String(i)}`;
  });
  const result = await ex.query(`SELECT ${columns.join(', ')}`, params);
  const row = result.rows[0] ?? {};
  const out: Record<string, unknown> = {};
  entries.forEach(([key, part], i) => {
    const raw = col.json().nullable.decode(row[`r${String(i)}`], `r${String(i)}`);
    const rows = Array.isArray(raw) ? (raw as RawRow[]) : [];
    out[key] = part.decode(rows);
  });
  return out as { [K in keyof P]: ReadPartValue<P[K]> };
}
