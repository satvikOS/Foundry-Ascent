/**
 * Retrieval on labelled student questions (retrieval-eval.fixture.ts), locally and deterministically: PostgreSQL's full
 * text search and the gateway's hash embedding stand in for production's, over the seeded shared knowledge (the
 * persona's library, the handbook, the curriculum, the cited corpus, the reference library). It measures what this code
 * decides (admission, floors, fusion, diversity), not an embedding model; the model benchmark is its own
 * (docs/runbooks/embedding-model.md). The scoring of main before it (a weighted sum, no floor) is measured beside it.
 *
 * The hash embedding is lexical: texts are near only when they share words, function words included, so its floors
 * (`EMBEDDING_PROFILES['mock-embeddings']`) admit nothing by the vector alone and the numbers say how words are read. It
 * is biased against a ranking led by the vector: weights are chosen on real embeddings (the models benchmark), never here.
 */
import { hashEmbedding, MOCK_EMBEDDINGS_MODEL_ID } from '@foundry/ai';
import { knowledgeRepo, p, retrievalRepo, tagEmbedding, type SqlExecutor } from '@foundry/db';
import { createTestDatabase, makeContext, type TestDatabase } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RETRIEVAL_EVAL, RETRIEVAL_EVAL_FRESH, type EvalQuery } from './retrieval-eval.fixture.js';

let t: TestDatabase;
let tenantId: string;
let personaId: string;
let founder: string;

const embed = (text: string): number[] => tagEmbedding(hashEmbedding(text), MOCK_EMBEDDINGS_MODEL_ID);

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  const venture = t.seed?.ventures.find((v) => v.key === 'quietquad');
  if (!t.seed || !venture) throw new Error('seed missing');
  tenantId = t.seed.tenantId;
  personaId = venture.personaId;
  founder = venture.members[0]?.principalId ?? '';
  await t.db.system(async (sx) => {
    const backlog = await knowledgeRepo.listChunksMissingEmbeddings(sx, 5_000);
    await knowledgeRepo.setChunkEmbeddings(
      sx,
      backlog.map((b) => ({ id: b.id, embedding: embed(b.text) })),
    );
  });
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

interface Found {
  readonly title: string;
  readonly lane: string;
}

async function now(query: string, vector: boolean): Promise<Found[]> {
  const found = await t.db.withContext(makeContext(founder, tenantId), (tx) =>
    retrievalRepo.searchSharedChunks(tx, {
      tenantId,
      personaId,
      query,
      embedding: vector ? embed(query) : null,
      limit: 2,
      reference: { founderText: query, limit: 2, sessionId: null },
      corpus: { founderText: query },
    }),
  );
  return found.map((f) => ({ title: f.title, lane: f.lane ?? '' }));
}

/** Main before this: 0.55 vector + 0.25 ts_rank_cd + 0.1 recency + 0.1 authority, no floor, two rows (`gated` as it was; else the corpus too). */
async function before(query: string, vector: boolean, gated: boolean): Promise<Found[]> {
  const run = async (ex: SqlExecutor) =>
    ex.query(
      `WITH q AS (SELECT replace(websearch_to_tsquery('english', :query)::text, ' & ', ' | ')::tsquery AS tsq)
       SELECT x.title, 0.55 * x.vec + 0.25 * x.lex + 0.1 * x.recency + 0.1 * x.authority AS score FROM (
         SELECT c.id, CASE WHEN c.heading IS NULL THEN s.title ELSE s.title || ' — ' || c.heading END AS title,
                CASE WHEN :embedding IS NULL THEN 0 ELSE greatest(0, 1 - (c.embedding <=> :embedding)) END AS vec,
                ts_rank_cd(c.tsv, q.tsq, 32) AS lex,
                power(0.5, greatest(0, extract(epoch FROM now() - s.freshness_at)) / (86400.0 * 90)) AS recency,
                CASE c.scope WHEN 'persona' THEN 1.0 WHEN 'program' THEN 0.9 ELSE 0.7 END AS authority
         FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id CROSS JOIN q
         WHERE c.tenant_id = :tenantId AND c.venture_id IS NULL AND (c.scope <> 'persona' OR c.persona_id = :personaId)
           AND CASE WHEN :gated THEN c.scope <> 'public' AND NOT starts_with(coalesce(s.uri, ''), 'curriculum:')
                    ELSE c.scope <> 'public' OR starts_with(coalesce(s.uri, ''), 'library:') END
           AND (c.tsv @@ q.tsq OR :embedding IS NOT NULL)) x
       ORDER BY score DESC, x.id LIMIT 2`,
      {
        query: p.text(query),
        embedding: p.nullable.vector(vector ? embed(query) : null),
        tenantId: p.uuid(tenantId),
        personaId: p.uuid(personaId),
        gated: p.bool(gated),
      },
    );
  const result = await t.db.withContext(makeContext(founder, tenantId), run);
  const rows = result.rows.map((r) => ({ title: String(r.title), lane: 'before' }));
  // The reference gate is main's own, unchanged: its passages came beside those rows.
  return gated ? [...rows, ...(await now(query, vector)).filter((f) => f.lane === 'reference')] : rows;
}

interface Metrics {
  /** Answerable queries with at least one relevant passage. */
  readonly recall: number;
  /** Relevant passages among those returned for answerable queries. */
  readonly precision: number;
  /** Answerable queries whose first passage is relevant. */
  readonly first: number;
  /** No-answer queries that returned nothing. */
  readonly empty: number;
  readonly perQuery: number;
}

