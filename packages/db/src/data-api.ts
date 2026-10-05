import {
  BeginTransactionCommand,
  type BeginTransactionCommandInput,
  type BeginTransactionCommandOutput,
  CommitTransactionCommand,
  type CommitTransactionCommandInput,
  type CommitTransactionCommandOutput,
  ExecuteStatementCommand,
  type ExecuteStatementCommandInput,
  type ExecuteStatementCommandOutput,
  type Field,
  RDSDataClient,
  RollbackTransactionCommand,
  type RollbackTransactionCommandInput,
  type RollbackTransactionCommandOutput,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';

import { type RawRow } from './columns.js';
import { DatabaseResumingError, DbError } from './errors.js';
import { compileNamed, type QueryResult, type SqlConnection, type SqlDriver } from './executor.js';
import { type SqlParam, type SqlParams } from './params.js';

/** The four RDS Data API operations the driver uses (an adapter over RDSDataClient; mockable in tests). */
export interface DataApiClient {
  executeStatement(input: ExecuteStatementCommandInput): Promise<ExecuteStatementCommandOutput>;
  beginTransaction(input: BeginTransactionCommandInput): Promise<BeginTransactionCommandOutput>;
  commitTransaction(input: CommitTransactionCommandInput): Promise<CommitTransactionCommandOutput>;
  rollbackTransaction(input: RollbackTransactionCommandInput): Promise<RollbackTransactionCommandOutput>;
}

export function dataApiClientFromSdk(client: RDSDataClient): DataApiClient {
  return {
    executeStatement: (input) => client.send(new ExecuteStatementCommand(input)),
    beginTransaction: (input) => client.send(new BeginTransactionCommand(input)),
    commitTransaction: (input) => client.send(new CommitTransactionCommand(input)),
    rollbackTransaction: (input) => client.send(new RollbackTransactionCommand(input)),
  };
}

export interface RetryPolicy {
  /** Total time spent retrying one call before giving up (default 45 000 ms). */
  readonly budgetMs: number;
  /** First backoff delay (default 500 ms); doubles each attempt with ±25 % jitter. */
  readonly baseDelayMs: number;
  /** Backoff ceiling (default 8 000 ms). */
  readonly maxDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  budgetMs: 45_000,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
};

export interface DataApiDriverConfig {
  /** Aurora cluster ARN (DB_CLUSTER_ARN). */
  readonly resourceArn: string;
  /** Secrets Manager ARN of the master credentials (DB_SECRET_ARN). */
  readonly secretArn: string;
  /** Database name (DB_NAME). */
  readonly database: string;
  /** Defaults to the region in the cluster ARN. */
  readonly region?: string;
  /** Inject a client (tests, emulator). */
  readonly client?: DataApiClient;
  readonly retry?: Partial<RetryPolicy>;
  /** Observability hook: retry attempts (no SQL text, only the operation and error name). */
  readonly onRetry?: (event: {
    operation: Operation;
    errorName: string;
    attempt: number;
    delayMs: number;
  }) => void;
}

type Operation = 'execute' | 'begin' | 'commit' | 'rollback';
type ErrorClass = 'resuming' | 'unavailable' | 'throttled' | 'ambiguous' | 'fatal';

function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: unknown; code?: unknown };
    if (typeof e.name === 'string') return e.name;
    if (typeof e.code === 'string') return e.code;
  }
  return 'Error';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : '';
}

/** Classifies Data API / transport errors for the retry policy. */
export function classifyDataApiError(err: unknown): ErrorClass {
  const name = errorName(err);
  switch (name) {
    case 'DatabaseResumingException':
      return 'resuming';
    case 'DatabaseUnavailableException':
    case 'ServiceUnavailableError':
      return 'unavailable';
    case 'ThrottlingException':
    case 'TooManyRequestsException':
      return 'throttled';
    case 'InternalServerErrorException':
    case 'TimeoutError':
    case 'RequestTimeout':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'EPIPE':
    case 'NetworkingError':
      return 'ambiguous';
    case 'BadRequestException':
      // Older Aurora Serverless behaviour while resuming.
      return /communications link failure|is resuming/i.test(errorMessage(err)) ? 'resuming' : 'fatal';
    default:
      return 'fatal';
  }
}

function isRetryable(cls: ErrorClass, op: Operation, inTransaction: boolean): boolean {
  if (cls === 'throttled') return true;
  if (op === 'commit') return false; // outcome unknown once the request reached the service
  if (cls === 'resuming') return true; // the request was cancelled before execution
  if (cls === 'unavailable') return !inTransaction || op === 'rollback';
  if (cls === 'ambiguous') return op === 'begin' || op === 'rollback';
  return false;
}

/** Maps a Data API error to a DbError without copying the database message (it can echo row values). */
export function toDataApiDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const name = errorName(err);
  const message = errorMessage(err);
  const sqlState = /SQLState:\s*([0-9A-Z]{5})/i.exec(message)?.[1]?.toUpperCase() ?? null;
  const constraint = /constraint "([^"]+)"/.exec(message)?.[1] ?? null;
  const label = sqlState ? `SQLSTATE ${sqlState}` : name;
  return new DbError(`database error (${label})${constraint ? ` on ${constraint}` : ''}`, {
    sqlState,
    constraint,
    cause: err,
  });
}

