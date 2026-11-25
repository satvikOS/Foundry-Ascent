/** What retrieval decides without a database: courtesy, the query cache, the rerank hook, the play as evidence. */
import { type Play, type PlaySource } from '@foundry/contracts';
import { type retrievalRepo } from '@foundry/db';
import { describe, expect, it, vi } from 'vitest';

import { buildEvidencePack, playEvidenceItem, playRefId } from './evidence.js';
import { isSocialMessage, QueryEmbeddingCache, queryEmbeddingCache } from './query-embeddings.js';
import { rerankItems, type EvidenceReranker } from './retrieval.js';

let n = 0;
function passage(
  title: string,
  lane?: retrievalRepo.SharedLane,
  extra: Partial<retrievalRepo.RetrievedItem> = {},
): retrievalRepo.RetrievedItem {
  n += 1;
  return {
    kind: 'chunk',
    refId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title,
    excerpt: `${title}: text ${String(n)}`,
    score: 0.5,
    freshnessAt: null,
    status: 'active',
    ventureId: null,
    sourceId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sourceScope: 'program',
    memoryType: null,
    visibility: null,
    ...(lane === undefined ? {} : { lane }),
    components: { vector: 0, lexical: 0, recency: 0, authority: 0 },
    ...extra,
  };
}
const none = { memory: [], chunks: [], shared: [], resources: [], patterns: [] };

const PLAY: Pick<Play, 'id' | 'title' | 'answer' | 'why' | 'citations'> = {
  id: 'run-problem-interviews',
  title: 'Run five problem interviews',
  answer: 'Talk to five people who had the problem last month, before you build anything.',
  why: 'What people did is evidence; what they say they would do is not.',
  citations: [
    { sourceId: 'mom-test', locator: 'Chapter 1' },
    { sourceId: 'unknown-source', locator: null },
    { sourceId: 'ain-curriculum', locator: 'Module 2, Unit 1' },
  ],
};
const SOURCES: PlaySource[] = [
  {
    id: 'mom-test',
    kind: 'book',
    title: 'The Mom Test',
    authors: 'Rob Fitzpatrick',
    year: 2013,
    url: 'https://example.org/b',
  },
  {
    id: 'ain-curriculum',
    kind: 'programme',
    title: 'Curriculum',
    authors: 'Ain Center',
    year: null,
    url: null,
  },
];

describe('the play as evidence', () => {
  it('is the first item, kept out of every limit, with the sources it cites', () => {
    const pack = buildEvidencePack(
      {
        ...none,
        shared: [
          passage('Cited note', 'pinned'),
          passage('Library one', 'core'),
          passage('Library two', 'core'),
        ],
      },
      null,
      { play: { play: PLAY, sources: SOURCES }, limits: { shared: 3 }, coreLimit: 1 },
    );
    expect(pack.items.map((k) => [k.item.key, k.item.title])).toEqual([
      ['E1', 'Playbook: Run five problem interviews'],
      ['E2', 'Cited note'],
      ['E3', 'Library one'],
    ]);
    expect(pack.playKeys).toEqual(['E1', 'E2']);
    expect(pack.counts.shared).toBe(2);
    const item = pack.items[0]?.item;
    expect(item).toMatchObject({ kind: 'doctrine', refId: playRefId(PLAY.id), source: null, score: 1 });
    expect(item?.excerpt).toContain(PLAY.answer);
    expect(item?.excerpt).toContain(PLAY.why);
    expect(item?.citation).toEqual({
      kind: 'play',
      locator: 'Chapter 1',
      url: 'https://example.org/b',
      licence: null,
      attribution: null,
      sources: [
        {
          title: 'The Mom Test (2013)',
          authors: 'Rob Fitzpatrick',
          locator: 'Chapter 1',
          url: 'https://example.org/b',
        },
        { title: 'Curriculum', authors: 'Ain Center', locator: 'Module 2, Unit 1', url: null },
      ],
    });
  });

  it('is named by its id alone, and absent without a play', () => {
    expect(playRefId('a-play')).toBe(playRefId('a-play'));
    expect(playRefId('a-play')).not.toBe(playRefId('b-play'));
    expect(playEvidenceItem({ play: PLAY, sources: [] }, 'E1').citation?.sources).toEqual([]);
    const pack = buildEvidencePack({ ...none, shared: [passage('Only', 'core')] }, null);
    expect(pack.playKeys).toEqual([]);
    expect(pack.items.map((k) => k.item.key)).toEqual(['E1']);
  });

  it('carries where a passage can be checked, and null where its source records nothing', () => {
    const citation = {
      locator: 'Section 2',
      url: 'https://www.sba.gov/x',
      licence: 'Public domain',
      attribution: 'SBA',
    };
    const pack = buildEvidencePack(
      { ...none, shared: [passage('Cited', 'corpus', { citation }), passage('Plain', 'core')] },
      null,
    );
    expect(pack.items[0]?.item.citation).toEqual({ kind: 'passage', ...citation, sources: [] });
    expect(pack.items[1]?.item.citation).toBeNull();
  });

  it('gives a passage the coach’s own slots only up to their limit, and the rest theirs', () => {
    const shared = [
      passage('Core 1', 'core'),
      passage('Core 2', 'core'),
      passage('Core 3', 'core'),
      passage('Note', 'corpus'),
      passage('Reference', 'reference', { sourceScope: 'public' }),
    ];
    const pack = buildEvidencePack({ ...none, shared }, null, { limits: { shared: 5 }, coreLimit: 2 });
    expect(pack.items.map((k) => k.item.title)).toEqual(['Core 1', 'Core 2', 'Note', 'Reference']);
  });
});

