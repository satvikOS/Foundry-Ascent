/**
 * Shared notes near the founder's own words (`SharedChunkQuery.semantic`), on a seeded tenant with vectors made by hand:
 * a note lies at a chosen cosine from the message, whatever its words are. What is shown of them is `admitSemantic`'s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tagAlternate, tagEmbedding } from '../embedding-model.js';
import { type AppExecutor } from '../executor.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as knowledgeRepo from './knowledge.js';
import * as retrievalRepo from './retrieval.js';
import * as sessionsRepo from './sessions.js';
import * as turnsRepo from './turns.js';

const TITAN = 'amazon.titan-embed-text-v2:0';
const COHERE = 'cohere.embed-v4:0';
/** A question no topic, no vocabulary and no title word names. */
const ASK = 'how come the folks upstairs never sign off';
const FLOOR = retrievalRepo.EMBEDDING_PROFILES[TITAN]?.admit ?? 1;

let t: TestDatabase;
let seed: SeedResult;
let founder: string;
let personaId: string;

/** A unit vector at cosine `c` from axis `axis` (the rest along a direction of its own). */
function at(c: number, axis = 0, other = 500): number[] {
  const v = new Array<number>(1024).fill(0);
  v[axis] = c;
  v[other] = Math.sqrt(1 - c * c);
  return v;
}
const message = (axis = 0, model = TITAN): number[] => tagEmbedding(at(1, axis), model);

/** The chunks of the source `uri`, by ordinal. */
async function chunkIds(uri: string, tenantId = seed.tenantId): Promise<string[]> {
  const r = await t.db.system((sx) =>
    sx.query(
      `SELECT c.id FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
       WHERE s.uri = :uri AND s.tenant_id = :tenantId ORDER BY c.ordinal`,
      { uri: p.text(uri), tenantId: p.uuid(tenantId) },
    ),
  );
  return r.rows.map((x) => String(x.id));
}
const place = async (uri: string, ordinal: number, vector: number[], model = TITAN): Promise<string> => {
  const id = (await chunkIds(uri))[ordinal - 1];
  if (id === undefined) throw new Error(`no passage ${uri}#${String(ordinal)}`);
  await t.db.system((sx) =>
    knowledgeRepo.setChunkEmbeddings(sx, [{ id, embedding: tagEmbedding(vector, model) }]),
  );
  return id;
};
const uris = async (prefix: string): Promise<string[]> => {
  const r = await t.db.system((sx) =>
    sx.query(
      `SELECT uri FROM knowledge_sources WHERE tenant_id = :t AND starts_with(uri, :prefix) ORDER BY uri`,
      { t: p.uuid(seed.tenantId), prefix: p.text(prefix) },
    ),
  );
  return r.rows.map((x) => String(x.uri));
};

async function search(
  semantic: Partial<retrievalRepo.SemanticQuery> | null,
  extra: Partial<retrievalRepo.SharedChunkQuery> = {},
  wrap: (tx: AppExecutor) => AppExecutor = (tx) => tx,
): Promise<retrievalRepo.RetrievedItem[]> {
  const embedding = extra.embedding === undefined ? message() : extra.embedding;
  const found = await t.db.withContext(makeContext(founder, seed.tenantId), (tx) =>
    retrievalRepo.searchEvidenceStores(wrap(tx), {
      shared: {
        tenantId: seed.tenantId,
        personaId,
        query: ASK,
        embedding,
        limit: 2,
        reference: { founderText: ASK, limit: 2, sessionId: null },
        corpus: { founderText: ASK },
        ...(semantic === null
          ? {}
          : { semantic: { asks: 'ask' as const, channel: 'text' as const, embedding, ...semantic } }),
        ...extra,
      },
    }),
  );
  return found.shared;
}
const nearOf = (items: readonly retrievalRepo.RetrievedItem[]) => items.filter((i) => i.lane === 'semantic');
const shown = (items: readonly retrievalRepo.RetrievedItem[], asks: 'ask' | 'guarded' = 'ask') =>
  nearOf(
    retrievalRepo.admitSemantic(
      items,
      retrievalRepo.semanticRule({ asks, channel: 'text', embedding: message() }),
    ),
  ).map((i) => i.refId);