function toField(param: SqlParam): Pick<SqlParameter, 'value' | 'typeHint'> {
  const v = param.value;
  if (v === null) return { value: { isNull: true } };
  switch (param.type) {
    case 'int':
    case 'bigint':
      return { value: { longValue: v as number } };
    case 'bool':
      return { value: { booleanValue: v as boolean } };
    case 'num':
      return { value: { stringValue: String(v) }, typeHint: 'DECIMAL' };
    case 'uuid':
      return { value: { stringValue: String(v) }, typeHint: 'UUID' };
    case 'json':
      return { value: { stringValue: String(v) }, typeHint: 'JSON' };
    // Timestamps are sent as ISO-8601 text with an explicit offset and cast to timestamptz in SQL.
    // (The TIMESTAMP type hint would drop the offset and depend on the session time zone.)
    case 'ts':
    case 'text':
    case 'vector':
    case 'textArray':
    case 'uuidArray':
      return { value: { stringValue: String(v) } };
  }
}

/** Builds the Data API parameter list for compiled SQL. */
export function toSqlParameters(used: readonly [string, SqlParam][]): SqlParameter[] {
  return used.map(([name, param]) => ({ name, ...toField(param) }));
}

function fieldToRaw(field: Field): unknown {
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return Buffer.from(field.blobValue).toString('base64');
  if (field.arrayValue !== undefined) {
    const a = field.arrayValue;
    return a.stringValues ?? a.longValues ?? a.doubleValues ?? a.booleanValues ?? null;
  }
  return null;
}

/** Decodes an ExecuteStatement response (JSON records, or typed records + metadata as a fallback). */
export function decodeExecuteResult(out: ExecuteStatementCommandOutput): QueryResult {
  if (typeof out.formattedRecords === 'string') {
    const parsed = JSON.parse(out.formattedRecords) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : []) as RawRow[];
    return { rows, rowCount: rows.length > 0 ? rows.length : (out.numberOfRecordsUpdated ?? 0) };
  }
  if (out.records && out.records.length > 0) {
    const names = (out.columnMetadata ?? []).map((c, i) => c.label ?? c.name ?? `column${i + 1}`);
    const rows = out.records.map((record): RawRow => {
      const r: Record<string, unknown> = {};
      record.forEach((field, i) => {
        r[names[i] ?? `column${i + 1}`] = fieldToRaw(field);
      });
      return r;
    });
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: out.numberOfRecordsUpdated ?? 0 };
}

function regionFromArn(arn: string): string | undefined {
  return /^arn:aws[a-z-]*:rds:([a-z0-9-]+):/.exec(arn)?.[1];
}

/**
 * RDS Data API driver (production). Each statement is one ExecuteStatement call
 * (`formatRecordsAs: JSON`); transactions use Begin/Commit/RollbackTransaction. Calls are retried with
 * exponential backoff while Aurora resumes from auto-pause (DatabaseResumingException) and on transient
 * errors; after the budget a {@link DatabaseResumingError} is thrown (API → 503 `database_resuming`).
 */
export function createDataApiDriver(config: DataApiDriverConfig): SqlDriver {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
  const client =
    config.client ??
    dataApiClientFromSdk(new RDSDataClient({ region: config.region ?? regionFromArn(config.resourceArn) }));
  const base = { resourceArn: config.resourceArn, secretArn: config.secretArn };

  async function withRetry<T>(
    op: Operation,
    inTransaction: boolean,
    call: () => Promise<T>,
    budgetMs: number = policy.budgetMs,
  ): Promise<T> {
    const started = policy.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        const cls = classifyDataApiError(err);
        if (!isRetryable(cls, op, inTransaction)) throw toDataApiDbError(err);
        const waited = policy.now() - started;
        const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
        const delay = Math.round(backoff * (0.75 + policy.random() * 0.5));
        if (waited + delay > budgetMs) {
          if (cls === 'resuming' || cls === 'unavailable') {
            throw new DatabaseResumingError({ waitedMs: waited, cause: err });
          }
          throw toDataApiDbError(err);
        }
        config.onRetry?.({ operation: op, errorName: errorName(err), attempt: attempt + 1, delayMs: delay });
        await policy.sleep(delay);
      }
    }
  }

  async function execute(
    sql: string,
    params: SqlParams | undefined,
    transactionId?: string,
    budgetMs?: number,
  ): Promise<QueryResult> {
    const { text, used } = compileNamed(sql, params);
    const input: ExecuteStatementCommandInput = {
      ...base,
      database: config.database,
      sql: text,
      parameters: used.length > 0 ? toSqlParameters(used) : undefined,
      transactionId,
      formatRecordsAs: 'JSON',
      // Only consulted when the service returns typed records instead of JSON (e.g. some RETURNING forms).
      includeResultMetadata: true,
    };
    const out = await withRetry(
      'execute',
      transactionId !== undefined,
      () => client.executeStatement(input),
      budgetMs,
    );
    return decodeExecuteResult(out);
  }

  return {
    driver: 'dataapi',
    query: (sql, params) => execute(sql, params),
    queryWithOptions: (sql, params, options) => execute(sql, params, undefined, options.retryBudgetMs),
    async transaction<T>(fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      const begun = await withRetry('begin', false, () =>
        client.beginTransaction({ ...base, database: config.database }),
      );
      const transactionId = begun.transactionId;
      if (!transactionId) throw new DbError('database error (BeginTransaction returned no transaction id)');
      let result: T;
      try {
        result = await fn({ query: (sql, params) => execute(sql, params, transactionId) });
      } catch (err) {
        try {
          await withRetry('rollback', true, () => client.rollbackTransaction({ ...base, transactionId }));
        } catch {
          // The transaction times out server-side (3 min) if rollback cannot be delivered.
        }
        throw err;
      }
      await withRetry('commit', true, () => client.commitTransaction({ ...base, transactionId }));
      return result;
    },
    close: () => Promise.resolve(),
  };
}
