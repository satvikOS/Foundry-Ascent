import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tagAlternate, tagEmbedding } from '../embedding-model.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
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

  it('ranks a match of words and meaning above one of words alone, and leaves out what neither points at', async () => {
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
    expect(appendix?.excerpt.length).toBeLessThanOrEqual(retrievalRepo.PASSAGE_CHARS);
    // Nothing points at it (an orthogonal vector, no shared word): below the floor, however few rows there are.
    expect(chunks.some((c) => c.title.endsWith('Vector only'))).toBe(false);
    for (const c of chunks) {
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).toBeLessThanOrEqual(1);
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

describe('memory learned in the conversation itself (live pilot 42099643194)', () => {
  it('leaves out AI memory first learned in this conversation, and keeps what earlier ones taught', async () => {
    // The coach's own plan, kept from a turn, came back as evidence [E1] on the next turn and was cited as a fact.
    const thisSession = '0b1d2c3e-4f50-4a61-8b72-9c83d4e5f601';
    const earlier = '0b1d2c3e-4f50-4a61-8b72-9c83d4e5f602';
    await t.db.system(async (sx) => {
      for (const [title, session, also] of [
        ['Turn-kept parcel lockers plan', thisSession, null],
        ['Earlier parcel lockers decision', earlier, thisSession],
      ] as const) {
        await memoryRepo.createMemory(sx, {
          tenantId: seed.tenantId,
          ventureId: A.id,
          type: 'decision',
          title,
          content: 'Parcel lockers at the east library entrance for the exam-month pilot.',
          origin: 'ai',
          createdBy: A.founder,
          status: 'confirmed',
          keptAutomatically: true,
          sourceRefs: [
            { kind: 'session', id: session, label: 'Learned from' },
            ...(also === null ? [] : [{ kind: 'session' as const, id: also, label: 'Learned from' }]),
          ],
        });
      }
    });
    const search = (excludeSessionId: string | null, excludeSessionSince: string | null = null) =>
      t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
        retrievalRepo.searchVentureMemory(tx, {
          tenantId: seed.tenantId,
          ventureId: A.id,
          query: 'parcel lockers east library entrance',
          embedding: null,
          limit: 20,
          excludeSessionId,
          excludeSessionSince,
        }),
      );
    const all = (await search(null)).map((m) => m.title);
    expect(all).toEqual(
      expect.arrayContaining(['Turn-kept parcel lockers plan', 'Earlier parcel lockers decision']),
    );
    const titles = (await search(thisSession)).map((m) => m.title);
    expect(titles).not.toContain('Turn-kept parcel lockers plan');
    // Taught by an earlier conversation, repeated in this one: still continuity.
    expect(titles).toContain('Earlier parcel lockers decision');
    // A long conversation: only what the turns still in the history window taught is left out. An item learned before
    // the oldest turn in view (here: the window starts after it was kept) is evidence again.
    const inView = (await search(thisSession, '2000-01-01T00:00:00Z')).map((m) => m.title);
    expect(inView).not.toContain('Turn-kept parcel lockers plan');
    const fellOut = (await search(thisSession, '2999-01-01T00:00:00Z')).map((m) => m.title);
    expect(fellOut).toContain('Turn-kept parcel lockers plan');
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
      // The shared corpora are small enough that sorting them would win; the question is whether the ANN
      // query shape can use the partial HNSW index at all.
      await sx.query(`SELECT set_config('enable_sort', 'off', true)`);
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

describe('the relevance floor and diversity', () => {
  const ask = (query: string, extra: Partial<retrievalRepo.SharedChunkQuery> = {}) =>
    t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        personaId: seed.personaId,
        query,
        embedding: null,
        limit: 10,
        ...extra,
      }),
    );

  it('returns nothing when nothing is about the message, whatever the stores hold', async () => {
    for (const query of ['', 'ok thanks', 'what is the tallest building in the world', 'pasta recipe'])
      expect(await ask(query), query).toEqual([]);
    const own = await t.db.withContext(makeContext(A.founder, seed.tenantId), async (tx) => [
      ...(await retrievalRepo.searchVentureChunks(tx, {
        tenantId: seed.tenantId,
        ventureId: A.id,
        query: 'zyzzyva quokka',
        embedding: null,
      })),
      ...(await retrievalRepo.searchResources(tx, { tenantId: seed.tenantId, query: 'zyzzyva quokka' })),
      ...(await retrievalRepo.searchPatterns(tx, { tenantId: seed.tenantId, query: 'zyzzyva quokka' })),
    ]);
    expect(own).toEqual([]);
  });

  it('gives a message with no subject of its own the founder’s record, best first', async () => {
    const items = await t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchVentureMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: A.id,
        query: 'what do you think i should do now?',
        embedding: null,
      }),
    );
    expect(items.length).toBeGreaterThan(3);
  });

  it('returns one copy of near-identical passages, and at most a few of one source', async () => {
    await t.db.system(async (sx) => {
      for (const [title, n] of [
        ['Marmalade notes A', 5],
        ['Marmalade notes B', 1],
      ] as const) {
        const source = await knowledgeRepo.createKnowledgeSource(sx, {
          tenantId: seed.tenantId,
          scope: 'program',
          title,
          kind: 'note',
        });
        await knowledgeRepo.insertChunks(sx, {
          sourceId: source.id,
          tenantId: seed.tenantId,
          scope: 'program',
          chunks: Array.from({ length: n }, (_, i) => ({
            ordinal: i,
            content:
              i === 0 ? 'Marmalade  pricing at the FAIR.' : `Marmalade at the fair, stall ${String(i)}.`,
          })),
        });
        if (title === 'Marmalade notes B') {
          await sx.query(
            `UPDATE knowledge_chunks SET content = 'marmalade pricing at the fair.' WHERE source_id = :s`,
            {
              s: p.uuid(source.id),
            },
          );
        }
      }
    });
    const found = (await ask('marmalade pricing at the fair')).filter((i) => i.title.startsWith('Marmalade'));
    const texts = found.map((i) => i.excerpt.toLowerCase().replace(/\s+/g, ' '));
    expect(new Set(texts).size).toBe(texts.length);
    expect(found.filter((i) => i.title === 'Marmalade notes A').length).toBeLessThanOrEqual(
      retrievalRepo.PER_SOURCE_LIMIT,
    );
    expect(texts.filter((x) => x === 'marmalade pricing at the fair.')).toHaveLength(1);
  });

  it('orders the same rows the same way every time, whatever their ids', async () => {
    const once = (await ask('experiment threshold prediction')).map((i) => i.refId);
    for (let i = 0; i < 3; i += 1)
      expect((await ask('experiment threshold prediction')).map((x) => x.refId)).toEqual(once);
    expect(once.length).toBeGreaterThan(0);
  });
});

