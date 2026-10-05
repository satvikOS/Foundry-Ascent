import { DatabaseResumingError, type Db, type SeedConfig } from '@foundry/db';
import type { CdkCustomResourceEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging.js';
import {
  handleSchemaEvent,
  MAX_WAKE_BUDGET_MS,
  MIGRATE_RESERVE_MS,
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
