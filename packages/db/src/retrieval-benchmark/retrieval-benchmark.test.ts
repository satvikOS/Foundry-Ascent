import { describe, expect, it } from 'vitest';

import { benchmarkPassages } from './corpus.js';
import { LexicalIndex, contentWords, lexicalOverlap } from './lexical.js';
import { benchmarkQueries, type BenchmarkQuery } from './queries.js';
import { fuse, quality, rankByVector, sampleQueries, selection } from './ranking.js';
import { storableVector } from './store.js';
import { embeddingModelOf, tagEmbedding } from '../embedding-model.js';

const passages = benchmarkPassages();
const queries = benchmarkQueries();
const byId = new Map(passages.map((p) => [p.id, p]));

describe('retrieval benchmark: the corpus', () => {
  it('holds the shared knowledge, each passage once, with text', () => {
    expect(byId.size).toBe(passages.length);
    expect(passages.length).toBeGreaterThan(300);
    for (const p of passages) expect(p.text.trim().length).toBeGreaterThan(40);
    for (const prefix of [
      'skb/framework/',
      'skb/case/',
      'skb/stage/',
      'curriculum/',
      'notes/',
      'open/',
      'method/',
      'doctrine/',
    ]) {
      expect(passages.some((p) => p.id.startsWith(prefix))).toBe(true);
    }
  });
});

describe('retrieval benchmark: a play as a passage', () => {
  it('is titled by the playbook and read as title, answer and why', () => {
    const [play] = benchmarkPassages([{ id: 'p', title: 'T', answer: 'A.', why: 'W.' }]).slice(-1);
    expect(play).toEqual({
      id: 'play/p',
      title: 'Playbook — T',
      source: 'Playbook',
      heading: 'T',
      text: 'A. W.',
      embedText: 'T\n\nA. W.',
      store: 'play',
    });
  });
});

describe('retrieval benchmark: the questions', () => {
  it('has at least 220 with an answer, 60 without, unique ids and no repeated question', () => {
    expect(queries.filter((q) => q.kind === 'answerable').length).toBeGreaterThanOrEqual(220);
    expect(queries.filter((q) => q.kind === 'no_answer').length).toBeGreaterThanOrEqual(60);
    expect(new Set(queries.map((q) => q.id)).size).toBe(queries.length);
    expect(new Set(queries.map((q) => q.query.toLowerCase())).size).toBe(queries.length);
  });

  it('names passages that exist, and never one as both an answer and a hard negative', () => {
    for (const q of queries) {
      // Plays are core's: their ids are checked with the playbook (apps/api lab-models.test.ts).
      for (const id of [...q.expected, ...q.hardNegatives].filter((x) => !x.startsWith('play/')))
        expect([q.id, id, byId.has(id)]).toEqual([q.id, id, true]);
      expect(q.expected.filter((id) => q.hardNegatives.includes(id))).toEqual([]);
    }
    expect(queries.filter((q) => q.hardNegatives.length > 0).length).toBeGreaterThanOrEqual(100);
  });

  it('asks in other words: little of a question is in the passage that answers it', () => {
    const overlaps = queries
      .map((q) => ({ ...q, expected: q.expected.filter((id) => byId.has(id)) }))
      .filter((q) => q.expected.length > 0)
      .map((q) =>
        Math.max(
          ...q.expected.map((id) => lexicalOverlap(q.query, `${byId.get(id)?.title} ${byId.get(id)?.text}`)),
        ),
      )
      .sort((a, b) => a - b);
    expect(overlaps[Math.floor(overlaps.length / 2)]).toBeLessThanOrEqual(0.35);
    expect(overlaps[Math.floor(overlaps.length * 0.9)]).toBeLessThanOrEqual(0.6);
  });

  it('is hard for a word search (the point of paraphrasing)', () => {
    const index = new LexicalIndex(passages);
    const ranked = new Map(queries.map((q) => [q.id, index.search(q.query)]));
    const result = quality(queries, ranked, { scoresMeanRelevance: true });
    expect(result.recallAt1).toBeGreaterThan(0.1);
    expect(result.recallAt1).toBeLessThan(0.6);
  });
});

