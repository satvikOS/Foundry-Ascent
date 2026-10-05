import { MockModelGateway } from '@foundry/ai';
import { accessCodePrefix, generateAccessCode, hashAccessCode, p, type SeedConfig } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';
import type { CdkCustomResourceEvent } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createJsonLogger } from '../logging.js';
import { backfillEmbeddings } from './embedding-backfill.js';
import {
  handleSchemaEvent,
  SCHEMA_PHYSICAL_RESOURCE_ID,
  type SchemaResourceDeps,
} from './schema-resource.js';

let t: TestDatabase;
let deps: SchemaResourceDeps;
const logs: string[] = [];
const gateway = new MockModelGateway();

const base = {
  ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider',
  ResponseURL: 'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/x',
  StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/FoundryAscent-App/1',
  RequestId: 'req-1',
  LogicalResourceId: 'Migrations',
  ResourceType: 'Custom::FoundryMigrations',
  ResourceProperties: {
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider',
    version: 'abc',
  },
};
const invocation = { requestId: 'aws-req-1', remainingMs: () => 9 * 60_000 };

async function count(sql: string): Promise<number> {
  const result = await t.db.system((sx) => sx.query(sql));
  return Number((result.rows[0] as { n: string | number }).n);
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  const code = generateAccessCode();
  const seedConfig: SeedConfig = {
    homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' },
    owner: {
      displayName: 'Deploy Owner',
      accessCodePrefix: accessCodePrefix(code),
      accessCodeHash: await hashAccessCode(code),
    },
  };
  const logger = createJsonLogger({ level: 'debug', write: (line) => logs.push(line) });
  deps = {
    db: t.db,
    seedConfig,
    backfill: (options) => backfillEmbeddings({ db: t.db, gateway, logger }, { ...options, purpose: 'seed' }),
    logger,
  };
});
afterAll(async () => {
  await t.cleanup();
});