describe('what of an item a turn shows', () => {
  const long = `${'Opening words of a passage that says little. '.repeat(12)}The pilot price goes in the letter. ${'More of it. '.repeat(60)}`;

  it('is its sentences about the message; a reference’s opening, with its limits; the play’s note for the play', () => {
    const limits = `Evidence limits: one study. ${long}`;
    const pack = buildEvidencePack(
      {
        ...none,
        shared: [
          passage('Pinned', 'pinned', { excerpt: `${long} Talk to five people before you build.` }),
          passage('Core', 'core', {
            excerpt: `${'Handbook chapters describe stages in order. '.repeat(12)}The pilot price goes in the letter. ${'Further chapters follow. '.repeat(30)}`,
          }),
          passage('Reference', 'reference', { excerpt: limits, sourceScope: 'public' }),
        ],
      },
      null,
      { play: { play: PLAY, sources: [] }, query: 'where does the pilot price go?' },
    );
    const [play, pinned, core, reference] = pack.items.map((k) => k.item.excerpt);
    expect(play).toContain(PLAY.why);
    expect(pinned).toContain('Talk to five people before you build.');
    expect(core).toContain('The pilot price goes in the letter.');
    expect(core?.length).toBeLessThanOrEqual(350);
    expect(reference?.startsWith('Evidence limits: one study. Opening words')).toBe(true);
    expect(reference).toHaveLength(600);
  });
});

describe('a message that is only courtesy', () => {
  it('is a greeting, thanks or a goodbye and nothing else', () => {
    for (const text of [
      'Hi Thomas!',
      'hello',
      'Thanks so much, talk to you tomorrow',
      'good morning',
      'thank you, bye',
    ])
      expect(isSocialMessage(text), text).toBe(true);
    for (const text of [
      'ok',
      'yes',
      'sure',
      'Hi, should I form an LLC?',
      'thanks, the second one',
      'hello I need help',
      'Good morning, the pilot starts',
      'thanks 50%',
      '',
    ])
      expect(isSocialMessage(text), text).toBe(false);
  });
});

describe('the query embedding cache', () => {
  it('finds the same words again, and forgets the least recently used first', () => {
    const cache = new QueryEmbeddingCache(2);
    cache.set('What should I do next?', [1]);
    cache.set('b', [2]);
    expect(cache.get('  what should I do   next? ')).toEqual([1]);
    cache.set('c', [3]);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('What should I do next?')).toEqual([1]);
    expect(cache.get('c')).toEqual([3]);
    expect(cache.size).toBe(2);
  });

  it('is one per gateway, so another model’s vectors are never mixed in', () => {
    const a = {};
    queryEmbeddingCache(a).set('x', [1]);
    expect(queryEmbeddingCache(a).get('x')).toEqual([1]);
    expect(queryEmbeddingCache({}).get('x')).toBeNull();
  });
});

describe('the rerank hook', () => {
  const items = [passage('A', 'core'), passage('B', 'core'), passage('C', 'pinned')];
  const titles = async (reranker: EvidenceReranker) =>
    (await rerankItems(reranker, 'q', items)).map((i) => i.title);

  it('orders by the model’s scores, what the play cites first', async () => {
    expect(
      await titles({ id: 'm', timeoutMs: 1_000, rerank: () => Promise.resolve([0.1, 0.9, 0.2]) }),
    ).toEqual(['C', 'B', 'A']);
  });

  it('leaves the fused order on failure, lateness or a malformed answer', async () => {
    const fused = ['A', 'B', 'C'];
    expect(
      await titles({ id: 'm', timeoutMs: 1_000, rerank: () => Promise.reject(new Error('down')) }),
    ).toEqual(fused);
    expect(await titles({ id: 'm', timeoutMs: 1_000, rerank: () => Promise.resolve([1]) })).toEqual(fused);
    expect(await titles({ id: 'm', timeoutMs: 1_000, rerank: () => Promise.resolve([1, NaN, 2]) })).toEqual(
      fused,
    );
    const aborted = vi.fn();
    expect(
      await titles({
        id: 'm',
        timeoutMs: 5,
        rerank: (_q, _t, { signal }) =>
          new Promise(() => {
            signal.addEventListener('abort', aborted);
          }),
      }),
    ).toEqual(fused);
    expect(aborted).toHaveBeenCalledOnce();
  });
});
