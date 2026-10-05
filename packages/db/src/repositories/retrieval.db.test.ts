import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { EXCERPT_CHARS } from './common.js';
import * as knowledgeRepo from './knowledge.js';
import * as memoryRepo from './memory.js';
import * as retrievalRepo from './retrieval.js';

let t: TestDatabase;
let seed: SeedResult;
let A: { id: string; founder: string };
let B: { id: string; founder: string };

/** Deterministic unit vector pointing mostly along `axis`. */
function vec(axis: number, wobble = 0): number[] {
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  v[(axis + 1) % 1024] = wobble;
  const norm = Math.hypot(1, wobble);
  return v.map((x) => x / norm);
}

const SHARED_TEXT =
  'Shelf scanning tolerance notes: barcode readers misread curved reagent bottles in cold rooms.';

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  const va = seed.ventures.find((v) => v.key === 'quietquad');
  const vb = seed.ventures.find((v) => v.key === 'benchtally');
  if (!va || !vb) throw new Error('ventures missing');
  A = { id: va.id, founder: va.members[0]?.principalId ?? '' };
  B = { id: vb.id, founder: vb.members[0]?.principalId ?? '' };

  // Identical memory and chunk text with identical embeddings in A and B.
  await t.db.system(async (sx) => {
    for (const v of [A, B]) {
      const m = await memoryRepo.createMemory(sx, {
        tenantId: seed.tenantId,
        ventureId: v.id,
        type: 'evidence',
        title: 'Scanner tolerance',
        content: SHARED_TEXT,
        origin: 'founder',
        createdBy: v.founder,
        status: 'confirmed',
        embedding: vec(7),
      });
      expect(m.hasEmbedding).toBe(true);
      const source = await knowledgeRepo.createKnowledgeSource(sx, {
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId: v.id,
        title: 'Scanner field notes',
        createdBy: v.founder,
      });
      await knowledgeRepo.insertChunks(sx, {
        sourceId: source.id,
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId: v.id,
        chunks: [
          { ordinal: 1, heading: 'Tolerance', content: SHARED_TEXT, embedding: vec(7) },
          { ordinal: 2, heading: 'Long appendix', content: 'Appendix line about calibration. '.repeat(80) },
          { ordinal: 3, heading: 'Vector only', content: 'Unrelated wording entirely.', embedding: vec(11) },
        ],
      });
    }
    // Shared program corpus: give the seeded program chunks embeddings so the HNSW path has data.
    const backlog = await knowledgeRepo.listChunksMissingEmbeddings(sx, 500);
    const shared = await sx.query('SELECT id FROM knowledge_chunks WHERE venture_id IS NULL ORDER BY id');
    const sharedIds = new Set(shared.rows.map((r) => String(r.id)));
    const updates = backlog
      .filter((b) => sharedIds.has(b.id))
      .map((b, i) => ({ id: b.id, embedding: vec(100 + i) }));
    expect(await knowledgeRepo.setChunkEmbeddings(sx, updates)).toBe(updates.length);
  });
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('venture-scoped retrieval', () => {
  it('never returns another venture’s memory or chunks, even with identical text and embeddings', async () => {
    const query = {
      tenantId: seed.tenantId,
      ventureId: A.id,
      query: 'scanning tolerance barcode',
      embedding: vec(7),
    };
    const asFounder = await t.db.withContext(makeContext(A.founder, seed.tenantId), async (tx) => ({
      memory: await retrievalRepo.searchVentureMemory(tx, query),
      chunks: await retrievalRepo.searchVentureChunks(tx, query),
    }));
    const asSystem = await t.db.system(async (sx) => ({
      memory: await retrievalRepo.searchVentureMemory(sx, query),
      chunks: await retrievalRepo.searchVentureChunks(sx, query),
    }));
    for (const result of [asFounder, asSystem]) {
      expect(result.memory.length).toBeGreaterThan(0);
      expect(result.chunks.length).toBeGreaterThan(0);
      for (const item of [...result.memory, ...result.chunks]) expect(item.ventureId).toBe(A.id);
    }
    const bIds = await t.db.system((sx) =>
      sx.query(
        `SELECT id FROM memory_objects WHERE venture_id = :b UNION ALL SELECT id FROM knowledge_chunks WHERE venture_id = :b`,
        { b: p.uuid(B.id) },
      ),
    );
    const forbidden = new Set(bIds.rows.map((r) => String(r.id)));
    for (const item of [...asFounder.memory, ...asFounder.chunks, ...asSystem.memory, ...asSystem.chunks]) {
      expect(forbidden.has(item.refId)).toBe(false);
    }
    // B's canary never appears in A's results.
    const canaryB = seed.ventures.find((v) => v.key === 'benchtally')?.canary ?? 'missing';
    const canaryQuery = { ...query, query: canaryB, embedding: null };
    const leak = await t.db.withContext(makeContext(A.founder, seed.tenantId), async (tx) => [
      ...(await retrievalRepo.searchVentureMemory(tx, canaryQuery)),
      ...(await retrievalRepo.searchVentureChunks(tx, canaryQuery)),
    ]);
    expect(leak.some((i) => i.excerpt.includes(canaryB))).toBe(false);
  });

  it('a founder asking for another venture gets nothing (RLS), even if the service passed the wrong id', async () => {
    const results = await t.db.withContext(makeContext(A.founder, seed.tenantId), async (tx) => [
      ...(await retrievalRepo.searchVentureMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: B.id,
        query: 'scanning tolerance',
        embedding: vec(7),
      })),
      ...(await retrievalRepo.searchVentureChunks(tx, {
        tenantId: seed.tenantId,
        ventureId: B.id,
        query: 'scanning tolerance',
        embedding: vec(7),
      })),
    ]);
    expect(results).toEqual([]);
  });

  it('scores hybrid matches above lexical-only and vector-only ones, with bounded excerpts', async () => {
    const chunks = await t.db.system((sx) =>
      retrievalRepo.searchVentureChunks(sx, {
        tenantId: seed.tenantId,
        ventureId: A.id,
        query: 'tolerance calibration',
        embedding: vec(7),
        limit: 10,
      }),
    );
    expect(chunks.map((c) => c.title)).toContain('Scanner field notes — Tolerance');
    expect(chunks[0]?.title).toBe('Scanner field notes — Tolerance');
    for (let i = 1; i < chunks.length; i += 1)
      expect(chunks[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(chunks[i]?.score ?? 0);
    const appendix = chunks.find((c) => c.title.endsWith('Long appendix'));
    expect(appendix).toBeDefined();
    expect(appendix?.components.vector).toBe(0); // NULL embedding → lexical only
    expect(appendix?.components.lexical).toBeGreaterThan(0);
    expect(appendix?.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    const vectorOnly = chunks.find((c) => c.title.endsWith('Vector only'));
    expect(vectorOnly?.components.lexical ?? 0).toBe(0);
    for (const c of chunks) {
      expect(c.score).toBeCloseTo(
        0.55 * c.components.vector +
          0.25 * c.components.lexical +
          0.1 * c.components.recency +
          0.1 * c.components.authority,
        6,
      );
      expect(c.freshnessAt).not.toBeNull();
      expect(c.status).toBe('active');
    }
  });

  it('works lexically when the query has no embedding', async () => {
    const memory = await t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchVentureMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: A.id,
        query: 'exam week library seats',
        embedding: null,
      }),
    );
    expect(memory.length).toBeGreaterThan(0);
    expect(
      memory.every((m) => m.components.vector === 0 && m.kind === 'memory' && m.memoryType !== null),
    ).toBe(true);
    expect(memory.some((m) => m.status === 'proposed' || m.status === 'confirmed')).toBe(true);
  });

  it('respects memory visibility under RLS (team member never retrieves founder_private items)', async () => {
    const devin = seed.ventures.find((v) => v.key === 'quietquad')?.members.find((m) => m.key === 'devin');
    if (!devin) throw new Error('devin missing');
    const items = await t.db.withContext(makeContext(devin.principalId, seed.tenantId), (tx) =>
      retrievalRepo.searchVentureMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: A.id,
        query: 'keep the student app free licensing',
        embedding: null,
        limit: 20,
      }),
    );
    expect(items.some((i) => i.title === 'Keep the student app free')).toBe(false);
  });
});