let note = '';
let reference = '';
let curriculum = '';
let libraryUri = '';
let packUri = '';

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  const venture = t.seed?.ventures.find((v) => v.key === 'quietquad');
  if (!t.seed || !venture) throw new Error('seed missing');
  seed = t.seed;
  founder = venture.members[0]?.principalId ?? '';
  personaId = venture.personaId;
  libraryUri = 'library:sba-structure';
  packUri = 'urn:foundry:startup-knowledge-base:case/SC23';
  const course = (await uris('curriculum:')).find((u) => !u.startsWith('curriculum:notes/')) ?? '';
  note = await place(libraryUri, 2, at(0.6));
  await place(libraryUri, 1, at(0.5));
  reference = await place(packUri, 1, at(0.55));
  curriculum = await place(course, 1, at(0.58));
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('notes near the founder’s own words', () => {
  it('are found whatever their words are, one a source, with their kind, and only when asked for', async () => {
    const found = nearOf(await search({}));
    expect(found.map((i) => [i.refId, i.near?.family])).toEqual(
      expect.arrayContaining([
        [note, 'note'],
        [curriculum, 'curriculum'],
        [reference, 'reference'],
      ]),
    );
    expect(found).toHaveLength(3);
    const similarity = new Map(found.map((i) => [i.refId, i.near?.similarity ?? 0]));
    expect(similarity.get(note)).toBeCloseTo(0.6, 4);
    expect(similarity.get(reference)).toBeCloseTo(0.55, 4);
    for (const item of found) expect(item.near?.shownBefore).toBe(false);
    // The gates bring none but the library's, by its vector, in their own slot.
    expect((await search(null)).map((i) => [i.lane, i.refId, i.near])).toEqual([['corpus', note, undefined]]);
    // A question about the programme itself is its own guidance's.
    const programme = 'which eir helps our cohort';
    const asked = await search({}, { reference: { founderText: programme, sessionId: null } });
    expect(nearOf(asked).map((i) => i.near?.family)).not.toContain('reference');
    expect(nearOf(await search({ embedding: null }))).toEqual([]);
  });

  it('are none, not even the library’s by its vector, on a turn that asks nothing', async () => {
    expect(await search({ asks: null })).toEqual([]);
    expect(await search({ embedding: null })).toEqual([]);
  });

  it('are shown by the rule: the closest, its neighbours, and a curriculum passage only as the best', async () => {
    expect(shown(await search({}))).toEqual([note, reference]);
  });

  it('are none for a question nothing is near to, or one that only shares words with a note', async () => {
    // Nothing is near.
    expect(nearOf(await search({}, { embedding: message(7) }))).toEqual([]);
    // Every word of it is in the note's text, and the note is far from what it means.
    const words = 'sole proprietorship liability partnership corporation';
    const trap = await search({}, { query: words, embedding: message(7) });
    expect(nearOf(trap)).toEqual([]);
    // Just under the floor.
    await place(libraryUri, 3, at(FLOOR - 0.01, 8));
    expect(nearOf(await search({}, { embedding: message(8) }))).toEqual([]);
    await place(libraryUri, 3, at(FLOOR + 0.01, 8));
    const over = await search({}, { embedding: message(8) });
    expect(shown(over)).toHaveLength(1);
    // A message that only may ask needs more.
    expect(nearOf(await search({ asks: 'guarded' }, { embedding: message(8) }))).toEqual([]);
  });

  it('change nothing the gates bring', async () => {
    const asks = [
      'Should I form an LLC or a corporation?',
      'What is customer discovery?',
      'How did Warby Parker test demand?',
    ];
    for (const query of asks) {
      const extra = {
        query,
        // Nothing is near what the search asks: the words are the gates'.
        embedding: message(7),
        reference: { founderText: query, limit: 2, sessionId: null },
        corpus: { founderText: query },
      };
      const lanes = (items: readonly retrievalRepo.RetrievedItem[]) =>
        items.filter((i) => i.lane !== 'semantic').map((i) => [i.lane, i.refId]);
      const plain = lanes(await search(null, extra));
      const items = await search({ embedding: message() }, extra);
      expect(plain.length, query).toBeGreaterThan(0);
      expect(nearOf(items).length, query).toBeGreaterThan(0);
      expect(lanes(items), query).toEqual(plain);
    }
  });

  it('are candidates still when the gates had no slot left for them', async () => {
    const query = 'Should I form an LLC or a corporation?';
    const extra = {
      query,
      embedding: message(7),
      reference: { founderText: query, limit: 2, sessionId: null },
    };
    const topical = (await search(null, { ...extra, corpus: { founderText: query, limit: 10 } })).filter(
      (i) => i.lane === 'corpus',
    );
    const last = topical.at(-1);
    expect(topical.length).toBeGreaterThan(1);
    if (last === undefined) return;
    await t.db.system((sx) =>
      knowledgeRepo.setChunkEmbeddings(sx, [{ id: last.refId, embedding: tagEmbedding(at(0.8, 30), TITAN) }]),
    );
    const one = { ...extra, corpus: { founderText: query, limit: 1 } };
    expect((await search(null, one)).map((i) => i.refId)).not.toContain(last.refId);
    const found = await search({ embedding: message(30) }, one);
    expect(found.find((i) => i.refId === last.refId)?.lane).toBe('semantic');
    expect(found.filter((i) => i.lane === 'corpus')).toHaveLength(1);
  });

  it('are measured from the founder’s own words, not from what the search’s query adds to them', async () => {
    const away = message(7);
    expect(nearOf(await search({ embedding: message() }, { embedding: away })).map((i) => i.refId)).toContain(
      note,
    );
    expect(nearOf(await search({ embedding: away }, { embedding: message() }))).toEqual([]);
  });

  it('are compared with a vector of their own model only, or with the one being replaced', async () => {
    const id = await place(libraryUri, 4, at(0.9, 20), COHERE);
    expect(nearOf(await search({}, { embedding: message(20) }))).toEqual([]);
    const both = message(20);
    tagAlternate(both, { embedding: at(1, 20), modelId: COHERE });
    expect(nearOf(await search({}, { embedding: both })).map((i) => i.refId)).toEqual([id]);
    // Also when the founder's own vector is another one than the search's.
    expect(nearOf(await search({ embedding: both }, { embedding: message(7) })).map((i) => i.refId)).toEqual([
      id,
    ]);
    // A model without a floor of its own admits none.
    expect(nearOf(await search({}, { embedding: message(0, 'mock-embeddings') }))).toEqual([]);
  });

  it('say whether their source was evidence in this conversation, and it is repeated only as the best answer', async () => {
    const ventureId = seed.ventures.find((v) => v.key === 'quietquad')?.id ?? '';
    const sources = await t.db.system((sx) =>
      sx.query(
        `SELECT s.id, s.scope, c.id AS chunk FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         WHERE c.id = ANY (:ids)`,
        { ids: p.uuidArray([note, reference]) },
      ),
    );
    const sessionId = await t.db.withContext(makeContext(founder, seed.tenantId), async (tx) => {
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, ventureId);
      if (!resolved?.release) throw new Error('assignment missing');
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release.id,
        startedBy: founder,
        mode: 'coach',
        privacy: 'standard',
        policyVersion: 'test',
      });
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId,
        sessionId: session.id,
        authorId: founder,
        mode: 'coach',
        founderText: ASK,
      });
      await turnsRepo.insertTurnEvidence(
        tx,
        turn.id,
        sources.rows.map((r, i) => ({
          key: `E${String(i + 1)}`,
          kind: 'chunk' as const,
          refId: String(r.chunk),
          score: 0.5,
          title: 'Shown',
          source: { id: String(r.id), scope: 'public' as const },
        })),
      );
      return session.id;
    });
    const found = await search({ sessionId });
    expect(new Map(nearOf(found).map((i) => [i.refId, i.near?.shownBefore]))).toEqual(
      new Map([
        [note, true],
        [curriculum, false],
        [reference, true],
      ]),
    );
    expect(shown(found)).toEqual([note]);
    expect(shown(await search({ sessionId: null }))).toEqual([note, reference]);
  });

  it('are read by the search’s own statement: no round trip of their own', async () => {
    const counted = async (semantic: Partial<retrievalRepo.SemanticQuery> | null) => {
      let statements = 0;
      await search(semantic, {}, (tx) => ({
        ...tx,
        query: (sql: string, params?: Parameters<typeof tx.query>[1]) => {
          statements += 1;
          return tx.query(sql, params);
        },
      }));
      return statements;
    };
    expect(await counted(null)).toBe(1);
    expect(await counted({})).toBe(1);
    expect(await counted({ embedding: message(7) })).toBe(1);
  });
});

