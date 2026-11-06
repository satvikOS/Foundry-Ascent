import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import * as assignmentsRepo from '../repositories/assignments.js';
import * as knowledgeRepo from '../repositories/knowledge.js';
import * as retrievalRepo from '../repositories/retrieval.js';
import * as sessionsRepo from '../repositories/sessions.js';
import * as turnsRepo from '../repositories/turns.js';
import { type SeedResult, seedDatabase } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { knowledgePackEvalQuestions, loadKnowledgePack } from './pack.js';
import { PACK_URI_PREFIX, packItems } from './render.js';
import { PACK_OWNER, packSourceId, syncKnowledgePack, syncKnowledgePackToTenants } from './sync.js';
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

/**
 * Shared-corpus retrieval as a coaching turn runs it (the founder's RLS context, lexical unless `embedding`): the
 * reference gate reads `founderText` (default: the query itself), a typed turn's limit of two.
 */
async function search(
  query: string,
  options: {
    embedding?: number[];
    limit?: number;
    founderText?: string;
    sessionId?: string;
    context?: { earlierFounderTexts: readonly string[]; venture?: string | null };
  } = {},
): Promise<retrievalRepo.RetrievedItem[]> {
  return t.db.withContext(makeContext(venture.founder, seed.tenantId), (tx) =>
    retrievalRepo.searchSharedChunks(tx, {
      tenantId: seed.tenantId,
      query,
      embedding: options.embedding ?? null,
      personaId: venture.personaId,
      classifications: ['synthetic', 'public', 'program_internal'],
      limit: 4,
      reference: {
        founderText: options.founderText ?? query,
        limit: options.limit ?? retrievalRepo.REFERENCE_GATE.limit,
        sessionId: options.sessionId ?? null,
        ...(options.context === undefined ? {} : { context: options.context }),
      },
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
    // The pack's passages are the only reference passages, each under its own item's source.
    const own = new Set(items.map((i) => packSourceId(seed.tenantId, i.key)));
    for (const source of state.keys()) expect(own.has(source)).toBe(true);
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
    expect(await search('Tell me about the Warby Parker case.')).toEqual(
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

  it('the deploy’s sync reaches every active tenant, idempotently, and skips a suspended one', async () => {
    const suspended = await t.db.system(async (sx) => {
      const r = await sx.query(
        `INSERT INTO tenants (slug, name, kind, status) VALUES ('kp-paused', 'Paused', 'partner', 'suspended')
         RETURNING id`,
      );
      return String(r.rows[0]?.id);
    });
    const reports = await t.db.system((sx) => syncKnowledgePackToTenants(sx));
    const slugs = reports.map((r) => r.slug);
    expect(slugs).toEqual(expect.arrayContaining(['ain', 'kp-partner']));
    expect(slugs).not.toContain('kp-paused');
    for (const { report } of reports) {
      expect(report).toMatchObject({ inserted: 0, updated: 0, withdrawn: 0, unchanged: items.length });
    }
    expect(await sources(suspended)).toHaveLength(0);
  });
});

describe('relevance gate: a reference passage only when the founder’s own message names its subject', () => {
  it.each([
    'thanks, talk soon',
    'yes',
    'Could this work for parents of toddlers?',
    'Grove Street has cheaper rent, should we move there?',
    'Quincy is where my parents live, so I can store inventory there.',
    'Let us embrace change in the team this quarter.',
    'I put the deck on Dropbox, can you look at it?',
    'We did five customer interviews last week.',
    'Our holiday rush is crazy, just yes or no: should I hire a temp?',
  ])('an everyday turn retrieves none: %s', async (text) => {
    expect(referenceKeys(await search(text))).toEqual([]);
  });

  it.each([
    ['What is the jobs to be done framework?', 'framework/F06'],
    ['How did Dropbox grow?', 'case/SC15'],
    ['We are thinking about home try-on like Warby Parker for our glasses brand', 'case/SC03'],
    ['How do I calculate CAC and payback for my subscription box?', 'framework/F09'],
    ['Who should mentor a startup that is scaling?', 'stage/growth'],
  ])('a question about a subject retrieves exactly that item: %s', async (text, key) => {
    expect(referenceKeys(await search(text))).toEqual([key]);
  });

  it('reads the founder’s own message, never what the retrieval query adds to it', async () => {
    // A short reply composed with the vEIR's last question ("…unit economics…") and the venture goal: the lexical
    // query names a framework, the founder did not.
    const composed =
      'yes, sure\nShould we look at your unit economics and CAC payback first?\nValidate paid demand';
    expect(referenceKeys(await search(composed, { founderText: 'yes, sure' }))).toEqual([]);
    // The founder's own words decide even when the composed query says nothing about it.
    expect(
      referenceKeys(await search('what about it', { founderText: 'How do I calculate CAC and payback?' })),
    ).toEqual(['framework/F09']);
  });

  it('a call’s turn gets at most one reference passage, a typed turn two only when two are named', async () => {
    const q = 'How did NONA use customer discovery interviews to choose a market?';
    expect(referenceKeys(await search(q))).toEqual(['case/SC01', 'framework/F04']);
    expect(referenceKeys(await search(q, { limit: 1 }))).toEqual(['case/SC01']);
  });

  it('shows a case’s documented account, its evidence limits first, and a framework’s limitations', async () => {
    const [nona] = (await search('Tell me about the NONA Technologies case.')).filter(
      (r) => r.sourceScope === 'public',
    );
    expect(nona?.title).toBe(
      'NONA Technologies: Choosing a viable initial market — Documented account · MIT / J-WAFS, evidence as of 2024-10-02',
    );
    expect(nona?.excerpt).toMatch(/^Evidence limits: /);
    const [f09] = (await search('What is a contribution margin and why does it matter?')).filter(
      (r) => r.sourceScope === 'public',
    );
    const limitations = pack.frameworks.find((f) => f.framework_id === 'F09')?.limitations ?? '';
    expect(f09?.excerpt).toContain(`Limitations: ${limitations}`);
  });

  it('never shows an item again in a conversation that already cited it', async () => {
    const quietquad = seed.ventures.find((v) => v.key === 'quietquad');
    if (!quietquad) throw new Error('venture missing');
    const ctx = makeContext(venture.founder, seed.tenantId);
    const sessionId = await t.db.withContext(ctx, async (tx) => {
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id);
      if (!resolved?.release) throw new Error('assignment missing');
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release.id,
        startedBy: venture.founder,
        mode: 'coach',
        privacy: 'standard',
        policyVersion: 'test',
      });
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        sessionId: session.id,
        authorId: venture.founder,
        mode: 'coach',
        founderText: 'How did Dropbox grow?',
      });
      const [shown] = (
        await retrievalRepo.searchSharedChunks(tx, {
          tenantId: seed.tenantId,
          query: 'How did Dropbox grow?',
          embedding: null,
          personaId: venture.personaId,
          reference: { founderText: 'How did Dropbox grow?', sessionId: session.id },
        })
      ).filter((r) => r.sourceScope === 'public');
      if (!shown?.sourceId) throw new Error('nothing shown');
      await turnsRepo.insertTurnEvidence(tx, turn.id, [
        {
          key: 'E1',
          kind: 'chunk',
          refId: shown.refId,
          score: shown.score,
          title: shown.title,
          source: { id: shown.sourceId, scope: 'public' },
        },
      ]);
      return session.id;
    });
    const again = 'And what did Dropbox do with its referral program?';
    // Same conversation: not again (another of its passages neither). Another conversation: shown.
    expect(referenceKeys(await search(again, { sessionId }))).toEqual([]);
    expect(referenceKeys(await search(again))).toEqual(['case/SC15']);
    // Another item in the same conversation is still shown.
    expect(referenceKeys(await search('What is design thinking?', { sessionId }))).toEqual(['framework/F05']);
  });

  it('offers an item the conversation keeps naming unasked, at most once every few turns (coaching v3)', async () => {
    const message = 'So the unit economics only work for the office customers who order in bulk.';
    const context = { earlierFounderTexts: ['I redid our unit economics with the courier quote.'] };
    // Nothing asked: without the conversation naming it too, nothing; with it, the one item.
    expect(referenceKeys(await search(message))).toEqual([]);
    expect(referenceKeys(await search(message, { context }))).toEqual(['framework/F09']);
    // What the founder asks for wins over what the conversation is about.
    expect(referenceKeys(await search('What is design thinking?', { context }))).toEqual(['framework/F05']);
    // A conversation whose latest turn showed a reference passage: nothing unasked comes back yet.
    const quietquad = seed.ventures.find((v) => v.key === 'quietquad');
    if (!quietquad) throw new Error('venture missing');
    const sessionId = await t.db.withContext(makeContext(venture.founder, seed.tenantId), async (tx) => {
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id);
      if (!resolved?.release) throw new Error('assignment missing');
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release.id,
        startedBy: venture.founder,
        mode: 'coach',
        privacy: 'standard',
        policyVersion: 'test',
      });
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        sessionId: session.id,
        authorId: venture.founder,
        mode: 'coach',
        founderText: 'What is design thinking?',
      });
      const [shown] = (
        await retrievalRepo.searchSharedChunks(tx, {
          tenantId: seed.tenantId,
          query: 'What is design thinking?',
          embedding: null,
          personaId: venture.personaId,
          reference: { founderText: 'What is design thinking?', sessionId: session.id },
        })
      ).filter((r) => r.sourceScope === 'public');
      if (!shown?.sourceId) throw new Error('nothing shown');
      await turnsRepo.insertTurnEvidence(tx, turn.id, [
        {
          key: 'E1',
          kind: 'chunk',
          refId: shown.refId,
          score: shown.score,
          title: shown.title,
          source: { id: shown.sourceId, scope: 'public' },
        },
      ]);
      return session.id;
    });
    expect(referenceKeys(await search(message, { context, sessionId }))).toEqual([]);
    // Asked for, it is never held back.
    expect(referenceKeys(await search('What is customer discovery?', { context, sessionId }))).toEqual([
      'framework/F04',
    ]);
  });

  it('a question about the program draws on the program’s guidance only', async () => {
    const found = await search('What are the program stage gates to leave validation?');
    expect(referenceKeys(found)).toEqual([]);
    expect(found[0]?.sourceScope).toBe('program');
    expect(found[0]?.title).toContain('Stage gates');
  });

  it('ranks the program’s own guidance above a reference passage that covers the same subject', async () => {
    const found = await search('How do I estimate unit economics with real numbers from pilots?');
    const program = found.findIndex(
      (r) => r.sourceScope === 'program' && r.title.includes('Business-model risk tests'),
    );
    const reference = found.findIndex((r) => r.sourceScope === 'public');
    expect(program).toBeGreaterThanOrEqual(0);
    expect(reference).toBeGreaterThan(program);
    expect(referenceKeys(found)).toEqual(['framework/F09']);
  });

  it('without the founder’s message (no reference query), no reference passage at all', async () => {
    const found = await t.db.withContext(makeContext(venture.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        query: 'How did Dropbox grow?',
        embedding: null,
        personaId: venture.personaId,
      }),
    );
    expect(referenceKeys(found)).toEqual([]);
  });

  it('a vector never admits a passage on its own, and a distant one vetoes a match', async () => {
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
    expect(ids.length).toBe(PASSAGES);
    // Identical vectors (similarity 1) with everyday words: nothing.
    expect(referenceKeys(await search('Should I sign the lease this week?', { embedding: vec(5) }))).toEqual(
      [],
    );
    // The right words with an orthogonal vector (similarity 0): vetoed.
    expect(referenceKeys(await search('How did Dropbox grow?', { embedding: vec(9) }))).toEqual([]);
    // The right words with a near vector: admitted.
    expect(referenceKeys(await search('How did Dropbox grow?', { embedding: vec(5) }))).toEqual([
      'case/SC15',
    ]);
  });
});

