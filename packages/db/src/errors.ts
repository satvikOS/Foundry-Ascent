/**
 * Typed database errors. Messages never contain row values, SQL parameters or driver detail text (which
 * can echo user content such as `Key (title)=(…)`); the original driver error is kept as `cause` and must
 * not be logged verbatim.
 */

/** PostgreSQL SQLSTATE codes the services map to API errors. */
export const SqlState = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  insufficientPrivilege: '42501',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  invalidTextRepresentation: '22P02',
  raiseException: 'P0001',
} as const;

export class DbError extends Error {
  override readonly name: string = 'DbError';
  /** SQLSTATE when known (pg error code or parsed from the Data API message). */
  readonly sqlState: string | null;
  /** Constraint name when the driver reports it (pg only). */
  readonly constraint: string | null;

  constructor(
    message: string,
    opts: { sqlState?: string | null; constraint?: string | null; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.sqlState = opts.sqlState ?? null;
    this.constraint = opts.constraint ?? null;
  }

  /** Unique-key conflict (maps to 409 conflict). */
  get isUniqueViolation(): boolean {
    return this.sqlState === SqlState.uniqueViolation;
  }

  /** Row level security / privilege failure (maps to 403 forbidden or 404 not_found). */
  get isPermissionDenied(): boolean {
    return this.sqlState === SqlState.insufficientPrivilege;
  }

  get isCheckViolation(): boolean {
    return this.sqlState === SqlState.checkViolation;
  }

  get isForeignKeyViolation(): boolean {
    return this.sqlState === SqlState.foreignKeyViolation;
  }
}

/**
 * Aurora Serverless is resuming from auto-pause and did not become available within the retry budget.
 * The API maps this to 503 `database_resuming` with `retryAfterSeconds`.
 */
export class DatabaseResumingError extends DbError {
  override readonly name = 'DatabaseResumingError';
  readonly code = 'database_resuming' as const;
  readonly retryAfterSeconds: number;

  constructor(opts: { waitedMs: number; retryAfterSeconds?: number; cause?: unknown }) {
    super(`database is resuming (waited ${Math.round(opts.waitedMs)} ms)`, { cause: opts.cause });
    this.retryAfterSeconds = opts.retryAfterSeconds ?? 10;
  }
}

/** A column value could not be decoded into the declared type (schema drift or a query bug). */
export class DbDecodeError extends DbError {
  override readonly name = 'DbDecodeError';
  readonly column: string;

  constructor(column: string, expected: string, cause?: unknown) {
    super(`cannot decode column "${column}" as ${expected}`, { cause });
    this.column = column;
  }
}

/** A query expected exactly one row. */
export class NoRowsError extends DbError {
  override readonly name = 'NoRowsError';
  constructor(what = 'row') {
    super(`expected one ${what}, found none`);
  }
}

/** An applied migration no longer matches the bundled SQL. Never auto-repaired. */
export class MigrationChecksumError extends DbError {
  override readonly name = 'MigrationChecksumError';
  readonly version: string;
  constructor(version: string, expected: string, actual: string) {
    super(
      `migration ${version} checksum mismatch (applied ${actual.slice(0, 12)}…, bundled ${expected.slice(0, 12)}…)`,
    );
    this.version = version;
  }
}

/** Programming error in SQL text or parameters (unknown placeholder, invalid value). */
export class SqlUsageError extends DbError {
  override readonly name = 'SqlUsageError';
}

export function isDbError(err: unknown): err is DbError {
  return err instanceof DbError;
}