describe('shared corpora', () => {
  it('returns program chunks and persona doctrine only for the assigned persona', async () => {
    const founderCtx = makeContext(A.founder, seed.tenantId);
    const withPersona = await t.db.withContext(founderCtx, (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        personaId: seed.personaId,
        query: 'falsifiable experiment prediction threshold',
        embedding: vec(100),
        limit: 10,
      }),
    );
    expect(withPersona.some((i) => i.kind === 'doctrine')).toBe(true);
    expect(withPersona.some((i) => i.kind === 'chunk')).toBe(true);
    expect(withPersona.every((i) => i.ventureId === null)).toBe(true);
    const withoutPersona = await t.db.withContext(founderCtx, (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        query: 'falsifiable experiment prediction threshold',
        embedding: vec(100),
        limit: 10,
      }),
    );
    expect(withoutPersona.some((i) => i.kind === 'doctrine')).toBe(false);
    const restricted = await t.db.withContext(founderCtx, (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        personaId: seed.personaId,
        query: 'experiment',
        embedding: null,
        classifications: ['public'],
      }),
    );
    expect(restricted).toEqual([]);
  });

  it('uses the HNSW index for the shared ANN candidate scan', async () => {
    const plan = await t.db.system(async (sx) => {
      await sx.query(`SELECT set_config('enable_seqscan', 'off', true)`);
      const r = await sx.query(
        `EXPLAIN SELECT c.id FROM knowledge_chunks c
         WHERE c.venture_id IS NULL AND c.tenant_id = :t AND c.scope = ANY (:scopes) AND :e IS NOT NULL
         ORDER BY c.embedding <=> :e LIMIT 40`,
        { t: p.uuid(seed.tenantId), scopes: p.textArray(['program', 'persona']), e: p.vector(vec(100)) },
      );
      return r.rows.map((row) => String(row['QUERY PLAN'])).join('\n');
    });
    expect(plan).toContain('knowledge_chunks_shared_embedding_idx');
  });
});

describe('resources and patterns', () => {
  it('finds program resources lexically with a stage-fit bonus', async () => {
    const items = await t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchResources(tx, {
        tenantId: seed.tenantId,
        query: 'contracts founder agreements legal',
        stage: 'validation',
      }),
    );
    expect(items[0]?.title).toBe('Campus venture legal clinic');
    expect(items[0]?.components.stageFit).toBe(1);
    expect(items.every((i) => i.kind === 'resource')).toBe(true);
  });

  it('finds published patterns', async () => {
    const items = await t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchPatterns(tx, { tenantId: seed.tenantId, query: 'pilot success threshold' }),
    );
    expect(items[0]?.title).toBe('Pilot without a success threshold');
  });
});
