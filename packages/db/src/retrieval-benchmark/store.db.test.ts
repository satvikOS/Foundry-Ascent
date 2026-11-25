import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import * as retrievalRepo from '../repositories/retrieval.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { benchmarkPassages } from './corpus.js';
import { embedStored, productionPassages, storableVector, storeBenchmark } from './store.js';

let t: TestDatabase;
const passages = benchmarkPassages([
  { id: 'price', title: 'Set a price', answer: 'Ask five buyers.', why: 'They pay.' },
]);

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('the benchmark in a database', () => {
  it('holds every passage in a tenant of its own, once, however often it is stored', async () => {
    const first = await t.db.system((sx) => storeBenchmark(sx, passages));
    const again = await t.db.system((sx) => storeBenchmark(sx, passages));
    expect(again.tenantId).toBe(first.tenantId);
    expect(new Set(again.passageOf.values())).toEqual(new Set(passages.map((x) => x.id)));
    const stored = await t.db.system((sx) =>
      sx.query(`SELECT count(*)::int AS chunks FROM knowledge_chunks WHERE tenant_id = :id`, {
        id: p.uuid(first.tenantId),
      }),
    );
    expect(stored.rows[0]).toEqual({ chunks: passages.length });
    // No founder of the platform's tenants ever meets it: every search is of one tenant, and it has no members.
    const seen = await t.db.system((sx) =>
      retrievalRepo.searchSharedChunks(sx, {
        tenantId: t.seed?.tenantId ?? '',
        personaId: t.seed?.personaId ?? null,
        query: 'set a price for five buyers',
        embedding: null,
        limit: 50,
      }),
    );
    for (const item of seen) expect(again.passageOf.has(item.refId)).toBe(false);
  });

  it('is found by its vectors, of a smaller model too', async () => {
    const { tenantId, passageOf } = await t.db.system((sx) => storeBenchmark(sx, passages));
    const ids = [...passageOf.keys()];
    const axis = (i: number): number[] => Array.from({ length: 600 }, (_, j) => Number(i === j));
    await t.db.system((sx) =>
      embedStored(
        sx,
        ids.map((id, i) => ({ id, vector: axis(i % 600) })),
        'small-model',
      ),
    );
    const [found] = await t.db.system((sx) =>
      retrievalRepo.searchSharedChunks(sx, {
        tenantId,
        query: '',
        embedding: storableVector(axis(7), 'small-model'),
        limit: 1,
      }),
    );
    expect(found?.refId).toBe(ids[7]);
    expect(found?.components.vector).toBeCloseTo(1, 6);
  });

  it('matches every stored passage of the benchmark to the home tenant’s by the text it is embedded by', async () => {
    const production = await t.db.system((sx) => productionPassages(sx, 'ain', passages));
    expect(production.principalId).not.toBe('');
    expect(production.coachPersonaId).not.toBeNull();
    const matched = new Set(production.rows.flatMap((r) => (r.passageId === null ? [] : [r.passageId])));
    const expected = passages.filter((x) => x.store === 'chunk').map((x) => x.id);
    expect(expected.filter((id) => !matched.has(id))).toEqual([]);
    // Only what is not a passage of any source of the benchmark is left over (the coach's red lines).
    expect(production.rows.filter((r) => r.passageId === null).length).toBeLessThanOrEqual(2);
  });
});
