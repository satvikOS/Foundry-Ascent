/** The models benchmark's measure of production's own search, on a seeded database and hashed embeddings. */
import { hashEmbedding } from '@foundry/ai';
import { PLAYBOOK } from '@foundry/core';
import { retrievalRepo } from '@foundry/db';
import { benchmarkPassages, benchmarkQueries, lexicalOverlap } from '@foundry/db/retrieval-benchmark';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMISSION_FLOORS,
  ADMISSION_LIMITS,
  ADMISSION_RELATIVES,
  benchAdmission,
  PLAY_CHOICES,
  RERANK_KEEP_NAMES,
} from './lab-admission.js';
import { mockClients, runModelsBenchmark } from './lab-models.js';
import { productionTurn } from './lab-plays.js';
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
      {
        region: 'us-east-1',
        budgetUsd: 1,
        requests: 0,
        structured: 0,
        rerankQueries: 12,
        admissionReranks: 6,
        queries,
      },
      { db: t.db, tenantSlug: 'ain' },
    );
    expect(report.search.map((s) => [s.id, s.dimensions])).toEqual([[TITAN, 1024]]);
    expect(report.admission.map((a) => [a.id, a.dimensions, a.rerank?.sample])).toEqual([[TITAN, 1024, 6]]);
    expect(report.rerank.base).toEqual({ id: TITAN, dimensions: 1024, by: 'search' });
    const only = report.rerank.models[0]?.ambiguousOnly;
    expect(only?.share).toBeGreaterThan(0);
    expect(only?.usdPerThousandQuestions).toBeCloseTo(only?.share ?? 0, 6);
  }, 240_000);
});

describe('semantic admission, measured', () => {
  /** A play by its phrase alone, and one for every question, so the two ways of choosing differ. */
  const choices = {
    phrase: productionTurn(null, false),
    meaning: (message: string) => ({
      ...productionTurn(null, false)(message),
      playId: PLAYBOOK.plays[0]?.id ?? null,
      asks: 'ask' as const,
    }),
  };
  const overlap = (query: string, texts: readonly string[]) =>
    Promise.resolve(texts.map((t) => lexicalOverlap(query, t)));
  const reranker = { id: 'amazon.rerank-v1:0', sample: 20, score: overlap, failed: () => 'Refused' };

  beforeAll(async () => {
    const extras = new Map(extraTexts(store).map((x) => [x.id, hashEmbedding(x.text, 256)]));
    await benchSearch(store, embedded, extras);
  }, 180_000);

  it('measures every floor, closeness, limit and way of choosing the play in one run, in numbers and names only', async () => {
    const { result, kept } = await benchAdmission(store, embedded, choices, reranker);
    expect(result.questions).toBe(askable(store).length);
    for (const choice of PLAY_CHOICES) {
      const { grid, off, current } = result.plays[choice];
      expect(grid).toHaveLength(
        ADMISSION_FLOORS.length * ADMISSION_RELATIVES.length * ADMISSION_LIMITS.length,
      );
      const at = (floor: number, relative: number, limit: number) => {
        const point = grid.find((g) => g.floor === floor && g.relative === relative && g.limit === limit);
        if (point === undefined) throw new Error('no such point');
        return point.notes;
      };
      // A looser rule shows as much or more, and what it shows differs.
      expect(at(0.22, 0.6, 3).perQuestion).toBeGreaterThan(at(0.34, 0.85, 1).perQuestion);
      expect(at(0.22, 0.6, 3).answerShown).toBeGreaterThanOrEqual(at(0.34, 0.85, 1).answerShown);
      expect(at(0.22, 0.6, 1).perNoAnswer).toBeLessThanOrEqual(at(0.22, 0.6, 3).perNoAnswer);
      for (const floor of ADMISSION_FLOORS)
        expect(at(floor, 0.6, 3).perQuestion).toBeGreaterThanOrEqual(off.notes.perQuestion - 1);
      // The code's constants are one of the points.
      const { floor, relative, limit } = result.current;
      expect(current).toEqual({ notes: at(floor, relative, limit), evidence: current.evidence });
      expect(current.notes.perQuestion).toBeGreaterThan(0);
      for (const row of [off, current])
        expect(row.evidence.answerShown).toBeGreaterThanOrEqual(row.notes.answerShown);
    }
    // The play is evidence, and not a note.
    expect(result.plays.meaning.off.notes.families.play).toBe(0);
    expect(result.plays.meaning.off.evidence.perQuestion).toBeCloseTo(
      result.plays.meaning.off.notes.perQuestion + 1,
      2,
    );
    const printed = JSON.stringify(result);
    for (const q of queries) expect(printed).not.toContain(q.query);
    expect(printed).not.toMatch(/skb\/|RB-/);
    expect(Object.keys(kept)).toHaveLength(result.questions);
  }, 180_000);

  it('asks the reranker a sample only, and a threshold that keeps more answers admits more', async () => {
    let asked = 0;
    const { result } = await benchAdmission(store, embedded, choices, {
      ...reranker,
      score: (query, texts) => {
        asked += 1;
        expect(texts.length).toBeLessThanOrEqual(8);
        return overlap(query, texts);
      },
    });
    const r = result.rerank;
    expect(r?.code).toBeNull();
    expect(asked).toBeLessThanOrEqual(20);
    expect(r?.requests).toBe(asked);
    expect(Object.keys(r?.rows ?? {})).toEqual(RERANK_KEEP_NAMES);
    const rows = r?.rows;
    expect(rows?.keep_95.threshold).toBeLessThanOrEqual(rows?.keep_75.threshold ?? 0);
    expect(rows?.keep_95.notes.perQuestion).toBeGreaterThanOrEqual(rows?.keep_75.notes.perQuestion ?? 9);
  }, 180_000);

  it('reports why a reranker could not be asked, and measures the rest', async () => {
    const refused = await benchAdmission(store, embedded, choices, {
      ...reranker,
      score: () => Promise.reject(new Error('no')),
    });
    expect(refused.result.rerank).toMatchObject({ code: 'Refused', requests: 0 });
    const broke = await benchAdmission(store, embedded, choices, {
      ...reranker,
      score: () => Promise.resolve(null),
    });
    expect(broke.result.rerank?.code).toBe('BudgetReached');
    expect((await benchAdmission(store, embedded, choices, null)).result.rerank).toBeNull();
  }, 180_000);
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
