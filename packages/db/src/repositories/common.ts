import { type PrincipalView } from '@foundry/contracts';

import { col, type RawRow } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor } from '../executor.js';
import { type SqlParam, type SqlParams } from '../params.js';

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