describe('isolation', () => {
  it('a founder of one tenant reads no reference row of another tenant, by query or by retrieval', async () => {
    const other = await t.db.system(async (sx) => {
      const r = await sx.query(
        `INSERT INTO tenants (slug, name, kind) VALUES ('kp-other', 'Other', 'partner') RETURNING id`,
      );
      const tenantId = String(r.rows[0]?.id);
      await syncKnowledgePack(sx, { tenantId });
      return tenantId;
    });
    expect(await sources(other)).toHaveLength(items.length);
    const ctx = makeContext(venture.founder, seed.tenantId);
    const seen = await t.db.withContext(ctx, async (tx) => {
      const rows = await tx.query(
        `SELECT
           (SELECT count(*)::int FROM knowledge_sources WHERE tenant_id = :other) AS sources,
           (SELECT count(*)::int FROM knowledge_chunks WHERE tenant_id = :other) AS chunks,
           (SELECT count(*)::int FROM knowledge_sources WHERE tenant_id = :own AND scope = 'public') AS own`,
        { other: p.uuid(other), own: p.uuid(seed.tenantId) },
      );
      const retrieved = await retrievalRepo.searchSharedChunks(tx, {
        tenantId: other,
        query: 'How did Dropbox grow?',
        embedding: null,
        reference: { founderText: 'How did Dropbox grow?' },
      });
      return { counts: rows.rows[0], retrieved };
    });
    // Their own tenant's copy is visible (the check can fail), the other tenant's is not.
    expect(seen.counts).toEqual({ sources: 0, chunks: 0, own: items.length });
    expect(seen.retrieved).toEqual([]);
  });

  it('a founder cannot write the reference library: no insert, update or delete of scope public', async () => {
    const ctx = makeContext(venture.founder, seed.tenantId);
    const insert = (who: string) =>
      t.db.withContext(makeContext(who, seed.tenantId), (tx) =>
        tx.query(
          `INSERT INTO knowledge_sources (tenant_id, scope, kind, title, owner, classification, status)
           VALUES (:t, 'public', 'document', 'Injected reference', 'test', 'public', 'active') RETURNING id`,
          { t: p.uuid(seed.tenantId) },
        ),
      );
    // SQLSTATE 42501: the row-level security policy refuses the founder…
    await expect(insert(venture.founder)).rejects.toThrow(/42501/);
    // …and it is the policy, not a missing grant: the program lead may add to the common pool.
    const lead = await insert(seed.programLeadId ?? '');
    const leadSource = String(lead.rows[0]?.id);
    await t.db.system((sx) =>
      sx.query(`DELETE FROM knowledge_sources WHERE id = :id`, { id: p.uuid(leadSource) }),
    );
    const sc15 = packSourceId(seed.tenantId, 'case/SC15');
    const changed = await t.db.withContext(ctx, async (tx) => {
      const updated = await tx.query(
        `UPDATE knowledge_sources SET title = 'Rewritten by a founder' WHERE id = :id`,
        { id: p.uuid(sc15) },
      );
      const deleted = await tx.query(`DELETE FROM knowledge_chunks WHERE source_id = :id`, {
        id: p.uuid(sc15),
      });
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });
    expect(changed).toEqual({ updated: 0, deleted: 0 });
    const after = (await sources(seed.tenantId)).find((r) => r.id === sc15);
    expect(after).toMatchObject({ status: 'active', chunks: 3 });
    expect(String(after?.body)).not.toContain('Rewritten');
  });

  it('a venture’s own document search never returns a reference passage', async () => {
    const found = await t.db.withContext(makeContext(venture.founder, seed.tenantId), (tx) =>
      retrievalRepo.searchVentureChunks(tx, {
        tenantId: seed.tenantId,
        ventureId: venture.id,
        query: 'NONA Technologies desalination beachhead interviews',
        embedding: null,
        limit: 20,
      }),
    );
    const library = new Set(items.map((i) => packSourceId(seed.tenantId, i.key)));
    expect(found.filter((r) => library.has(r.sourceId ?? ''))).toEqual([]);
    // The probe can see what it looks for: the same words find the library passage through the shared search.
    expect(referenceKeys(await search('Tell me about NONA Technologies desalination.'))).toEqual([
      'case/SC01',
    ]);
  });
});