describe('migrations custom resource', () => {
  it('Create: migrates an empty database, seeds it and embeds every seed chunk and memory item', async () => {
    const event = { ...base, RequestType: 'Create' } as CdkCustomResourceEvent;
    const response = await handleSchemaEvent(deps, event, invocation);
    expect(response.PhysicalResourceId).toBe(SCHEMA_PHYSICAL_RESOURCE_ID);
    expect(response.Data?.MigrationsApplied).toMatch(/^0001/);
    expect(response.Data?.EmbeddingsComplete).toBe('true');
    expect(Number(response.Data?.ChunksEmbedded)).toBeGreaterThan(0);
    expect(Number(response.Data?.MemoryEmbedded)).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS n FROM knowledge_chunks WHERE embedding IS NULL')).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_objects WHERE embedding IS NULL AND status IN ('proposed','confirmed','disputed')",
      ),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM usage_ledger WHERE purpose = 'seed'")).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS n FROM ventures')).toBeGreaterThan(0);
  });

  it('Update: idempotent (nothing to migrate, seed and backfill are no-ops)', async () => {
    const ventures = await count('SELECT count(*) AS n FROM ventures');
    const event = {
      ...base,
      RequestType: 'Update',
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
      OldResourceProperties: base.ResourceProperties,
    } as CdkCustomResourceEvent;
    const response = await handleSchemaEvent(deps, event, invocation);
    expect(response).toMatchObject({
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
      Data: {
        MigrationsApplied: 'none',
        ChunksEmbedded: '0',
        MemoryEmbedded: '0',
        EmbeddingsComplete: 'true',
      },
    });
    expect(await count('SELECT count(*) AS n FROM ventures')).toBe(ventures);
  });

  it('respects the AI kill switch for the backfill and never fails the deployment because of it', async () => {
    await t.db.system((sx) =>
      sx.query("UPDATE platform_settings SET value = 'false' WHERE key = 'ai_enabled'"),
    );
    await t.db.system((sx) =>
      sx.query(
        'UPDATE knowledge_chunks SET embedding = NULL WHERE id IN (SELECT id FROM knowledge_chunks LIMIT 2)',
      ),
    );
    const event = {
      ...base,
      RequestType: 'Update',
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
      OldResourceProperties: {},
    };
    const response = await handleSchemaEvent(deps, event as CdkCustomResourceEvent, invocation);
    expect(response.Data?.EmbeddingsComplete).toBe('false');
    expect(await count('SELECT count(*) AS n FROM knowledge_chunks WHERE embedding IS NULL')).toBe(2);
    await t.db.system((sx) =>
      sx.query("UPDATE platform_settings SET value = 'true' WHERE key = 'ai_enabled'"),
    );
  });

  it('never embeds a memory item that was deleted meanwhile', async () => {
    const id = await t.db.system(async (sx) => {
      const r = await sx.query(
        "SELECT id FROM memory_objects WHERE status = 'confirmed' ORDER BY created_at LIMIT 1",
      );
      return (r.rows[0] as { id: string }).id;
    });
    await t.db.system((sx) =>
      sx.query("UPDATE memory_objects SET embedding = NULL, status = 'deleted' WHERE id = :id", {
        id: p.uuid(id),
      }),
    );
    const report = await backfillEmbeddings(
      { db: t.db, gateway, logger: deps.logger },
      { requestId: 'r', purpose: 'embedding', maxItems: 100, deadline: Date.now() + 60_000 },
    );
    expect(report.stoppedBy).toBe('done');
    expect(
      await count(`SELECT count(*) AS n FROM memory_objects WHERE id = '${id}' AND embedding IS NOT NULL`),
    ).toBe(0);
  });

  it('a failing embedding backfill (e.g. Bedrock throttling) never fails the deployment', async () => {
    await t.db.system((sx) =>
      sx.query(
        'UPDATE knowledge_chunks SET embedding = NULL WHERE id IN (SELECT id FROM knowledge_chunks LIMIT 3)',
      ),
    );
    const throttled = Object.assign(new Error('Rate exceeded for model'), { name: 'ThrottlingException' });
    const throttlingGateway = { embed: () => Promise.reject(throttled) };
    const event = {
      ...base,
      RequestType: 'Update',
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
      OldResourceProperties: base.ResourceProperties,
    } as CdkCustomResourceEvent;
    const response = await handleSchemaEvent(
      {
        ...deps,
        backfill: (options) =>
          backfillEmbeddings(
            { db: t.db, gateway: throttlingGateway, logger: deps.logger },
            { ...options, purpose: 'seed' },
          ),
      },
      event,
      invocation,
    );
    expect(response).toMatchObject({
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
      Data: { ChunksEmbedded: '0', EmbeddingsComplete: 'false' },
    });
    expect(await count('SELECT count(*) AS n FROM knowledge_chunks WHERE embedding IS NULL')).toBe(3);
    // A backfill that throws outright (database error) is contained the same way.
    const crashing = await handleSchemaEvent(
      { ...deps, backfill: () => Promise.reject(new Error('connection reset')) },
      event,
      invocation,
    );
    expect(crashing.Data?.EmbeddingsComplete).toBe('false');
    const text = logs.join('\n');
    expect(text).toContain('embeddings.backfill_batch_failed');
    expect(text).toContain('schema.embeddings_backfill_failed');
    expect(text).not.toContain('Rate exceeded');
    expect(text).not.toContain('connection reset');
    // The normal backfill embeds the rest on the next run.
    const next = await handleSchemaEvent(deps, event, invocation);
    expect(next.Data?.EmbeddingsComplete).toBe('true');
    expect(await count('SELECT count(*) AS n FROM knowledge_chunks WHERE embedding IS NULL')).toBe(0);
  });

  it('Delete: no-op with the stable physical id', async () => {
    const event = {
      ...base,
      RequestType: 'Delete',
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
    } as CdkCustomResourceEvent;
    await expect(handleSchemaEvent(deps, event, invocation)).resolves.toEqual({
      PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
    });
    expect(await count('SELECT count(*) AS n FROM ventures')).toBeGreaterThan(0);
  });

  it('logs identifiers and counts only', () => {
    const text = logs.join('\n');
    expect(text).toContain('schema.migration_applied');
    expect(text).toContain('schema.done');
    expect(text).not.toContain(deps.seedConfig.owner?.accessCodeHash ?? 'unreachable');
  });
});
