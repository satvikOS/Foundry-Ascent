import { describe, expect, it } from 'vitest';

import { SET_CONTEXT_SQL, createDbFromDriver, dbConfigFromEnv } from './db.js';
import { SqlUsageError } from './errors.js';
import { type QueryResult, type SqlConnection, type SqlDriver } from './executor.js';
import { type SqlParams } from './params.js';
import { toPgDbError } from './pg.js';

interface Recorded {
  readonly sql: string;
  readonly params: SqlParams | undefined;
  readonly inTransaction: boolean;
}

function fakeDriver(): { driver: SqlDriver; log: Recorded[]; transactions: number } {
  const log: Recorded[] = [];
  const state = { transactions: 0 };
  const exec =
    (inTransaction: boolean) =>
    (sql: string, params?: SqlParams): Promise<QueryResult> => {
      log.push({ sql, params, inTransaction });
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
  const driver: SqlDriver = {
    driver: 'pg',
    query: exec(false),
    queryWithOptions: (sql, params) => exec(false)(sql, params),
    async transaction<T>(fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      state.transactions += 1;
      return fn({ query: exec(true) });
    },
    close: () => Promise.resolve(),
  };
  return {
    driver,
    log,
    get transactions() {
      return state.transactions;
    },
  };
}

const PRINCIPAL = '6F1C3A52-9D7E-4B0A-8F2E-3C5D7A9B1E04';
const TENANT = '7f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04';

describe('Db facade', () => {
  it('starts every withContext transaction with the role + GUC statement', async () => {
    const fake = fakeDriver();
    const db = createDbFromDriver(fake.driver);
    const seen = await db.withContext(
      { principalId: PRINCIPAL, tenantId: TENANT, requestId: 'req-1' },
      async (tx) => {
        expect(tx.privilege).toBe('app');
        await tx.query('SELECT 1');
        return 'done';
      },
    );
    expect(seen).toBe('done');
    expect(fake.transactions).toBe(1);
    expect(fake.log[0]?.sql).toBe(SET_CONTEXT_SQL);
    expect(SET_CONTEXT_SQL).toMatch(/^SELECT set_config\('role', 'app_rls', true\)/);
    expect(fake.log[0]?.params).toEqual({
      principalId: { type: 'text', value: PRINCIPAL.toLowerCase() },
      tenantId: { type: 'text', value: TENANT },
      requestId: { type: 'text', value: 'req-1' },
    });
    expect(fake.log.every((l) => l.inTransaction)).toBe(true);
  });

  it('rejects non-UUID identities before touching the database', async () => {
    const fake = fakeDriver();
    const db = createDbFromDriver(fake.driver);
    await expect(
      db.withContext({ principalId: 'x', tenantId: TENANT, requestId: 'r' }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(SqlUsageError);
    expect(fake.log).toHaveLength(0);
  });

  it('runs system work in a transaction by default, or autocommit when asked', async () => {
    const fake = fakeDriver();
    const db = createDbFromDriver(fake.driver);
    await db.system(async (sx) => {
      expect(sx.privilege).toBe('system');
      await sx.query('SELECT 1');
    });
    await db.system((sx) => sx.query('SELECT 2'), { transaction: false });
    expect(fake.log.map((l) => [l.sql, l.inTransaction])).toEqual([
      ['SELECT 1', true],
      ['SELECT 2', false],
    ]);
    expect(fake.transactions).toBe(1);
  });

  it('chooses the driver from the runtime environment', () => {
    expect(
      dbConfigFromEnv({
        DB_DRIVER: 'dataapi',
        DB_CLUSTER_ARN: 'arn:aws:rds:us-east-1:1:cluster:c',
        DB_SECRET_ARN: 's',
      }),
    ).toMatchObject({
      driver: 'dataapi',
      resourceArn: 'arn:aws:rds:us-east-1:1:cluster:c',
      secretArn: 's',
      database: 'foundry',
    });
    expect(dbConfigFromEnv({ DB_DRIVER: 'pg', DATABASE_URL: 'postgres://x' })).toMatchObject({
      driver: 'pg',
      connectionString: 'postgres://x',
    });
    expect(
      dbConfigFromEnv({ APP_ENV: 'production', DB_CLUSTER_ARN: 'a', DB_SECRET_ARN: 'b', DB_NAME: 'n' }),
    ).toMatchObject({
      driver: 'dataapi',
      database: 'n',
    });
    expect(() => dbConfigFromEnv({ DB_DRIVER: 'pg' })).toThrow(/DATABASE_URL/);
    expect(() => dbConfigFromEnv({ DB_DRIVER: 'mysql' })).toThrow(/unsupported DB_DRIVER/);
  });

  it('reads the per-call resume budget (DB_RESUME_BUDGET_MS) for the Data API driver', () => {
    const base = {
      DB_DRIVER: 'dataapi',
      DB_CLUSTER_ARN: 'arn:aws:rds:us-east-1:1:cluster:c',
      DB_SECRET_ARN: 's',
    };
    expect(dbConfigFromEnv(base)).not.toHaveProperty('retry');
    expect(dbConfigFromEnv({ ...base, DB_RESUME_BUDGET_MS: '' })).not.toHaveProperty('retry');
    expect(dbConfigFromEnv({ ...base, DB_RESUME_BUDGET_MS: '40000' })).toMatchObject({
      retry: { budgetMs: 40_000 },
    });
    expect(dbConfigFromEnv({ ...base, DB_RESUME_BUDGET_MS: '0' })).toMatchObject({ retry: { budgetMs: 0 } });
    for (const bad of ['-1', '1.5', 'forty', '300001']) {
      expect(() => dbConfigFromEnv({ ...base, DB_RESUME_BUDGET_MS: bad })).toThrow(/DB_RESUME_BUDGET_MS/);
    }
  });
});

describe('pg error mapping', () => {
  it('keeps SQLSTATE and constraint but never the message/detail', () => {
    const err = toPgDbError(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'documents_s3_key_key',
        detail: 'Key (s3_key)=(private/path) already exists.',
      }),
    );
    expect(err).toMatchObject({
      sqlState: '23505',
      constraint: 'documents_s3_key_key',
      isUniqueViolation: true,
    });
    expect(err.message).not.toContain('private/path');
    expect(toPgDbError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).message).toContain(
      'ECONNREFUSED',
    );
    expect(toPgDbError(Object.assign(new Error('rls'), { code: '42501' })).isPermissionDenied).toBe(true);
  });
});