describe('isolation', () => {
  it('never reaches another tenant’s notes, a venture’s documents or another persona’s library', async () => {
    const other = await t.db.system(async (sx) => {
      const tenant = await sx.query(
        `INSERT INTO tenants (slug, name, kind) VALUES ('near-other', 'Other', 'partner') RETURNING id`,
      );
      const tenantId = String(tenant.rows[0]?.id);
      const rows: string[] = [];
      const add = async (
        source: Parameters<typeof knowledgeRepo.createKnowledgeSource>[1],
        content: string,
      ) => {
        const s = await knowledgeRepo.createKnowledgeSource(sx, source);
        const ids = await knowledgeRepo.insertChunks(sx, {
          sourceId: s.id,
          tenantId: source.tenantId,
          scope: source.scope,
          ...(source.ventureId === undefined ? {} : { ventureId: source.ventureId }),
          chunks: [{ ordinal: 1, heading: null, content, embedding: tagEmbedding(at(0.99), TITAN) }],
        });
        rows.push(
          ...(
            await sx.query('SELECT id FROM knowledge_chunks WHERE source_id = :s', { s: p.uuid(s.id) })
          ).rows.map((r) => String(r.id)),
        );
        return ids;
      };
      await add(
        { tenantId, scope: 'public', title: 'Theirs', uri: 'library:theirs', classification: 'public' },
        'Their own note.',
      );
      const b = seed.ventures.find((v) => v.key === 'benchtally');
      await add(
        {
          tenantId: seed.tenantId,
          scope: 'venture',
          ventureId: b?.id ?? '',
          title: 'Secret',
          uri: 'library:secret',
          createdBy: b?.members[0]?.principalId ?? '',
        },
        'Another venture’s plan.',
      );
      await sx.query(`UPDATE knowledge_chunks SET embedding_model = :m WHERE id = ANY (:ids)`, {
        m: p.text(TITAN),
        ids: p.uuidArray(rows),
      });
      return { tenantId, rows };
    });
    expect(other.rows).toHaveLength(2);
    const found = (await search({})).map((i) => i.refId);
    for (const id of other.rows) expect(found).not.toContain(id);
    // The statement's own filters hold without row-level security too.
    const asSystem = await t.db.system((sx) =>
      retrievalRepo.searchSharedChunks(sx, {
        tenantId: seed.tenantId,
        personaId,
        query: ASK,
        embedding: message(),
        semantic: { asks: 'ask', channel: 'text', embedding: message() },
      }),
    );
    expect(asSystem.map((i) => i.refId)).toContain(note);
    for (const id of other.rows) expect(asSystem.map((i) => i.refId)).not.toContain(id);
    // Nor when the service names the other tenant: the founder's row-level security holds.
    const theirs = await t.db.withContext(makeContext(founder, seed.tenantId), (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: other.tenantId,
        query: ASK,
        embedding: message(),
        semantic: { asks: 'ask', channel: 'text', embedding: message() },
      }),
    );
    expect(theirs).toEqual([]);
  });

  it('keeps to the assignment’s data class, and to sources nobody withdrew', async () => {
    const open = nearOf(await search({}, { classifications: ['synthetic', 'public'] })).map((i) => i.refId);
    expect(open).toContain(note);
    expect(open).not.toContain(curriculum);
    const status = (to: string) =>
      t.db.system((sx) =>
        sx.query(`UPDATE knowledge_sources SET status = :to WHERE uri = :uri AND tenant_id = :t`, {
          to: p.text(to),
          uri: p.text(libraryUri),
          t: p.uuid(seed.tenantId),
        }),
      );
    await status('withdrawn');
    expect(nearOf(await search({})).map((i) => i.refId)).not.toContain(note);
    await status('active');
    expect(nearOf(await search({})).map((i) => i.refId)).toContain(note);
  });
});
