import { type RawRow, type RowCodec } from './columns.js';
import { NoRowsError, SqlUsageError } from './errors.js';
import { SQL_CAST, type SqlParam, type SqlParams } from './params.js';
import { rewritePlaceholders } from './sql-lexer.js';

export { p, isUuid, type SqlParam, type SqlParams, type SqlParamType } from './params.js';
export {
  col,
  row,
  camelRow,
  camelCase,
  camelizeKeys,
  normalizeTimestamp,
  type Column,
  type BaseColumn,
  type RawRow,
  type RowCodec,
  type RowShape,
  type DecodedRow,
  type CamelRow,
  type CamelCase,
} from './columns.js';

export type DbDriver = 'pg' | 'dataapi';

/**
 * Who the statements run as.
 * - `app`: inside {@link Db.withContext}: role `app_rls` with the request's principal/tenant; RLS applies.
 * - `system`: the owner role (migrations, credential checks, ledgers, audit reads, workers). Bypasses RLS.
 */
export type ExecutorPrivilege = 'app' | 'system';

export interface QueryResult {
  /** Raw rows (driver-normalised primitives). Decode with a {@link RowCodec}. */
  readonly rows: readonly RawRow[];
  /** Rows returned (SELECT) or affected (INSERT/UPDATE/DELETE without RETURNING). */
  readonly rowCount: number;
}

/**
 * Executes one SQL statement with NAMED parameters (`:name`). Every placeholder must have a matching
 * entry built with `p.*`; the executor rewrites it to a typed cast for the active driver.
 */
export interface SqlExecutor {
  readonly driver: DbDriver;
  readonly privilege: ExecutorPrivilege;
  query(sql: string, params?: SqlParams): Promise<QueryResult>;
}

/** RLS-scoped executor handed out by `db.withContext`. */
export interface AppExecutor extends SqlExecutor {
  readonly privilege: 'app';
}

/**
 * Owner-privileged executor handed out by `db.system`. Repository functions that touch credential,
 * ledger or audit tables require this type, so an RLS transaction cannot be passed by mistake.
 */
export interface SystemExecutor extends SqlExecutor {
  readonly privilege: 'system';
}

/** A connection (or Data API transaction) that runs single statements. */
export interface SqlConnection {
  query(sql: string, params?: SqlParams): Promise<QueryResult>;
}

/** Per-call options for statements outside a transaction. */
export interface DriverQueryOptions {
  /**
   * Override of the retry budget (RDS Data API: time spent retrying while Aurora resumes). `0` makes a
   * single attempt and throws DatabaseResumingError immediately (health checks).
   */
  readonly retryBudgetMs?: number;
}

/** Driver binding: node-postgres pool or RDS Data API. Used by the {@link Db} facade and the migrator. */
export interface SqlDriver extends SqlConnection {
  readonly driver: DbDriver;
  /** Autocommit statement with per-call options. */
  queryWithOptions(
    sql: string,
    params: SqlParams | undefined,
    options: DriverQueryOptions,
  ): Promise<QueryResult>;
  /** Runs `fn` in one transaction on one connection; commits on success, rolls back on error. */
  transaction<T>(fn: (conn: SqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------------------------------------
// Placeholder compilation (shared by both drivers)
// ------------------------------------------------------------------------------------------------

function lookup(params: SqlParams, name: string): SqlParam {
  const param = Object.hasOwn(params, name) ? params[name] : undefined;
  if (!param) throw new SqlUsageError(`no value supplied for placeholder :${name}`);
  return param;
}

/** `:name` → `CAST($n AS type)`; returns positional parameter list in order. */
export function compilePositional(sql: string, params: SqlParams = {}): { text: string; values: SqlParam[] } {
  const values: SqlParam[] = [];
  const compiled = rewritePlaceholders(sql, (name, index) => {
    const param = lookup(params, name);
    if (index > values.length) values.push(param);
    return `CAST($${index} AS ${SQL_CAST[param.type]})`;
  });
  return { text: compiled.text, values };
}

/** `:name` → `CAST(:name AS type)`; returns the referenced parameters (unused entries are dropped). */
export function compileNamed(
  sql: string,
  params: SqlParams = {},
): { text: string; used: [name: string, param: SqlParam][] } {
  const used: [string, SqlParam][] = [];
  const compiled = rewritePlaceholders(sql, (name, index) => {
    const param = lookup(params, name);
    if (index > used.length) used.push([name, param]);
    return `CAST(:${name} AS ${SQL_CAST[param.type]})`;
  });
  return { text: compiled.text, used };
}

// ------------------------------------------------------------------------------------------------
// Query helpers
// ------------------------------------------------------------------------------------------------

/** All rows decoded with `codec`. */
export async function all<T>(
  ex: SqlConnection,
  sql: string,
  params: SqlParams,
  codec: RowCodec<T>,
): Promise<T[]> {
  const result = await ex.query(sql, params);
  return result.rows.map((r) => codec.decode(r));
}

/** Exactly one row (throws {@link NoRowsError} when none; extra rows are ignored). */
export async function one<T>(
  ex: SqlConnection,
  sql: string,
  params: SqlParams,
  codec: RowCodec<T>,
  what?: string,
): Promise<T> {
  const result = await ex.query(sql, params);
  const first = result.rows[0];
  if (!first) throw new NoRowsError(what);
  return codec.decode(first);
}

/** The first row or `null`. */
export async function maybeOne<T>(
  ex: SqlConnection,
  sql: string,
  params: SqlParams,
  codec: RowCodec<T>,
): Promise<T | null> {
  const result = await ex.query(sql, params);
  const first = result.rows[0];
  return first ? codec.decode(first) : null;
}

/** Executes a statement and returns the affected row count. */
export async function exec(ex: SqlConnection, sql: string, params: SqlParams = {}): Promise<number> {
  const result = await ex.query(sql, params);
  return result.rowCount;
}
