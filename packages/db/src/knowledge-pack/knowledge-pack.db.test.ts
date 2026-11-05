import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import * as knowledgeRepo from '../repositories/knowledge.js';
import * as retrievalRepo from '../repositories/retrieval.js';
import { type SeedResult, seedDatabase } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { knowledgePackEvalQuestions, loadKnowledgePack } from './pack.js';
import { PACK_URI_PREFIX, packItems } from './render.js';
import { PACK_OWNER, packSourceId, syncKnowledgePack } from './sync.js';
import { type KnowledgePack } from './types.js';

let t: TestDatabase;
let seed: SeedResult;
let venture: { id: string; founder: string; personaId: string };

const pack = loadKnowledgePack();
const items = packItems(pack);
const PASSAGES = items.reduce((n, item) => n + item.passages.length, 0);

/** Deterministic unit vector along `axis`. */
function vec(axis: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  return v;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function variant(change: (draft: Mutable<KnowledgePack>) => void): KnowledgePack {
  const draft = structuredClone(pack) as Mutable<KnowledgePack>;
  change(draft);
  return draft;
}

async function sources(tenantId: string) {
  const r = await t.db.system((sx) =>
    sx.query(
      `SELECT s.id, s.uri, s.scope, s.kind, s.classification, s.venture_id, s.persona_id, s.status, s.owner,
              s.checksum, s.body, s.updated_at,
              (SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id = s.id) AS chunks
       FROM knowledge_sources s WHERE s.tenant_id = :tenantId AND starts_with(s.uri, :prefix) ORDER BY s.uri`,
      { tenantId: p.uuid(tenantId), prefix: p.text(PACK_URI_PREFIX) },
    ),
  );
  return r.rows;
}

async function chunkState(tenantId: string): Promise<Map<string, { id: string; embedded: boolean }[]>> {
  const r = await t.db.system((sx) =>
    sx.query(
      `SELECT c.source_id, c.id, c.embedding IS NOT NULL AS embedded FROM knowledge_chunks c
       WHERE c.tenant_id = :tenantId AND c.scope = 'public' ORDER BY c.source_id, c.ordinal`,
      { tenantId: p.uuid(tenantId) },
    ),
  );
  const out = new Map<string, { id: string; embedded: boolean }[]>();
  for (const row of r.rows) {
    const key = String(row.source_id);
    out.set(key, [...(out.get(key) ?? []), { id: String(row.id), embedded: row.embedded === true }]);
  }
  return out;
}

/** Shared-corpus retrieval as a coaching turn runs it (the founder's RLS context, lexical unless `embedding`). */
async function search(
  query: string,
  options: { embedding?: number[]; referenceLimit?: number } = {},
): Promise<retrievalRepo.RetrievedItem[]> {
  return t.db.withContext(makeContext(venture.founder, seed.tenantId), (tx) =>
    retrievalRepo.searchSharedChunks(tx, {
      tenantId: seed.tenantId,
      query,
      embedding: options.embedding ?? null,
      personaId: venture.personaId,
      classifications: ['synthetic', 'public', 'program_internal'],
      limit: 4,
      ...(options.referenceLimit === undefined ? {} : { referenceLimit: options.referenceLimit }),
    }),
  );
}

const keyOfSource = new Map<string, string>();
function referenceKeys(found: readonly retrievalRepo.RetrievedItem[]): string[] {
  return found
    .filter((r) => r.sourceScope === 'public')
    .map((r) => keyOfSource.get(r.sourceId ?? '') ?? `unknown:${String(r.sourceId)}`);
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  const v = seed.ventures.find((x) => x.key === 'quietquad');
  if (!v) throw new Error('venture missing');
  venture = { id: v.id, founder: v.members[0]?.principalId ?? '', personaId: v.personaId };
  for (const item of items) keyOfSource.set(packSourceId(seed.tenantId, item.key), item.key);
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('ingestion into the common pool', () => {
  it('the seed puts every item in the tenant’s common pool as public reference material, never in a venture', async () => {
    const rows = await sources(seed.tenantId);
    expect(rows).toHaveLength(items.length);
    for (const row of rows) {
      expect(row).toMatchObject({
        scope: 'public',
        kind: 'document',
        classification: 'public',
        venture_id: null,
        persona_id: null,
        status: 'active',
        owner: PACK_OWNER,
      });
      expect(String(row.checksum)).toMatch(/^skb@3\.0\.0:sha256:/);
      expect(String(row.body)).toContain('## References');
    }
    expect(rows.reduce((n, r) => n + Number(r.chunks), 0)).toBe(PASSAGES);
    // Passages wait for the deploy's embedding backfill like every seeded chunk.
    const backlog = await t.db.system((sx) => knowledgeRepo.listChunksMissingEmbeddings(sx, 1000));
    const pending = new Set(backlog.map((b) => b.id));
    const state = await chunkState(seed.tenantId);
    for (const list of state.values()) for (const c of list) expect(pending.has(c.id)).toBe(true);
    // Nothing of it reaches a venture's specific pool.
    const leaked = await t.db.system((sx) =>
      sx.query(
        `SELECT
           (SELECT count(*)::int FROM knowledge_chunks WHERE scope = 'public' AND venture_id IS NOT NULL) AS chunks,
           (SELECT count(*)::int FROM memory_objects WHERE content ILIKE '%NONA%' OR content ILIKE '%Warby Parker%')
             AS memory`,
      ),
    );
    expect(leaked.rows[0]).toEqual({ chunks: 0, memory: 0 });
  });

  it('is idempotent: syncing again, or seeding again, changes nothing', async () => {
    const before = await sources(seed.tenantId);
    const chunksBefore = await chunkState(seed.tenantId);
    const report = await t.db.system((sx) => syncKnowledgePack(sx, { tenantId: seed.tenantId }));
    expect(report).toEqual({
      inserted: 0,
      updated: 0,
      withdrawn: 0,
      unchanged: items.length,
      keptWithdrawn: 0,
      passages: 0,
    });
    await seedDatabase(t.db, { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null });
    expect(await sources(seed.tenantId)).toEqual(before);
    expect(await chunkState(seed.tenantId)).toEqual(chunksBefore);
  });

  it('re-ingests only an item whose text changed, keeping every other passage and its embedding', async () => {
    await t.db.system(async (sx) => {
      const state = await chunkState(seed.tenantId);
      const all = [...state.values()].flat();
      await knowledgeRepo.setChunkEmbeddings(
        sx,
        all.map((c, i) => ({ id: c.id, embedding: vec(200 + (i % 500)) })),
      );
    });
    const before = await chunkState(seed.tenantId);
    const changed = variant((d) => {
      d.scenarios = d.scenarios.map((s) =>
        s.scenario_id === 'SC02' ? { ...s, reported_outcome: `${s.reported_outcome} (Reworded.)` } : s,
      );
    });
    const report = await t.db.system((sx) =>
      syncKnowledgePack(sx, { tenantId: seed.tenantId, pack: changed }),
    );
    expect(report).toMatchObject({
      inserted: 0,
      updated: 1,
      withdrawn: 0,
      unchanged: items.length - 1,
      passages: 3,
    });
    const after = await chunkState(seed.tenantId);
    const sc02 = packSourceId(seed.tenantId, 'case/SC02');
    for (const [source, list] of after) {
      if (source === sc02) {
        expect(list.every((c) => !c.embedded)).toBe(true);
        expect(list.map((c) => c.id)).not.toEqual(before.get(source)?.map((c) => c.id));
      } else {
        expect(list).toEqual(before.get(source));
      }
    }
    const text = await t.db.system((sx) =>
      sx.query(`SELECT content FROM knowledge_chunks WHERE source_id = :id AND ordinal = 1`, {
        id: p.uuid(sc02),
      }),
    );
    expect(String(text.rows[0]?.content)).toContain('(Reworded.)');
    // Back to the canonical JSON: that one item again.
    const back = await t.db.system((sx) => syncKnowledgePack(sx, { tenantId: seed.tenantId }));
    expect(back).toMatchObject({ updated: 1, unchanged: items.length - 1, passages: 3 });
  });

  it('withdraws an item the JSON no longer has, and brings it back when the JSON has it again', async () => {
    const without = variant((d) => {
      d.scenarios = d.scenarios.filter((s) => s.scenario_id !== 'SC25');
    });
    const report = await t.db.system((sx) =>
      syncKnowledgePack(sx, { tenantId: seed.tenantId, pack: without }),
    );
    expect(report).toMatchObject({ withdrawn: 1, updated: 0, passages: 0 });
    const gone = (await sources(seed.tenantId)).find((r) => r.uri === `${PACK_URI_PREFIX}case/SC25`);
    expect(gone).toMatchObject({ status: 'withdrawn', checksum: null, chunks: 0 });
    const back = await t.db.system((sx) => syncKnowledgePack(sx, { tenantId: seed.tenantId }));
    expect(back).toMatchObject({ updated: 1, withdrawn: 0, keptWithdrawn: 0, passages: 3 });
    const again = (await sources(seed.tenantId)).find((r) => r.uri === `${PACK_URI_PREFIX}case/SC25`);
    expect(again).toMatchObject({ status: 'active', chunks: 3 });
  });

  it('never undoes a withdrawal someone made, even when the item’s text changes', async () => {
    const id = packSourceId(seed.tenantId, 'case/SC03');
    await t.db.system(async (sx) => {
      await sx.query(`UPDATE knowledge_sources SET status = 'withdrawn' WHERE id = :id`, { id: p.uuid(id) });
      await knowledgeRepo.deleteChunksForSource(sx, id);
    });
    const changed = variant((d) => {
      d.scenarios = d.scenarios.map((s) =>
        s.scenario_id === 'SC03' ? { ...s, analysis: `${s.analysis} Also.` } : s,
      );
    });
    for (const next of [undefined, changed]) {
      const report = await t.db.system((sx) =>
        syncKnowledgePack(sx, { tenantId: seed.tenantId, ...(next ? { pack: next } : {}) }),
      );
      expect(report).toMatchObject({ keptWithdrawn: 1, updated: 0, inserted: 0 });
    }
    const row = (await sources(seed.tenantId)).find((r) => r.id === id);
    expect(row).toMatchObject({ status: 'withdrawn', chunks: 0 });
    expect(await search('Warby Parker home try-on', { referenceLimit: 3 })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ sourceId: id })]),
    );
    // Restore for the retrieval tests below.
    await t.db.system(async (sx) => {
      await sx.query(`UPDATE knowledge_sources SET status = 'active', checksum = NULL WHERE id = :id`, {
        id: p.uuid(id),
      });
      await syncKnowledgePack(sx, { tenantId: seed.tenantId });
    });
  });

  it('gives each tenant its own copy', async () => {
    const other = await t.db.system(async (sx) => {
      const r = await sx.query(
        `INSERT INTO tenants (slug, name, kind) VALUES ('kp-partner', 'Partner', 'partner') RETURNING id`,
      );
      const tenantId = String(r.rows[0]?.id);
      return { tenantId, report: await syncKnowledgePack(sx, { tenantId }) };
    });
    expect(other.report).toMatchObject({ inserted: items.length, passages: PASSAGES });
    const rows = await sources(other.tenantId);
    expect(rows).toHaveLength(items.length);
    expect(rows.some((r) => keyOfSource.has(String(r.id)))).toBe(false);
  });
});

