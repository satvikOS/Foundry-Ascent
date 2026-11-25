/** The models benchmark's measure of production's own search, on a seeded database and hashed embeddings. */
import { hashEmbedding } from '@foundry/ai';
import { PLAYBOOK } from '@foundry/core';
import { retrievalRepo } from '@foundry/db';
import { benchmarkPassages, benchmarkQueries } from '@foundry/db/retrieval-benchmark';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mockClients, runModelsBenchmark } from './lab-models.js';
import {
  askable,
  benchSearch,
  calibrate,
  extraTexts,
  FAMILY_NAMES,
  FLOOR_NAMES,
  FUSION_NAMES,
  isAmbiguous,
  openRetrievalStore,
  type EmbeddedCorpus,
  type RetrievalStore,
} from './lab-retrieval.js';

const TITAN = 'amazon.titan-embed-text-v2:0';
const passages = benchmarkPassages(PLAYBOOK.plays);
// A slice of both kinds: the whole benchmark is the lab's.
const queries = benchmarkQueries().filter((_, i) => i % 6 === 0);
let t: TestDatabase;
let store: RetrievalStore;

const embedded: EmbeddedCorpus = {
  modelId: TITAN,
  dimensions: 256,
  passages: new Map(passages.map((p) => [p.id, hashEmbedding(p.embedText, 256)])),
  queries: new Map(queries.map((q) => [q.id, hashEmbedding(q.query, 256)])),
};

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  store = await openRetrievalStore(t.db, { passages, queries }, 'ain');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('production’s search, measured', () => {
  it('measures every weight, floor and family, and prints numbers and fixed names only', async () => {
    const extras = new Map(extraTexts(store).map((x) => [x.id, hashEmbedding(x.text, 256)]));
    const { result, candidates, kept } = await benchSearch(store, embedded, extras);
    expect(Object.keys(result.ranking).sort()).toEqual([...FUSION_NAMES].sort());
    expect(Object.keys(result.floors)).toEqual([...FLOOR_NAMES]);
    expect(Object.keys(result.production.families)).toEqual([...FAMILY_NAMES]);
    const answerable = queries.filter((q) => q.kind === 'answerable').length;
    for (const name of FUSION_NAMES) expect(result.ranking[name].answerable).toBe(answerable);
    // Floors off every question is ranked; floors are passed to the search too.
    for (const ranked of candidates.values()) expect(ranked.length).toBe(20);
    expect(JSON.stringify(result.floors.strict)).not.toBe(JSON.stringify(result.floors.current));
    // The weights are what differs between the rankings: they are passed to the search.
    expect(JSON.stringify(result.ranking.vector)).not.toBe(JSON.stringify(result.ranking.rrf_1));
    // A turn's evidence holds the play the path's rules choose, and more of it than retrieval alone.
    expect(result.production.questions).toBe(askable(store).length);
    expect(result.production.pack.recall).toBeGreaterThanOrEqual(result.production.retrieval.current.recall);
    expect(result.production.families.play.questions).toBeGreaterThan(5);
    const printed = JSON.stringify(result);
    for (const q of queries) expect(printed).not.toContain(q.query);
    for (const p of passages) expect(printed).not.toContain(p.text.slice(0, 60));
    expect(Object.keys(kept)).toEqual(['ranking', 'floors', 'pack', 'production']);
  }, 180_000);

  it('is part of the benchmark’s report when it has a database, at production’s size alone', async () => {
    const { report } = await runModelsBenchmark(
      mockClients(),
      {
        reasoning: [],
        embeddings: [{ id: TITAN, dimensions: [256, 1024] }],
        rerankers: [{ id: 'amazon.rerank-v1:0', region: 'us-west-2', usdPerThousandQueries: 1 }],
      },
      { region: 'us-east-1', budgetUsd: 1, requests: 0, structured: 0, rerankQueries: 12, queries },
      { db: t.db, tenantSlug: 'ain' },
    );
    expect(report.search.map((s) => [s.id, s.dimensions])).toEqual([[TITAN, 1024]]);
    expect(report.rerank.base).toEqual({ id: TITAN, dimensions: 1024, by: 'search' });
    const only = report.rerank.models[0]?.ambiguousOnly;
    expect(only?.share).toBeGreaterThan(0);
    expect(only?.usdPerThousandQuestions).toBeCloseTo(only?.share ?? 0, 6);
  }, 240_000);
});

describe('calibration', () => {
  it('says what each floor keeps and catches, and suggests floors from the same numbers', () => {
    const small: EmbeddedCorpus = {
      modelId: 'unknown-model',
      dimensions: 2,
      passages: new Map([
        ['a', [1, 0]],
        ['b', [0, 1]],
      ]),
      queries: new Map([
        ['q', [1, 0.1]],
        ['n', [0.6, 0.6]],
      ]),
    };
    const found = calibrate(
      [
        { id: 'q', kind: 'answerable', query: 'q', expected: ['a'], hardNegatives: ['b'] },
        { id: 'n', kind: 'no_answer', query: 'n', expected: [], hardNegatives: [] },
      ],
      small,
    );
    expect(found.related[1]).toBeCloseTo(0.995, 3);
    expect(found.unrelated[1]).toBeCloseTo(0.707, 3);
    expect(found.curve.at(-1)).toEqual({ floor: 0.7, answered: 1, caught: 0 });
    expect(found.suggested).toEqual({ floor: 0.71, weak: 0.71 });
    expect(found.strict).toEqual({ floor: 0.707, weak: 0.707 });
    expect(found.current).toEqual(retrievalRepo.DEFAULT_EMBEDDING_PROFILE);
  });

  it('calls a ranking ambiguous when its best passage is barely close, or two are about equally close', () => {
    const profile = { floor: 0.3, weak: 0.2 };
    const at = (...cosines: number[]) =>
      cosines.map((vector, i) => ({ id: String(i), score: 1 - i, vector }));
    expect(isAmbiguous(at(0.6, 0.4), profile)).toBe(false);
    expect(isAmbiguous(at(0.35, 0.1), profile)).toBe(true);
    expect(isAmbiguous(at(0.6, 0.59), profile)).toBe(true);
    expect(isAmbiguous([], profile)).toBe(true);
  });
});
