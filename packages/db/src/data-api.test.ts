import {
  BadRequestException,
  DatabaseErrorException,
  DatabaseResumingException,
  InternalServerErrorException,
  type BeginTransactionCommandInput,
  type CommitTransactionCommandInput,
  type ExecuteStatementCommandInput,
  type ExecuteStatementCommandOutput,
  type RollbackTransactionCommandInput,
} from '@aws-sdk/client-rds-data';
import { describe, expect, it, vi } from 'vitest';

import { col, row } from './columns.js';
import {
  classifyDataApiError,
  createDataApiDriver,
  decodeExecuteResult,
  toDataApiDbError,
  type DataApiClient,
  type RetryPolicy,
} from './data-api.js';
import { createDbFromDriver } from './db.js';
import { DatabaseResumingError, DbError } from './errors.js';
import { p } from './params.js';

const META = { $metadata: {} };
const ARN = 'arn:aws:rds:us-east-1:000000000000:cluster:foundry';
const SECRET = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:x';

function resuming(): DatabaseResumingException {
  return new DatabaseResumingException({ message: 'Database is resuming', $metadata: {} });
}

interface Calls {
  execute: ExecuteStatementCommandInput[];
  begin: BeginTransactionCommandInput[];
  commit: CommitTransactionCommandInput[];
  rollback: RollbackTransactionCommandInput[];
}

function mockClient(
  execute: (input: ExecuteStatementCommandInput, n: number) => Promise<ExecuteStatementCommandOutput>,
  opts: { commit?: () => Promise<void> } = {},
): { client: DataApiClient; calls: Calls } {
  const calls: Calls = { execute: [], begin: [], commit: [], rollback: [] };
  const client: DataApiClient = {
    executeStatement: (input) => {
      calls.execute.push(input);
      return execute(input, calls.execute.length);
    },
    beginTransaction: (input) => {
      calls.begin.push(input);
      return Promise.resolve({ ...META, transactionId: 'tx-1' });
    },
    commitTransaction: async (input) => {
      calls.commit.push(input);
      await opts.commit?.();
      return { ...META, transactionStatus: 'Transaction Committed' };
    },
    rollbackTransaction: (input) => {
      calls.rollback.push(input);
      return Promise.resolve({ ...META, transactionStatus: 'Rollback Complete' });
    },
  };
  return { client, calls };
}

/** Deterministic clock + sleep for retry tests. */
function fakeRetry(budgetMs = 45_000): Partial<RetryPolicy> & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    budgetMs,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    random: () => 0.5,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    slept,
  };
}

const json = (rows: unknown[]): ExecuteStatementCommandOutput => ({
  ...META,
  formattedRecords: JSON.stringify(rows),
});