describe('retrieval benchmark: the ranking', () => {
  it('stems the same word in two forms to one, and leaves out URLs and stopwords', () => {
    expect(contentWords('Pricing the pilots? See https://example.org/pricing')).toEqual([
      'pric',
      'pilot',
      'see',
    ]);
    expect(contentWords('priced stopped companies')).toEqual(['pric', 'stop', 'company']);
  });

  it('ranks by cosine whatever the length of the vectors', () => {
    const ranked = rankByVector(
      [1, 0],
      [
        { id: 'far', vector: [0, 9] },
        { id: 'near', vector: [5, 0.1] },
      ],
    );
    expect(ranked.map((r) => r.id)).toEqual(['near', 'far']);
    expect(ranked[0]?.score).toBeCloseTo(1, 3);
  });

  it('fuses two rankings by rank, not by score', () => {
    const fused = fuse([
      [
        { id: 'a', score: 900 },
        { id: 'b', score: 800 },
      ],
      [
        { id: 'b', score: 0.2 },
        { id: 'c', score: 0.1 },
      ],
    ]);
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });

  it('measures recall, reciprocal rank, hard negatives and what nothing answers', () => {
    const q = (id: string, expected: string[], hardNegatives: string[] = []): BenchmarkQuery => ({
      id,
      kind: expected.length > 0 ? 'answerable' : 'no_answer',
      query: 'a question of this test',
      expected,
      hardNegatives,
    });
    const set = [q('RB-001', ['a']), q('RB-002', ['b'], ['x']), q('RB-003', ['z']), q('RB-004', [])];
    const rankings = new Map([
      ['RB-001', [{ id: 'a', score: 0.9 }]],
      [
        'RB-002',
        [
          { id: 'x', score: 0.8 },
          { id: 'b', score: 0.7 },
        ],
      ],
      ['RB-004', [{ id: 'a', score: 0.1 }]],
    ]);
    expect(quality(set, rankings, { scoresMeanRelevance: true })).toEqual({
      answerable: 3,
      noAnswer: 1,
      recallAt1: 0.333,
      recallAt3: 0.667,
      recallAt5: 0.667,
      recallAt20: 0.667,
      mrr: 0.5,
      hardNegativeFirst: 0.333,
      // RB-003 found nothing (score 0): below the unanswerable question's 0.1.
      noAnswerAuc: 0.667,
      noAnswerCaught: 0,
    });
    expect(quality(set, rankings, { scoresMeanRelevance: false }).noAnswerAuc).toBeNull();
    expect(quality([], new Map(), { scoresMeanRelevance: true }).mrr).toBe(0);
  });

  it('measures what a search that may return nothing returned', () => {
    const q = (id: string, expected: string[]): BenchmarkQuery => ({
      id,
      kind: expected.length > 0 ? 'answerable' : 'no_answer',
      query: 'a question of this test',
      expected,
      hardNegatives: [],
    });
    const set = [
      q('RB-001', ['a']),
      q('RB-002', ['b']),
      q('RB-003', ['c']),
      q('RB-004', []),
      q('RB-005', []),
    ];
    const returned = new Map([
      ['RB-001', [{ id: 'a' }, { id: 'x' }, { id: 'a2' }]],
      ['RB-002', [{ id: 'x' }, { id: 'y' }, { id: 'b' }]],
      ['RB-004', [{ id: 'x' }]],
    ]);
    expect(selection(set, returned, 2)).toEqual({
      recall: 0.333,
      precision: 0.25,
      perQuery: 1.333,
      answerableEmpty: 0.333,
      noAnswerEmpty: 0.5,
      perNoAnswer: 0.5,
    });
    expect(selection([], new Map(), 3).precision).toBe(0);
  });

  it('pads a smaller model’s vector to the stored column, keeping its model and its cosines', () => {
    const stored = storableVector([0.6, 0.8], 'some-model');
    expect(stored).toHaveLength(1024);
    expect(embeddingModelOf(stored)).toBe('some-model');
    expect(embeddingModelOf(storableVector(tagEmbedding([1], 'its-own'), 'other'))).toBe('its-own');
    expect(() => storableVector(new Array<number>(1025).fill(0), 'm')).toThrow('1024');
  });

  it('samples the same questions every time, both kinds in proportion', () => {
    const sample = sampleQueries(queries, 40);
    expect(sample).toHaveLength(40);
    expect(sample).toEqual(sampleQueries(queries, 40));
    expect(new Set(sample.map((s) => s.id)).size).toBe(40);
    const unanswerable = sample.filter((s) => s.kind === 'no_answer').length;
    expect(unanswerable).toBeGreaterThanOrEqual(5);
    expect(unanswerable).toBeLessThanOrEqual(9);
    expect(sampleQueries(queries, 10_000)).toHaveLength(queries.length);
  });
});
