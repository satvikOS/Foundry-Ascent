import pg from 'pg';

import { type RawRow } from './columns.js';
import { DbError } from './errors.js';
import { compilePositional, type QueryResult, type SqlConnection, type SqlDriver } from './executor.js';
import { paramToText, type SqlParams } from './params.js';

export interface PgDriverConfig {
  /** postgres:// URL (DATABASE_URL). */
  readonly connectionString: string;
  /** Pool size (default 5). */
  readonly max?: number;
  /** Server-side statement timeout in ms (default 30 000). */
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
  /** Called for errors on idle pooled connections (identifiers only; never log query text). */
  readonly onIdleError?: (err: Error) => void;
}

/**
 * Types returned as PostgreSQL text output so both drivers hand identical primitives to the column
 * decoders: timestamps/dates (no local-time Date objects), json/jsonb (no ambiguity between a JSON string
 * and text), numeric and int8 (exactness decided by the decoder).
 */
const RAW_TEXT_OIDS = new Set<number>([
  20, // int8
  114, // json
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  1266, // timetz
  1700, // numeric
  3802, // jsonb
]);

const identity = (value: string): string => value;

type AnyTypeParser = (id: number, format?: 'text' | 'binary') => unknown;
const builtinTypeParser = pg.types.getTypeParser as AnyTypeParser;

const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((id: number, format?: 'text' | 'binary'): unknown =>
    RAW_TEXT_OIDS.has(id)
      ? identity
      : builtinTypeParser(id, format)) as pg.CustomTypesConfig['getTypeParser'],
};

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

/** Wraps a node-postgres error without copying its message/detail (which can contain row values). */
export function toPgDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as PgErrorLike;
  const code = typeof e.code === 'string' ? e.code : null;
  const sqlState = code && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const constraint = typeof e.constraint === 'string' ? e.constraint : null;
  const label = sqlState ? `SQLSTATE ${sqlState}` : code ? `connection error ${code}` : 'driver error';
  return new DbError(`database error (${label})${constraint ? ` on ${constraint}` : ''}`, {
    sqlState,
    constraint,
    cause: err,
  });
}

async function run(client: pg.Pool | pg.PoolClient, sql: string, params?: SqlParams): Promise<QueryResult> {
  const { text, values } = compilePositional(sql, params);
  let result: pg.QueryResult | pg.QueryResult[];
  try {
    result = (await client.query({ text, values: values.map(paramToText) })) as
      pg.QueryResult | pg.QueryResult[];
  } catch (err) {
    throw toPgDbError(err);
  }
  // A parameterless multi-statement string returns one result per statement; keep the last.
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  const rows = (last?.rows ?? []) as RawRow[];
  return { rows, rowCount: last?.command === 'SELECT' ? rows.length : (last?.rowCount ?? rows.length) };
}

/** node-postgres driver (local development, tests, CI). One pooled client per transaction. */
export function createPgDriver(config: PgDriverConfig): SqlDriver {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 5,
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    application_name: config.applicationName ?? 'foundry-ascent',
    types: typeParsers,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    config.onIdleError?.(err);
  });

  return {
    driver: 'pg',
    query: (sql, params) => run(pool, sql, params),
    queryWithOptions: (sql, params) => run(pool, sql, params),
    async transaction<T>(fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (err) {
        throw toPgDbError(err);
      }
      let broken: Error | undefined;
      try {
        await run(client, 'BEGIN');
        const result = await fn({ query: (sql, params) => run(client, sql, params) });
        await run(client, 'COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          broken = rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
        }
        throw err;
      } finally {
        // Releasing with an error destroys the connection instead of returning it to the pool.
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