describe('data api driver', () => {
  it('sends named parameters with casts and type hints, JSON formatting and result metadata', async () => {
    const { client, calls } = mockClient(() => Promise.resolve(json([{ id: 'x' }])));
    const driver = createDataApiDriver({ resourceArn: ARN, secretArn: SECRET, database: 'foundry', client });
    await driver.query(`SELECT :id AS id, :n, :i, :b, :j, :ts, :v, :tags, :missing, :id`, {
      id: p.uuid('6F1C3A52-9D7E-4B0A-8F2E-3C5D7A9B1E04'),
      n: p.num(0.25),
      i: p.int(7),
      b: p.bool(true),
      j: p.json({ a: [1, 'two'] }),
      ts: p.ts('2026-10-05T12:00:00+02:00'),
      v: p.vector([0.5, -1, 2e-7]),
      tags: p.textArray(['a', 'b "c"']),
      missing: p.nullable.text(null),
      unused: p.text('dropped'),
    });
    const input = calls.execute[0];
    expect(input).toMatchObject({
      resourceArn: ARN,
      secretArn: SECRET,
      database: 'foundry',
      formatRecordsAs: 'JSON',
      includeResultMetadata: true,
    });
    expect(input?.transactionId).toBeUndefined();
    expect(input?.sql).toBe(
      'SELECT CAST(:id AS uuid) AS id, CAST(:n AS numeric), CAST(:i AS integer), CAST(:b AS boolean), CAST(:j AS jsonb), ' +
        'CAST(:ts AS timestamptz), CAST(:v AS vector), CAST(:tags AS text[]), CAST(:missing AS text), CAST(:id AS uuid)',
    );
    expect(input?.parameters).toEqual([
      { name: 'id', value: { stringValue: '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04' }, typeHint: 'UUID' },
      { name: 'n', value: { stringValue: '0.25' }, typeHint: 'DECIMAL' },
      { name: 'i', value: { longValue: 7 } },
      { name: 'b', value: { booleanValue: true } },
      { name: 'j', value: { stringValue: '{"a":[1,"two"]}' }, typeHint: 'JSON' },
      { name: 'ts', value: { stringValue: '2026-10-05T10:00:00.000Z' } },
      { name: 'v', value: { stringValue: '[0.5,-1,2e-7]' } },
      { name: 'tags', value: { stringValue: '{"a","b \\"c\\""}' } },
      { name: 'missing', value: { isNull: true } },
    ]);
  });

  it('decodes JSON records and typed records (RETURNING) to the same shapes', () => {
    const codec = row({
      id: col.uuid,
      at: col.ts,
      n: col.int,
      amount: col.num,
      ok: col.bool,
      tags: col.textArray,
      meta: col.json(),
      note: col.text.nullable,
    });
    const fromJson = decodeExecuteResult(
      json([
        {
          id: 'a',
          at: '2026-10-05 12:00:00.5',
          n: 3,
          amount: '1.50',
          ok: true,
          tags: ['x', 'y'],
          meta: '{"k":1}',
          note: null,
        },
      ]),
    );
    const fromRecords = decodeExecuteResult({
      ...META,
      columnMetadata: ['id', 'at', 'n', 'amount', 'ok', 'tags', 'meta', 'note'].map((label) => ({ label })),
      records: [
        [
          { stringValue: 'a' },
          { stringValue: '2026-10-05 12:00:00.5' },
          { longValue: 3 },
          { stringValue: '1.50' },
          { booleanValue: true },
          { arrayValue: { stringValues: ['x', 'y'] } },
          { stringValue: '{"k":1}' },
          { isNull: true },
        ],
      ],
    });
    const expected = {
      id: 'a',
      at: '2026-10-05T12:00:00.500Z',
      n: 3,
      amount: 1.5,
      ok: true,
      tags: ['x', 'y'],
      meta: { k: 1 },
      note: null,
    };
    expect(fromJson.rows.map((r) => codec.decode(r))).toEqual([expected]);
    expect(fromRecords.rows.map((r) => codec.decode(r))).toEqual([expected]);
    expect(decodeExecuteResult({ ...META, numberOfRecordsUpdated: 4 })).toEqual({ rows: [], rowCount: 4 });
    expect(decodeExecuteResult({ ...META, formattedRecords: '[]', numberOfRecordsUpdated: 2 })).toEqual({
      rows: [],
      rowCount: 2,
    });
  });

  it('runs transactions with begin/commit and rolls back on error', async () => {
    const { client, calls } = mockClient((input) =>
      input.sql?.includes('boom')
        ? Promise.reject(
            new DatabaseErrorException({ message: 'ERROR: boom; SQLState: 23505', $metadata: {} }),
          )
        : Promise.resolve(json([{ ok: 1 }])),
    );
    const db = createDbFromDriver(
      createDataApiDriver({ resourceArn: ARN, secretArn: SECRET, database: 'foundry', client }),
    );
    const result = await db.withContext(
      {
        principalId: '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04',
        tenantId: '7f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04',
        requestId: 'r-1',
      },
      async (tx) => (await tx.query('SELECT 1 AS ok')).rows,
    );
    expect(result).toEqual([{ ok: 1 }]);
    expect(calls.begin).toHaveLength(1);
    expect(calls.execute.map((c) => c.transactionId)).toEqual(['tx-1', 'tx-1']);
    expect(calls.execute[0]?.sql).toContain("set_config('role', 'app_rls', true)");
    expect(calls.execute[0]?.parameters?.map((x) => x.name)).toEqual([
      'principalId',
      'tenantId',
      'requestId',
    ]);
    expect(calls.commit).toEqual([{ resourceArn: ARN, secretArn: SECRET, transactionId: 'tx-1' }]);

    const failure = db.system(async (sx) => {
      await sx.query('SELECT boom');
    });
    await expect(failure).rejects.toMatchObject({ sqlState: '23505', isUniqueViolation: true });
    expect(calls.rollback).toHaveLength(1);
    expect(calls.commit).toHaveLength(1);
  });

  it('retries while Aurora resumes and succeeds within the budget', async () => {
    const retry = fakeRetry();
    const onRetry = vi.fn();
    const { client, calls } = mockClient((_input, n) =>
      n <= 3 ? Promise.reject(resuming()) : Promise.resolve(json([])),
    );
    const driver = createDataApiDriver({
      resourceArn: ARN,
      secretArn: SECRET,
      database: 'foundry',
      client,
      retry,
      onRetry,
    });
    await expect(driver.query('SELECT 1')).resolves.toEqual({ rows: [], rowCount: 0 });
    expect(calls.execute).toHaveLength(4);
    expect(retry.slept).toEqual([500, 1000, 2000]);
    expect(onRetry).toHaveBeenCalledWith({
      operation: 'execute',
      errorName: 'DatabaseResumingException',
      attempt: 1,
      delayMs: 500,
    });
  });

  it('throws a typed DatabaseResumingError after ~45 s of resuming', async () => {
    const retry = fakeRetry();
    const { client, calls } = mockClient(() => Promise.reject(resuming()));
    const driver = createDataApiDriver({
      resourceArn: ARN,
      secretArn: SECRET,
      database: 'foundry',
      client,
      retry,
    });
    const err: unknown = await driver.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseResumingError);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DatabaseResumingError).code).toBe('database_resuming');
    expect((err as DatabaseResumingError).retryAfterSeconds).toBeGreaterThan(0);
    const total = retry.slept.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(45_000);
    expect(total).toBeGreaterThan(30_000);
    expect(calls.execute.length).toBe(retry.slept.length + 1);
  });

  it('lets health checks probe with a zero wait budget', async () => {
    const retry = fakeRetry();
    const { client, calls } = mockClient(() => Promise.reject(resuming()));
    const db = createDbFromDriver(
      createDataApiDriver({ resourceArn: ARN, secretArn: SECRET, database: 'foundry', client, retry }),
    );
    await expect(db.ping({ maxWaitMs: 0 })).rejects.toBeInstanceOf(DatabaseResumingError);
    expect(calls.execute).toHaveLength(1);
    expect(retry.slept).toEqual([]);
  });

  it('also treats resuming during BeginTransaction as retryable', async () => {
    const retry = fakeRetry();
    let begins = 0;
    const { client, calls } = mockClient(() => Promise.resolve(json([])));
    const flaky: DataApiClient = {
      ...client,
      beginTransaction: (input) => {
        begins += 1;
        return begins < 3 ? Promise.reject(resuming()) : client.beginTransaction(input);
      },
    };
    const db = createDbFromDriver(
      createDataApiDriver({ resourceArn: ARN, secretArn: SECRET, database: 'foundry', client: flaky, retry }),
    );
    await db.system((sx) => sx.query('SELECT 1'));
    expect(begins).toBe(3);
    expect(calls.commit).toHaveLength(1);
  });

  it('never retries an ambiguous commit and does not retry SQL errors', async () => {
    const retry = fakeRetry();
    const { client, calls } = mockClient(() => Promise.resolve(json([])), {
      commit: () => Promise.reject(new InternalServerErrorException({ message: 'x', $metadata: {} })),
    });
    const db = createDbFromDriver(
      createDataApiDriver({ resourceArn: ARN, secretArn: SECRET, database: 'foundry', client, retry }),
    );
    await expect(db.system((sx) => sx.query('SELECT 1'))).rejects.toBeInstanceOf(DbError);
    expect(calls.commit).toHaveLength(1);
    expect(retry.slept).toEqual([]);

    const sqlError = mockClient(() =>
      Promise.reject(
        new BadRequestException({
          message: 'ERROR: relation "x" does not exist; SQLState: 42P01',
          $metadata: {},
        }),
      ),
    );
    const driver = createDataApiDriver({
      resourceArn: ARN,
      secretArn: SECRET,
      database: 'foundry',
      client: sqlError.client,
      retry,
    });
    await expect(driver.query('SELECT * FROM x')).rejects.toMatchObject({ sqlState: '42P01' });
    expect(sqlError.calls.execute).toHaveLength(1);
  });

  it('classifies errors by the SDK exception names', () => {
    expect(classifyDataApiError(resuming())).toBe('resuming');
    expect(
      classifyDataApiError(
        new BadRequestException({ message: 'Communications link failure', $metadata: {} }),
      ),
    ).toBe('resuming');
    expect(classifyDataApiError(new InternalServerErrorException({ message: 'x', $metadata: {} }))).toBe(
      'ambiguous',
    );
    expect(classifyDataApiError(Object.assign(new Error('x'), { name: 'ThrottlingException' }))).toBe(
      'throttled',
    );
    expect(classifyDataApiError(new Error('x'))).toBe('fatal');
  });

  it('maps errors without copying the database message (which can contain row values)', () => {
    const err = toDataApiDbError(
      new DatabaseErrorException({
        message:
          'ERROR: duplicate key value violates unique constraint "documents_s3_key_key" Detail: Key (s3_key)=(secret/path); SQLState: 23505',
        $metadata: {},
      }),
    );
    expect(err.sqlState).toBe('23505');
    expect(err.constraint).toBe('documents_s3_key_key');
    expect(err.message).not.toContain('secret/path');
  });

  it('recovers the venture-name constraint raised by the 0003 trigger (the Data API has no constraint field)', () => {
    const err = toDataApiDbError(
      new DatabaseErrorException({
        message:
          'ERROR: duplicate key value violates unique constraint "ventures_tenant_name_unique"\n  Detail: Another venture of this tenant already uses this name.\n  Where: PL/pgSQL function app.ventures_name_guard() line 9 at RAISE; SQLState: 23505',
        $metadata: {},
      }),
    );
    expect(err.sqlState).toBe('23505');
    expect(err.constraint).toBe('ventures_tenant_name_unique');
  });
});