describe('resources and lessons are offered only when the message is about them', () => {
  const offers = (query: string) =>
    t.db.withContext(makeContext(A.founder, seed.tenantId), async (tx) => [
      ...(await retrievalRepo.searchResources(tx, { tenantId: seed.tenantId, query, stage: 'idea' })),
      ...(await retrievalRepo.searchPatterns(tx, { tenantId: seed.tenantId, query })),
    ]);

  it('gives what their subject is asked for', async () => {
    const titles = async (query: string) => (await offers(query)).map((i) => i.title);
    expect(await titles('who can help with a founder agreement or contract templates?')).toContain(
      'Campus venture legal clinic',
    );
    expect(await titles('I need access to 3D printers for a prototype')).toContain('Prototype lab access');
    expect(await titles('Can I patent my idea for an app?')).toContain(
      'University technology transfer office',
    );
    expect(await titles('How many customer interviews are enough?')).toContain('Many interviews, no segment');
  });

  it('gives nothing for a word every venture uses, or one that is only in the description', async () => {
    for (const query of [
      // A client's run: "Campus venture legal clinic" for a pizza idea, "Regulatory pathway checked too late" for a pizza app.
      'My idea is a late-night pizza delivery app for students on campus. Can you help me get organized?',
      'where is the best pizza near campus',
      'Tell me my idea is great: an app that brings pizza to dorms',
      'who wrote The Great Gatsby',
      'how do I train for a marathon?',
      "what's a DBA and do I need one",
      'I have got a venture idea! Could you help me organise it?',
    ])
      expect(
        (await offers(query)).map((i) => i.title),
        query,
      ).toEqual([]);
  });
});