describe('retrieval evaluation (the pack’s rag_eval_questions.json)', () => {
  const ragDocOf = new Map(items.filter((i) => i.ragDocId !== null).map((i) => [i.key, i.ragDocId ?? '']));

  it('finds every expected document for the answerable questions (Recall = 1.00)', async () => {
    const answerable = knowledgePackEvalQuestions().filter((q) => q.expected_doc_ids.length > 0);
    expect(answerable.map((q) => q.question_id)).toEqual(['Q01', 'Q02', 'Q03', 'Q04']);
    const recalls: number[] = [];
    for (const q of answerable) {
      const docs = referenceKeys(await search(q.question)).map((k) => ragDocOf.get(k));
      const hit = q.expected_doc_ids.filter((d) => docs.includes(d)).length;
      recalls.push(hit / q.expected_doc_ids.length);
    }
    expect(recalls).toEqual([1, 1, 1, 1]);
  });

  it('Q05 (abstention): what it asks is not in the evidence, and the evidence says so first', async () => {
    const q = knowledgePackEvalQuestions().find((x) => x.question_id === 'Q05');
    if (!q) throw new Error('Q05 missing');
    expect(q.expected_doc_ids).toEqual([]);
    const found = (await search(q.question)).filter((r) => r.sourceScope === 'public');
    expect(found.length).toBeGreaterThan(0);
    // No passage reports an interview-to-sale conversion figure…
    for (const r of found) {
      expect(r.excerpt).not.toMatch(/\d+(\.\d+)?\s?%/);
      expect(r.excerpt).not.toMatch(/conversion rate/i);
    }
    // …and the case's documented account opens with the gap: the only grounded answer abstains.
    const nona = found.find((r) => keyOfSource.get(r.sourceId ?? '') === 'case/SC01');
    expect(nona?.title).toContain('Documented account · MIT / J-WAFS');
    expect(nona?.excerpt).toMatch(
      /^Evidence limits: .*does not name that beachhead or disclose interview-to-sale conversion/,
    );
  });
});
