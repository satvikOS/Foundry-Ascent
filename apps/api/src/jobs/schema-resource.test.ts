import { DatabaseResumingError, type Db, DbError, type SeedConfig } from '@foundry/db';
import type { CdkCustomResourceEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging.js';
import {
  handleSchemaEvent,
  IAM_PROPAGATION_RETRY_MS,
  isIamPropagationError,
  MAX_WAKE_BUDGET_MS,
  MIGRATE_RESERVE_MS,
  RESPONSE_MARGIN_MS,
  SCHEMA_PHYSICAL_RESOURCE_ID,
  wakeBudgetMs,
} from './schema-resource.js';

const seedConfig: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry' }, owner: null };

function pausedDb(waits: number[]): Db {
  const unused = (): Promise<never> => Promise.reject(new Error('not reached'));
  return {
    driver: 'dataapi',
    withContext: unused,
    system: unused,
    ping: (options) => {
      waits.push(options?.maxWaitMs ?? -1);
      return Promise.reject(new DatabaseResumingError({ waitedMs: options?.maxWaitMs ?? 0 }));
    },
    close: () => Promise.resolve(),
  };
}

const event = (requestType: 'Create' | 'Update' | 'Delete'): CdkCustomResourceEvent =>
  ({
    RequestType: requestType,
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider',
    ResponseURL: 'https://example.invalid/response',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/FoundryAscent-App/1',
    RequestId: 'req-1',
    LogicalResourceId: 'Migrations',
    ResourceType: 'Custom::FoundryMigrations',
    PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
    ResourceProperties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider' },
    OldResourceProperties: {},
  }) as CdkCustomResourceEvent;

describe('migrations custom resource: Aurora resume', () => {
  it('waits up to 5 minutes but always keeps 4 minutes of the 10-minute Lambda for the work', () => {
    expect(wakeBudgetMs(10 * 60_000)).toBe(MAX_WAKE_BUDGET_MS);
    expect(wakeBudgetMs(7 * 60_000)).toBe(3 * 60_000);
    expect(wakeBudgetMs(MIGRATE_RESERVE_MS + 45_000)).toBe(45_000);
    expect(wakeBudgetMs(60_000)).toBe(30_000);
    expect(MAX_WAKE_BUDGET_MS + MIGRATE_RESERVE_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('fails the deployment (before changing anything) when Aurora does not resume within the budget', async () => {
    const waits: number[] = [];
    await expect(
      handleSchemaEvent(
        { db: pausedDb(waits), seedConfig, backfill: null, logger: silentLogger },
        event('Update'),
        { requestId: 'r', remainingMs: () => 9 * 60_000 },
      ),
    ).rejects.toBeInstanceOf(DatabaseResumingError);
    expect(waits).toEqual([5 * 60_000]);
  });

  it('Delete is a no-op that never touches the database and keeps the physical id', async () => {
    const waits: number[] = [];
    await expect(
      handleSchemaEvent(
        { db: pausedDb(waits), seedConfig, backfill: null, logger: silentLogger },
        event('Delete'),
        { requestId: 'r', remainingMs: () => 9 * 60_000 },
      ),
    ).resolves.toEqual({ PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID });
    expect(waits).toEqual([]);
  });
});

/** A database whose ping fails with `errors` in order, then with a sentinel that ends the test run. */
function refusingDb(errors: readonly Error[], pings: { n: number }): Db {
  const unused = (): Promise<never> => Promise.reject(new Error('not reached'));
  return {
    driver: 'dataapi',
    withContext: unused,
    system: unused,
    ping: () => {
      const err = errors[pings.n] ?? new Error('awake (test sentinel)');
      pings.n += 1;
      return Promise.reject(err);
    },
    close: () => Promise.resolve(),
  };
}

const awsError = (name: string): Error => Object.assign(new Error(name), { name });

describe('migrations custom resource: IAM propagation right after the role changed (R4)', () => {
  const run = (errors: readonly Error[]) => {
    const pings = { n: 0 };
    const sleeps: number[] = [];
    let clock = 0;
    const promise = handleSchemaEvent(
      {
        db: refusingDb(errors, pings),
        seedConfig,
        backfill: null,
        logger: silentLogger,
        now: () => clock,
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      },
      event('Update'),
      { requestId: 'r', remainingMs: () => 9 * 60_000 },
    );
    return { promise, pings, sleeps };
  };

  it('retries AccessDeniedException / ForbiddenException during the wake-up, then carries on', async () => {
    const { promise, pings, sleeps } = run([
      awsError('AccessDeniedException'),
      new DbError('database error', { cause: awsError('ForbiddenException') }),
    ]);
    await expect(promise).rejects.toThrow('awake (test sentinel)');
    expect(pings.n).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it('gives up after about a minute of refusals', async () => {
    const { promise, sleeps } = run(Array.from({ length: 100 }, () => awsError('AccessDeniedException')));
    await expect(promise).rejects.toThrow('AccessDeniedException');
    const waited = sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(IAM_PROPAGATION_RETRY_MS);
    expect(waited).toBeGreaterThanOrEqual(IAM_PROPAGATION_RETRY_MS - 5_000);
  });

  it('never retries other errors (a resume timeout or a SQL error fails at once)', async () => {
    for (const err of [
      new DatabaseResumingError({ waitedMs: 1 }),
      new DbError('denied', { sqlState: '42501' }),
    ]) {
      const { promise, pings, sleeps } = run([err]);
      await expect(promise).rejects.toBe(err);
      expect(pings.n).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('recognises the refusal through driver wrappers only', () => {
    expect(isIamPropagationError(awsError('AccessDeniedException'))).toBe(true);
    expect(isIamPropagationError(new DbError('x', { cause: awsError('ForbiddenException') }))).toBe(true);
    expect(
      isIamPropagationError(
        new DbError('x', { sqlState: '42501', cause: awsError('AccessDeniedException') }),
      ),
    ).toBe(false);
    expect(isIamPropagationError(awsError('ThrottlingException'))).toBe(false);
  });

  it('keeps two minutes for the response after the backfill deadline (R5)', () => {
    expect(RESPONSE_MARGIN_MS).toBe(120_000);
  });
});