describe('the fusion’s weights', () => {
  const bench = async (query: string, tuning?: retrievalRepo.RetrievalTuning): Promise<string[]> => {
    const found = await t.db.system((sx) =>
      retrievalRepo.searchVentureChunks(sx, {
        tenantId: seed.tenantId,
        ventureId: B.id,
        query,
        embedding: vec(40),
        limit: 10,
        ...(tuning === undefined ? {} : { tuning }),
      }),
    );
    return found.filter((c) => c.title.startsWith('Weights')).map((c) => c.title.replace('Weights — ', ''));
  };

  beforeAll(async () => {
    await t.db.system(async (sx) => {
      const source = await knowledgeRepo.createKnowledgeSource(sx, {
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId: B.id,
        title: 'Weights',
        createdBy: B.founder,
      });
      await knowledgeRepo.insertChunks(sx, {
        sourceId: source.id,
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId: B.id,
        chunks: [
          { ordinal: 1, heading: 'Near', content: 'Nothing in common with it.', embedding: vec(40) },
          {
            ordinal: 2,
            heading: 'Worded',
            content: 'Quokka wombat numbat wallaby: all of the words.',
            embedding: vec(39, 0.5),
          },
          { ordinal: 3, heading: 'Trademark', content: 'A wombat on a label.', embedding: vec(39, 0.4) },
          { ordinal: 4, heading: 'Nearly', content: 'Nothing in common either.', embedding: vec(40, 0.3) },
        ],
      });
    });
  });

  it('let the vector lead, and words only break near ties', async () => {
    const words = 'quokka wombat numbat wallaby';
    expect((await bench(words))[0]).toBe('Near');
    // Equal weights (what it was) put the passage that shares the most words first.
    expect((await bench(words, { fusion: { vector: 1, lexical: 1, rescue: 1 } }))[0]).toBe('Worded');
  });

  it('let a thing named by name count, where the title says it', async () => {
    const order = await bench('trademark wombat quokka numbat');
    expect(order.indexOf('Trademark')).toBeLessThan(order.indexOf('Worded'));
    // Without it the passage is the source's fourth, and not shown (three of one source at most).
    expect(await bench('trademark wombat quokka numbat', { fusion: { rescue: 0.25 } })).not.toContain(
      'Trademark',
    );
  });

  it('are the code’s own numbers, and no others', async () => {
    expect(retrievalRepo.RETRIEVAL_FUSION).toMatchObject({ vector: 3, lexical: 0.25, rescue: 1.5 });
    await expect(bench('x', { fusion: { vector: Number.NaN } })).rejects.toThrow('finite');
  });
});