const relevant = (q: EvalQuery, f: Found): boolean => q.answers.some((a) => f.title.includes(a));

async function measure(
  queries: readonly EvalQuery[],
  search: (query: string) => Promise<Found[]>,
  misses?: string[],
): Promise<Metrics> {
  let hits = 0;
  let good = 0;
  let shown = 0;
  let first = 0;
  let empty = 0;
  const answerable = queries.filter((q) => q.answers.length > 0);
  const none = queries.filter((q) => q.answers.length === 0);
  for (const q of queries) {
    const found = await search(q.query);
    if (q.answers.length === 0) {
      if (found.length === 0) empty += 1;
      else misses?.push(`NOISE  ${q.query} -> ${found.map((f) => `[${f.lane}] ${f.title}`).join(' | ')}`);
      continue;
    }
    const ok = found.filter((f) => relevant(q, f));
    shown += found.length;
    good += ok.length;
    if (ok.length > 0) hits += 1;
    if (found[0] !== undefined && relevant(q, found[0])) first += 1;
    if (ok.length < Math.max(1, found.length)) {
      misses?.push(
        `${ok.length === 0 ? 'MISS ' : 'MIXED'}  ${q.query} -> ${found.map((f) => `${relevant(q, f) ? '+' : '-'}[${f.lane}] ${f.title}`).join(' | ') || '(nothing)'}`,
      );
    }
  }
  return {
    recall: hits / answerable.length,
    precision: shown === 0 ? 1 : good / shown,
    first: first / answerable.length,
    empty: empty / none.length,
    perQuery: shown / answerable.length,
  };
}

const pct = (m: Metrics): string =>
  `recall ${(100 * m.recall).toFixed(1)} %, precision ${(100 * m.precision).toFixed(1)} %, first ${(100 * m.first).toFixed(1)} %, ` +
  `no-answer empty ${(100 * m.empty).toFixed(1)} %, ${m.perQuery.toFixed(2)} passages per answerable query`;

describe('retrieval on labelled student questions', () => {
  it('is measured on at least 150 questions, at least 30 of which nothing answers', () => {
    expect(RETRIEVAL_EVAL.length).toBeGreaterThanOrEqual(150);
    expect(RETRIEVAL_EVAL.filter((q) => q.answers.length === 0).length).toBeGreaterThanOrEqual(30);
    expect(new Set(RETRIEVAL_EVAL.map((q) => q.query)).size).toBe(RETRIEVAL_EVAL.length);
  });

  it('finds what answers, little else, and nothing when nothing does', async () => {
    const held = RETRIEVAL_EVAL.filter((_, i) => i % 2 === 1);
    const tuned = RETRIEVAL_EVAL.filter((_, i) => i % 2 === 0);
    const misses: string[] = [];
    const rows: [string, Metrics][] = [
      ['main (weighted sum, its own sources)', await measure(RETRIEVAL_EVAL, (q) => before(q, true, true))],
      ['main scoring over the new corpus', await measure(RETRIEVAL_EVAL, (q) => before(q, true, false))],
      ['now', await measure(RETRIEVAL_EVAL, (q) => now(q, true))],
      ['now, lexical only', await measure(RETRIEVAL_EVAL, (q) => now(q, false))],
      ['now, questions never tuned on', await measure(RETRIEVAL_EVAL_FRESH, (q) => now(q, true))],
      ['now, odd half', await measure(held, (q) => now(q, true))],
      ['now, even half', await measure(tuned, (q) => now(q, true), misses)],
    ];
    if (process.env.RETRIEVAL_EVAL_VERBOSE === 'all') await measure(held, (q) => now(q, true), misses);
    process.stdout.write(`\n${rows.map(([name, m]) => `${name.padEnd(40)} ${pct(m)}`).join('\n')}\n`);
    if (process.env.RETRIEVAL_EVAL_VERBOSE !== undefined) process.stdout.write(`${misses.join('\n')}\n`);
    const metrics = Object.fromEntries(rows);
    const expectAtLeast = (name: string, floors: { recall: number; precision: number; first: number }) => {
      const m = metrics[name];
      if (m === undefined) throw new Error(name);
      expect(m.recall, `${name}: recall`).toBeGreaterThanOrEqual(floors.recall);
      expect(m.precision, `${name}: precision`).toBeGreaterThanOrEqual(floors.precision);
      expect(m.first, `${name}: first`).toBeGreaterThanOrEqual(floors.first);
      // "No evidence" is a valid result: nothing above the floor, ever.
      expect(m.empty, `${name}: no-answer`).toBe(1);
    };
    expectAtLeast('now', { recall: 0.97, precision: 0.88, first: 0.92 });
    expectAtLeast('now, lexical only', { recall: 0.97, precision: 0.88, first: 0.92 });
    // Words alone, on questions nobody tuned: a real embedding model has to bring the rest (see the runbook).
    expectAtLeast('now, questions never tuned on', { recall: 0.8, precision: 0.85, first: 0.75 });
    // The check can fail: what main did with the same corpus is well below.
    expect(metrics['main scoring over the new corpus']?.empty).toBe(0);
    expect(metrics['main scoring over the new corpus']?.precision).toBeLessThan(0.7);
  }, 120_000);
});
