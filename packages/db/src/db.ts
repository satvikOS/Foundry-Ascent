import { createDataApiDriver, type DataApiDriverConfig } from './data-api.js';
import { SqlUsageError } from './errors.js';
import {
  type AppExecutor,
  type DbDriver,
  type SqlConnection,
  type SqlDriver,
  type SystemExecutor,
} from './executor.js';
import { isUuid, p } from './params.js';
import { createPgDriver, type PgDriverConfig } from './pg.js';

/** Identity bound to every application transaction (resolved server-side from the session). */
export interface DbContext {
  readonly principalId: string;
  readonly tenantId: string;
  readonly requestId: string;
}

export interface SystemOptions {
  /** Run `fn` inside one transaction (default true). With `false` every statement autocommits. */
  readonly transaction?: boolean;
}

export interface Db {
  readonly driver: DbDriver;
  /**
   * Runs `fn` in a transaction as role `app_rls` with `app.principal_id`, `app.tenant_id` and
   * `app.request_id` set (all transaction-local). Row level security applies to every statement.
   * This is the only executor request handlers should use for venture/tenant data.
   */
  withContext<T>(ctx: DbContext, fn: (tx: AppExecutor) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` as the OWNER role, bypassing row level security. Reserved for trusted server-side work:
   * credential verification, auth sessions, usage ledger, audit reads/chaining, idempotency keys,
   * migrations/seed and workers processing server-generated jobs. Every call site must be justified in
   * review — never pass browser-supplied identifiers here without an authorization check first.
   */
  system<T>(fn: (sx: SystemExecutor) => Promise<T>, options?: SystemOptions): Promise<T>;
  /**
   * Cheap liveness probe (`SELECT 1`); throws DatabaseResumingError while Aurora resumes. `maxWaitMs`
   * bounds the resume wait (default: the driver's budget, ~45 s; `0` = single attempt, for /health).
   */
  ping(options?: { readonly maxWaitMs?: number }): Promise<void>;
  close(): Promise<void>;
}

/** First statement of every application transaction (one round trip; also verified by the DB tests). */
export const SET_CONTEXT_SQL =
  "SELECT set_config('role', 'app_rls', true) AS role, set_config('app.principal_id', :principalId, true) AS principal, " +
  "set_config('app.tenant_id', :tenantId, true) AS tenant, set_config('app.request_id', :requestId, true) AS request";

function appExecutor(driver: DbDriver, conn: SqlConnection): AppExecutor {
  return { driver, privilege: 'app', query: (sql, params) => conn.query(sql, params) };
}

function systemExecutor(driver: DbDriver, conn: SqlConnection): SystemExecutor {
  return { driver, privilege: 'system', query: (sql, params) => conn.query(sql, params) };
}

/** Builds the facade over an existing driver (tests and the migrate handler use this directly). */
export function createDbFromDriver(driver: SqlDriver): Db {
  return {
    driver: driver.driver,
    async withContext(ctx, fn) {
      if (!isUuid(ctx.principalId) || !isUuid(ctx.tenantId)) {
        throw new SqlUsageError('withContext requires UUID principalId and tenantId');
      }
      const requestId = ctx.requestId.slice(0, 128);
      return driver.transaction(async (conn) => {
        await conn.query(SET_CONTEXT_SQL, {
          principalId: p.text(ctx.principalId.toLowerCase()),
          tenantId: p.text(ctx.tenantId.toLowerCase()),
          requestId: p.text(requestId),
        });
        return fn(appExecutor(driver.driver, conn));
      });
    },
    async system(fn, options) {
      if (options?.transaction === false) return fn(systemExecutor(driver.driver, driver));
      return driver.transaction((conn) => fn(systemExecutor(driver.driver, conn)));
    },
    async ping(options) {
      await driver.queryWithOptions(
        'SELECT 1 AS ok',
        undefined,
        options?.maxWaitMs === undefined ? {} : { retryBudgetMs: options.maxWaitMs },
      );
    },
    close: () => driver.close(),
  };
}

export type DbConfig =
  ({ readonly driver: 'pg' } & PgDriverConfig) | ({ readonly driver: 'dataapi' } & DataApiDriverConfig);

/** Creates the facade for the configured driver. */
export function createDb(config: DbConfig): Db {
  const driver = config.driver === 'pg' ? createPgDriver(config) : createDataApiDriver(config);
  return createDbFromDriver(driver);
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

function required(env: EnvLike, name: string): string {
  const value = env[name];
  if (!value) throw new SqlUsageError(`environment variable ${name} is required`);
  return value;
}

/** Upper bound accepted for DB_RESUME_BUDGET_MS (the migrate custom resource waits longer itself). */
export const MAX_RESUME_BUDGET_MS = 300_000;

function resumeBudgetMs(env: EnvLike): number | undefined {
  const raw = env.DB_RESUME_BUDGET_MS?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_RESUME_BUDGET_MS) {
    throw new SqlUsageError(
      `environment variable DB_RESUME_BUDGET_MS must be an integer in [0, ${MAX_RESUME_BUDGET_MS}]`,
    );
  }
  return value;
}

/**
 * Reads the runtime contract variables: DB_DRIVER=dataapi → DB_CLUSTER_ARN, DB_SECRET_ARN, DB_NAME
 * (default `foundry`) and the optional DB_RESUME_BUDGET_MS (how long one call waits for Aurora to resume
 * from auto-pause before DatabaseResumingError; default `DEFAULT_RETRY_POLICY.budgetMs`, 45 s);
 * DB_DRIVER=pg (default outside production) → DATABASE_URL.
 */
export function dbConfigFromEnv(env: EnvLike = process.env): DbConfig {
  const driver = env.DB_DRIVER ?? (env.APP_ENV === 'production' ? 'dataapi' : 'pg');
  if (driver === 'dataapi') {
    const budgetMs = resumeBudgetMs(env);
    return {
      driver: 'dataapi',
      resourceArn: required(env, 'DB_CLUSTER_ARN'),
      secretArn: required(env, 'DB_SECRET_ARN'),
      database: env.DB_NAME ?? 'foundry',
      ...(budgetMs === undefined ? {} : { retry: { budgetMs } }),
    };
  }
  if (driver === 'pg') return { driver: 'pg', connectionString: required(env, 'DATABASE_URL') };
  throw new SqlUsageError(`unsupported DB_DRIVER ${driver}`);
}

/** `createDb(dbConfigFromEnv(env))`. */
export function createDbFromEnv(env: EnvLike = process.env): Db {
  return createDb(dbConfigFromEnv(env));
}