describe('a change of embedding model', () => {
  it('compares each row with the query embedded by the row’s own model, and an unrecorded one as before', async () => {
    const ids = await t.db.system(async (sx) => {
      const source = await knowledgeRepo.createKnowledgeSource(sx, {
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId: A.id,
        title: 'Model change',
        createdBy: A.founder,
      });
      await knowledgeRepo.insertChunks(sx, {
        sourceId: source.id,
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId: A.id,
        chunks: [
          {
            ordinal: 1,
            heading: 'Old',
            content: 'Alpha one.',
            embedding: tagEmbedding(vec(301), 'model-old'),
          },
          {
            ordinal: 2,
            heading: 'New',
            content: 'Beta two.',
            embedding: tagEmbedding(vec(302), 'model-new'),
          },
          { ordinal: 3, heading: 'Unknown', content: 'Gamma three.', embedding: vec(302, 0.2) },
        ],
      });
      return source.id;
    });
    const search = async (embedding: number[]) =>
      (
        await t.db.system((sx) =>
          retrievalRepo.searchVentureChunks(sx, {
            tenantId: seed.tenantId,
            ventureId: A.id,
            query: '',
            embedding,
            limit: 20,
          }),
        )
      )
        .filter((i) => i.sourceId === ids)
        .map((i) => i.title.replace('Model change — ', ''))
        .sort();
    // The new model's query never meets the old model's vector, however close the numbers are.
    expect(await search(tagEmbedding(vec(301), 'model-new'))).toEqual([]);
    expect(await search(tagEmbedding(vec(302), 'model-new'))).toEqual(['New', 'Unknown']);
    // Both models' embeddings of the query: each row by its own.
    expect(
      await search(
        tagAlternate(tagEmbedding(vec(302), 'model-new'), { embedding: vec(301), modelId: 'model-old' }),
      ),
    ).toEqual(['New', 'Old', 'Unknown']);
    // An untagged query (one model everywhere): every vector, as before.
    expect(await search(vec(301))).toEqual(['Old']);

    // The job's steps: record the old model where none is, list what is not the new one's, replace it.
    await t.db.system(async (sx) => {
      expect(await knowledgeRepo.stampEmbeddingModel(sx, 'model-old')).toBeGreaterThan(0);
      const backlog = await knowledgeRepo.listChunksOfOtherModels(sx, 'model-new', 500);
      const mine = backlog.filter((b) => /Alpha|Gamma/.test(b.text));
      expect(mine).toHaveLength(2);
      expect(backlog.some((b) => b.text.includes('Beta two.'))).toBe(false);
      await knowledgeRepo.setChunkEmbeddings(
        sx,
        mine.map((m) => ({ id: m.id, embedding: tagEmbedding(vec(302), 'model-new') })),
      );
      const left = await knowledgeRepo.listChunksOfOtherModels(sx, 'model-new', 500);
      expect(left.some((b) => /Alpha|Gamma/.test(b.text))).toBe(false);
      const counts = await knowledgeRepo.countEmbeddingModels(sx);
      expect(counts.find((c) => c.store === 'chunks' && c.modelId === 'model-new')?.rows).toBe(3);
    });
    expect(await search(tagEmbedding(vec(302), 'model-new'))).toEqual(['New', 'Old', 'Unknown']);
  });

  it('knows each model’s floors, strict for one it does not know, and suggests them from labelled pairs', () => {
    expect(retrievalRepo.embeddingProfile('us.cohere.embed-v4:0')).toEqual(
      retrievalRepo.EMBEDDING_PROFILES['cohere.embed-v4:0'],
    );
    expect(retrievalRepo.embeddingProfile('someone.new-model')).toEqual(
      retrievalRepo.DEFAULT_EMBEDDING_PROFILE,
    );
    expect(retrievalRepo.embeddingProfile(null)).toEqual(retrievalRepo.DEFAULT_EMBEDDING_PROFILE);
    const unrelated = Array.from({ length: 100 }, (_, i) => i / 500);
    const related = Array.from({ length: 100 }, (_, i) => 0.4 + i / 250);
    const suggested = retrievalRepo.suggestEmbeddingProfile(related, unrelated);
    expect(suggested.floor).toBeGreaterThan(suggested.weak);
    expect(unrelated.filter((x) => x >= suggested.floor).length).toBeLessThanOrEqual(2);
    expect(related.every((x) => x >= suggested.floor)).toBe(true);
    expect(retrievalRepo.suggestEmbeddingProfile([], [])).toEqual(retrievalRepo.DEFAULT_EMBEDDING_PROFILE);
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

describe('every store in one statement', () => {
  const searches = (query: string, embedding: number[] | null): retrievalRepo.EvidenceSearch => {
    const base = { tenantId: seed.tenantId, query, embedding };
    return {
      memory: { ...base, ventureId: A.id, limit: 8 },
      chunks: { ...base, ventureId: A.id, limit: 6 },
      shared: { ...base, personaId: seed.personaId, limit: 4 },
      resources: { tenantId: seed.tenantId, query, stage: 'validation', limit: 4 },
      patterns: { tenantId: seed.tenantId, query, personaId: seed.personaId, limit: 2 },
    };
  };

  it('returns exactly what the five searches return, in their order, as one statement', async () => {
    const cases: [string, number[] | null][] = [
      ['scanning tolerance barcode', vec(7)],
      ['falsifiable experiment prediction threshold pilot success', vec(100)],
      ['contracts founder agreements legal', null],
      ['', vec(11)],
      ['nothing matches this zyzzyva', null],
    ];
    for (const [query, embedding] of cases) {
      const search = searches(query, embedding);
      const { separate, together, statements } = await t.db.withContext(
        makeContext(A.founder, seed.tenantId),
        async (tx) => {
          let count = 0;
          const counting = {
            ...tx,
            query: (sql: string, params?: Parameters<typeof tx.query>[1]) => {
              count += 1;
              return tx.query(sql, params);
            },
          };
          const one = await retrievalRepo.searchEvidenceStores(counting, search);
          return {
            together: one,
            statements: count,
            separate: {
              memory: await retrievalRepo.searchVentureMemory(tx, search.memory ?? never()),
              chunks: await retrievalRepo.searchVentureChunks(tx, search.chunks ?? never()),
              shared: await retrievalRepo.searchSharedChunks(tx, search.shared ?? never()),
              resources: await retrievalRepo.searchResources(tx, search.resources ?? never()),
              patterns: await retrievalRepo.searchPatterns(tx, search.patterns ?? never()),
            },
          };
        },
      );
      expect(statements, query).toBe(1);
      expect(together, query).toEqual(separate);
    }
  });

  it('searches only the stores asked for, and none with no store', async () => {
    const search = searches('scanning tolerance barcode', vec(7));
    const only = await t.db.withContext(makeContext(A.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchEvidenceStores(tx, { memory: search.memory, patterns: search.patterns }),
    );
    expect(only.memory.length).toBeGreaterThan(0);
    expect(only.chunks).toEqual([]);
    expect(only.shared).toEqual([]);
    const none = await t.db.system((sx) => retrievalRepo.searchEvidenceStores(sx, {}));
    expect(none).toEqual({ memory: [], chunks: [], shared: [], resources: [], patterns: [] });
  });
});

function never(): never {
  throw new Error('search missing');
}