describe('relevance gate: reference passages only when the founder’s words name their subject', () => {
  const UNRELATED = [
    'thanks, talk soon',
    'yes',
    'ok got it, I will do that tomorrow',
    'Can you help me reword my grant application budget section?',
    'My posture is terrible after long coding sessions, any tips?',
    'Should I sign the lease for the bakery space this week?',
    'I tutor high school students in math and want to raise my hourly rate from $40 to $55.',
    'We sold 500 units and get monthly reorders. How do I use that data in a grocery pitch?',
    'I am stressed about my co-founder not pulling their weight.',
    'Our holiday rush is crazy, just yes or no: should I hire a temp?',
    'Should we do a pilot with the hospital before raising?',
    'Can you write a short thank-you note to my landlord?',
    'Let us embrace change in the team this quarter.',
    'I need to finish my board update slides by Friday.',
  ];

  it('a question in everyday words that happen to be program words is still a subject question', async () => {
    // "program" and "session" have everyday senses: they do not keep the library out.
    expect(
      referenceKeys(
        await search('How should I run customer discovery interview sessions for my loyalty program?'),
      ),
    ).toContain('framework/F04');
  });

  it.each(UNRELATED)('an unrelated turn retrieves none: %s', async (query) => {
    expect(referenceKeys(await search(query, { referenceLimit: 3 }))).toEqual([]);
  });

  it.each([
    ['What is the jobs to be done framework?', 'framework/F06'],
    ['How did Dropbox grow?', 'case/SC15'],
    ['We are thinking about home try-on like Warby Parker for our glasses brand', 'case/SC03'],
    ['How do I calculate CAC and payback for my subscription box?', 'framework/F09'],
    ['Who should mentor a startup that is scaling?', 'stage/growth'],
  ])('a turn about a subject retrieves it: %s', async (query, key) => {
    const found = await search(query);
    const keys = referenceKeys(found);
    expect(keys).toContain(key);
    // At most two passages, never two of the same item.
    expect(keys.length).toBeLessThanOrEqual(2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a call’s turn gets at most one reference passage', async () => {
    const found = await search('How did NONA use customer discovery interviews to choose a market?', {
      referenceLimit: 1,
    });
    expect(referenceKeys(found)).toEqual(['case/SC01']);
  });

  it('prefers a case’s documented account to its editorial passages', async () => {
    const found = await search('How did NONA use customer discovery interviews to choose a market?');
    const nona = found.find((r) => keyOfSource.get(r.sourceId ?? '') === 'case/SC01');
    expect(nona?.title).toBe(
      'NONA Technologies: Choosing a viable initial market — Documented account · MIT / J-WAFS, evidence as of 2024-10-02',
    );
  });

  it('a question about the program draws on the program’s guidance only', async () => {
    const found = await search('What are the program stage gates to leave validation?');
    expect(referenceKeys(found)).toEqual([]);
    expect(found[0]?.sourceScope).toBe('program');
    expect(found[0]?.title).toContain('Stage gates');
  });

  it('ranks the program’s own guidance above a reference passage that covers the same subject', async () => {
    const found = await search('How do I set up an experiment card with a success threshold?');
    const program = found.findIndex(
      (r) => r.sourceScope === 'program' && r.title.includes('Experiment card'),
    );
    const reference = found.findIndex((r) => r.sourceScope === 'public');
    expect(program).toBeGreaterThanOrEqual(0);
    expect(reference).toBeGreaterThan(program);
  });

  it('a vector never admits a passage on its own, and a distant one vetoes a lexical match', async () => {
    const ids = await t.db.system(async (sx) => {
      const r = await sx.query(`SELECT id FROM knowledge_chunks WHERE tenant_id = :t AND scope = 'public'`, {
        t: p.uuid(seed.tenantId),
      });
      const list = r.rows.map((row) => String(row.id));
      await knowledgeRepo.setChunkEmbeddings(
        sx,
        list.map((id) => ({ id, embedding: vec(5) })),
      );
      return list;
    });
    expect(ids.length).toBe(PASSAGES + 0);
    // Identical vectors (similarity 1) with unrelated words: nothing.
    expect(referenceKeys(await search('Should I sign the lease this week?', { embedding: vec(5) }))).toEqual(
      [],
    );
    // The right words with an orthogonal vector (similarity 0): vetoed.
    expect(referenceKeys(await search('How did Dropbox grow?', { embedding: vec(9) }))).toEqual([]);
    // The right words with a near vector: admitted.
    expect(referenceKeys(await search('How did Dropbox grow?', { embedding: vec(5) }))).toContain(
      'case/SC15',
    );
  });
});

describe('retrieval evaluation (the pack’s rag_eval_questions.json)', () => {
  const ragDocOf = new Map(items.filter((i) => i.ragDocId !== null).map((i) => [i.key, i.ragDocId ?? '']));

  it('finds every expected document in the top three for the answerable questions (Recall@3 = 1.00)', async () => {
    const answerable = knowledgePackEvalQuestions().filter((q) => q.expected_doc_ids.length > 0);
    expect(answerable.map((q) => q.question_id)).toEqual(['Q01', 'Q02', 'Q03', 'Q04']);
    const recalls: number[] = [];
    for (const q of answerable) {
      const docs = referenceKeys(await search(q.question, { referenceLimit: 3 })).map((k) => ragDocOf.get(k));
      const hit = q.expected_doc_ids.filter((d) => docs.includes(d)).length;
      recalls.push(hit / q.expected_doc_ids.length);
    }
    expect(recalls).toEqual([1, 1, 1, 1]);
  });

  it('Q05 (abstention): what it asks is not in the evidence, and the evidence says so', async () => {
    const q = knowledgePackEvalQuestions().find((x) => x.question_id === 'Q05');
    if (!q) throw new Error('Q05 missing');
    expect(q.expected_doc_ids).toEqual([]);
    const found = (await search(q.question, { referenceLimit: 3 })).filter((r) => r.sourceScope === 'public');
    // No passage reports an interview-to-sale conversion figure…
    for (const r of found) {
      expect(r.excerpt).not.toMatch(/\d+(\.\d+)?\s?%/);
      expect(r.excerpt).not.toMatch(/conversion rate/i);
    }
    // …and the case's documented account, which is retrieved, states the gap: the only grounded answer abstains.
    const nona = found.find((r) => keyOfSource.get(r.sourceId ?? '') === 'case/SC01');
    expect(nona?.title).toContain('Documented account · MIT / J-WAFS');
    expect(nona?.excerpt).toContain('does not name that beachhead or disclose interview-to-sale conversion');
  });
});
