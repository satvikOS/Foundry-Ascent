import { describe, expect, it } from 'vitest';

import { createDbFromDriver } from './db.js';
import { type QueryResult, type SqlConnection, type SqlDriver } from './executor.js';
import { instrumentDriver, type DbCallEvent } from './instrumented.js';

function fakeDriver(options: { failIn?: string } = {}): SqlDriver {
  const exec = (sql: string): Promise<QueryResult> =>
    sql === options.failIn
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ rows: [{ sql }], rowCount: 1 });
  return {
    driver: 'dataapi',
    query: exec,
    queryWithOptions: exec,
    transaction: <T>(fn: (conn: SqlConnection) => Promise<T>): Promise<T> => fn({ query: exec }),
    close: () => Promise.resolve(),
  };
}

const PRINCIPAL = '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04';
const TENANT = '7f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04';

describe('instrumentDriver', () => {
  it('reports one round trip per statement and two per transaction, as the Data API makes them', async () => {
    const events: DbCallEvent[] = [];
    const db = createDbFromDriver(instrumentDriver(fakeDriver(), { onCall: (e) => events.push(e) }));
    await db.withContext({ principalId: PRINCIPAL, tenantId: TENANT, requestId: 'r' }, async (tx) => {
      await tx.query('SELECT 1');
      await tx.query('SELECT 2');
    });
    await db.system((sx) => sx.query('SELECT 3'), { transaction: false });
    await db.ping({ maxWaitMs: 0 });

    // The context statement, two statements and the transaction's begin + commit; then two autocommits.
    expect(events.map((e) => e.kind)).toEqual([
      'statement',
      'statement',
      'statement',
      'transaction',
      'statement',
      'statement',
    ]);
    expect(events.reduce((n, e) => n + e.roundTrips, 0)).toBe(3 + 2 + 2);
    expect(events[3]).toMatchObject({ kind: 'transaction', statements: 3, failed: false });
    expect(events.every((e) => e.ms >= 0)).toBe(true);
  });

  it('passes results and errors through unchanged and marks a failed transaction', async () => {
    const events: DbCallEvent[] = [];
    const driver = instrumentDriver(fakeDriver({ failIn: 'BAD' }), { onCall: (e) => events.push(e) });
    await expect(driver.query('SELECT 1')).resolves.toEqual({ rows: [{ sql: 'SELECT 1' }], rowCount: 1 });
    const failure = driver.transaction(async (conn) => {
      await conn.query('SELECT 1');
      await conn.query('BAD');
    });
    await expect(failure).rejects.toThrow('boom');
    expect(events.at(-1)).toMatchObject({ kind: 'transaction', statements: 2, failed: true });
    expect(events.at(-2)).toMatchObject({ kind: 'statement', failed: true });
  });

  it('waits the simulated network time before every round trip (latency harness)', async () => {
    const waits: string[] = [];
    const driver = instrumentDriver(fakeDriver(), {
      simulatedRoundTripMs: 15,
      sleep: (ms) => {
        waits.push(`wait ${String(ms)}`);
        return Promise.resolve();
      },
    });
    await driver.transaction(async (conn) => {
      waits.push('work');
      await conn.query('SELECT 1');
    });
    await driver.query('SELECT 2');
    // begin, then the statement, then the commit; an autocommit statement is one more round trip.
    expect(waits).toEqual(['wait 15', 'work', 'wait 15', 'wait 15', 'wait 15']);

    const none: string[] = [];
    await instrumentDriver(fakeDriver(), { sleep: () => Promise.resolve(void none.push('wait')) }).query('S');
    expect(none).toEqual([]);
  });
});
