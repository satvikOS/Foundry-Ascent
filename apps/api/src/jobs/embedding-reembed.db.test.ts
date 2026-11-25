/**
 * A change of embedding model, online (docs/runbooks/embedding-model.md): the job records which model made the vectors
 * that do not say, then replaces them in batches; every row keeps a vector throughout, an interrupted run continues, and
 * a batch another model answered is never stored.
 */
import { type EmbedResult, hashEmbedding } from '@foundry/ai';
import { knowledgeRepo, settingsRepo, usageRepo } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createJsonLogger } from '../logging.js';
import { backfillEmbeddings, type BackfillOptions } from './embedding-backfill.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

function gatewayOf(modelId: string) {
  const texts: string[][] = [];
  return {
    texts,
    embed: (batch: readonly string[]): Promise<EmbedResult> => {
      texts.push([...batch]);
      return Promise.resolve({
        vectors: batch.map((x) => hashEmbedding(`${modelId} ${x}`)),
        modelId,
        usage: { inputTokens: 1, outputTokens: 0 },
        costUsd: 0.001,
        latencyMs: 1,
      });
    },
  };
}

const logger = createJsonLogger({ level: 'error', write: () => undefined });
const run = (gateway: ReturnType<typeof gatewayOf>, options: Partial<BackfillOptions> = {}) =>
  backfillEmbeddings(
    { db: t.db, gateway, logger },
    {
      requestId: 'reembed',
      purpose: 'embedding',
      maxItems: 5_000,
      deadline: Date.now() + 60_000,
      ...options,
    },
  );
const models = async () => {
  const rows = await t.db.system((sx) => knowledgeRepo.countEmbeddingModels(sx));
  return new Map(rows.map((r) => [`${r.store}:${r.modelId ?? 'none'}`, r.rows]));
};

describe('re-embedding with a new model', () => {
  it('replaces every vector, resumes after an interruption and never mixes models', async () => {
    const old = gatewayOf('model-old');
    expect(await run(old)).toMatchObject({ stoppedBy: 'done', remaining: false });
    const before = await models();
    const chunks = before.get('chunks:model-old') ?? 0;
    const memory = before.get('memory:model-old') ?? 0;
    expect(chunks).toBeGreaterThan(100);
    expect(memory).toBeGreaterThan(10);
    // As rows from before migration 0034: the model is not recorded.
    await t.db.system((sx) => sx.query('UPDATE knowledge_chunks SET embedding_model = NULL'));

    const next = gatewayOf('model-new');
    const reembed = { target: 'model-new', previous: 'model-old' };
    const part = await run(next, { maxItems: 40, reembed });
    expect(part).toMatchObject({ chunks: 40, stoppedBy: 'max_items', remaining: true });
    const halfway = await models();
    expect(halfway.get('chunks:model-new')).toBe(40);
    // The rest still have their old model's vector, and say so.
    expect(halfway.get('chunks:model-old')).toBe(chunks - 40);
    expect(halfway.get('chunks:none')).toBeUndefined();

    expect(await run(next, { reembed })).toMatchObject({ stoppedBy: 'done', remaining: false, memory });
    const after = await models();
    expect(after.get('chunks:model-new')).toBe(chunks);
    expect(after.get('memory:model-new')).toBe(memory);
    expect([...after.keys()].some((k) => k.endsWith('model-old'))).toBe(false);
    // Again: nothing to do, and no call made.
    const calls = next.texts.length;
    expect(await run(next, { reembed })).toMatchObject({ chunks: 0, memory: 0, stoppedBy: 'done' });
    expect(next.texts.length).toBe(calls);
  });

  it('stops when the gateway answers with another model than the target, storing nothing', async () => {
    const before = await models();
    const other = gatewayOf('model-other');
    expect(await run(other, { reembed: { target: 'model-third', previous: 'model-new' } })).toMatchObject({
      chunks: 0,
      stoppedBy: 'model_mismatch',
    });
    expect(await models()).toEqual(before);
  });

  it('keeps to the kill switch and the daily spend cap', async () => {
    const reembed = { target: 'model-fourth', previous: 'model-new' };
    const spent = await t.db.system((sx) => usageRepo.spendToday(sx));
    const settings = await t.db.system((sx) => settingsRepo.getPlatformSettings(sx));
    await t.db.system((sx) =>
      sx.query(`UPDATE platform_settings SET value = '0.0001' WHERE key = 'daily_usd_cap_global'`),
    );
    expect(spent).toBeGreaterThan(0.0001);
    expect(await run(gatewayOf('model-fourth'), { reembed })).toMatchObject({ stoppedBy: 'spend_cap' });
    expect(settings.aiEnabled).toBe(true);
  });
});
