/** What retrieval decides without a database: courtesy, the query cache, the rerank hook, the play as evidence. */
import { type Play, type PlaySource } from '@foundry/contracts';
import { retrievalRepo, tagEmbedding } from '@foundry/db';
import { describe, expect, it, vi } from 'vitest';

import { buildEvidencePack, playEvidenceItem, playRefId } from './evidence.js';
import { isSocialMessage, QueryEmbeddingCache, queryEmbeddingCache } from './query-embeddings.js';
import {
  asksOf,
  packEvidence,
  rerankScores,
  type EvidenceReranker,
  type RetrievalArgs,
} from './retrieval.js';

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

describe('whether a turn asks something a shared note may answer', () => {
  const decision = (over: Partial<Parameters<typeof asksOf>[0]>) =>
    ({ kind: 'coaching', open: null, intent: null, overview: false, ...over }) as Parameters<
      typeof asksOf
    >[0];
  const ask = 'How do I price a pilot?';

  it('is never a social, crisis, rehearsal or recall turn, news, another idea, or the path itself', () => {
    for (const kind of ['social', 'crisis', 'rehearsal', 'recall', 'news', 'new_idea'] as const)
      expect(asksOf(decision({ kind, open: 'ask', intent: 'pricing' }), ask), kind).toBeNull();
    expect(asksOf(decision({ overview: true, intent: 'overview' }), 'help me get organized')).toBeNull();
  });

  it('is plain when the message asks, and guarded when it only may', () => {
    expect(asksOf(decision({}), ask)).toBe('ask');
    expect(asksOf(decision({ open: 'ask' }), 'cheapest way to check')).toBe('ask');
    expect(asksOf(decision({ intent: 'pricing' }), 'pilot price')).toBe('ask');
    expect(asksOf(decision({ open: 'guarded' }), 'they loved it then ghosted us')).toBe('guarded');
    expect(asksOf(decision({}), 'they loved it then ghosted us')).toBeNull();
    expect(asksOf(decision({ kind: 'report' }), 'I did three interviews.')).toBeNull();
    expect(asksOf(decision({ kind: 'report' }), 'I did three interviews. What do I write down?')).toBe(
      'guarded',
    );
  });
});

/** A note near the founder's words. */
function near(
  title: string,
  similarity: number,
  extra: Partial<retrievalRepo.RetrievedItem> & {
    family?: retrievalRepo.NoteFamily;
    shownBefore?: boolean;
  } = {},
): retrievalRepo.RetrievedItem {
  const { family = 'note', shownBefore = false, ...rest } = extra;
  return passage(title, 'semantic', { near: { similarity, family, shownBefore }, ...rest });
}

const RULE: retrievalRepo.SemanticRule = {
  floor: 0.3,
  relative: 0.8,
  limit: 2,
  room: 4,
  references: 1,
  rerankCandidates: 8,
  rerankScore: 0.5,
};
const admitted = (
  items: readonly retrievalRepo.RetrievedItem[],
  rule: Partial<retrievalRepo.SemanticRule> = {},
  scores: ReadonlyMap<string, number> | null = null,
) => retrievalRepo.admitSemantic(items, { ...RULE, ...rule }, scores).map((i) => i.title);

describe('which notes near the founder’s words are shown', () => {
  it('are those at the floor and about as near as the nearest, at most the limit, the nearest first', () => {
    expect(admitted([near('C', 0.39), near('A', 0.5), near('B', 0.45)])).toEqual(['A', 'B']);
    expect(admitted([near('A', 0.5), near('B', 0.39)])).toEqual(['A']);
    expect(admitted([near('A', 0.29)])).toEqual([]);
    expect(admitted([near('A', 0.5), near('B', 0.49), near('C', 0.48)], { limit: 3 })).toHaveLength(3);
  });

  it('never replace what the gates bring, and fill only the room they leave', () => {
    const gates = [
      passage('P', 'pinned'),
      passage('T', 'corpus'),
      passage('R', 'reference'),
      passage('L', 'core'),
    ];
    expect(admitted([...gates, near('A', 0.5), near('B', 0.49)])).toEqual(['P', 'T', 'R', 'L', 'A']);
    expect(admitted([...gates, near('A', 0.5)], { room: 3 })).toEqual(['P', 'T', 'R', 'L']);
  });

  it('are measured against the nearest note of all, also one a gate brought', () => {
    const gate = passage('T', 'corpus', { near: { similarity: 0.6, family: 'note', shownBefore: false } });
    expect(admitted([gate, near('A', 0.4)])).toEqual(['T']);
    expect(admitted([near('A', 0.4)])).toEqual(['A']);
  });

  it('repeat no source of the conversation or the turn unless it is the best answer', () => {
    expect(admitted([near('A', 0.5), near('B', 0.49, { shownBefore: true })])).toEqual(['A']);
    expect(admitted([near('A', 0.5, { shownBefore: true }), near('B', 0.49)])).toEqual(['A', 'B']);
    const sourceId = '10000000-0000-4000-8000-00000000aaaa';
    const topical = passage('T', 'corpus', { sourceId });
    expect(admitted([topical, near('A', 0.5), near('B', 0.49, { sourceId })])).toEqual(['T', 'A']);
    expect(admitted([topical, near('B', 0.5, { sourceId })])).toEqual(['T', 'B']);
  });

  it('hold one item of the reference library, the gate’s counted, and a passage on the course only as the best', () => {
    const references = [near('R1', 0.5, { family: 'reference' }), near('R2', 0.49, { family: 'reference' })];
    expect(admitted([...references, near('A', 0.45)])).toEqual(['R1', 'A']);
    expect(admitted([passage('G', 'reference'), ...references])).toEqual(['G']);
    expect(admitted([near('A', 0.5), near('K', 0.49, { family: 'curriculum' })])).toEqual(['A']);
    expect(admitted([near('K', 0.5, { family: 'curriculum' }), near('A', 0.49)])).toEqual(['K', 'A']);
  });

  it('are the reranker’s when it answered: by its scores alone, whatever their similarity', () => {
    const items = [near('A', 0.5), near('B', 0.2), near('C', 0.45)];
    const scores = new Map(items.map((i, n) => [i.refId, [0.1, 0.9, 0.6][n] ?? 0]));
    expect(admitted(items, {}, scores)).toEqual(['B', 'C']);
    expect(admitted(items, { rerankScore: 0.95 }, scores)).toEqual([]);
  });

  it('come from a model’s own floor, higher for a message that only may ask, and from none for another model', () => {
    const titan = tagEmbedding([1], 'us.amazon.titan-embed-text-v2:0');
    const floor = (asks: 'ask' | 'guarded', embedding: readonly number[]) =>
      retrievalRepo.semanticRule({ asks, channel: 'text', embedding }).floor;
    const admit = retrievalRepo.EMBEDDING_PROFILES['amazon.titan-embed-text-v2:0']?.admit ?? 0;
    expect(floor('ask', titan)).toBe(admit);
    expect(floor('guarded', titan)).toBeCloseTo(admit + retrievalRepo.SEMANTIC_ADMISSION.guard, 9);
    for (const model of ['mock-embeddings', 'amazon.nova-2-multimodal-embeddings-v1:0', 'some-model'])
      expect(floor('ask', tagEmbedding([1], model)), model).toBeGreaterThan(1);
    expect(floor('ask', [1])).toBeGreaterThan(1);
    const call = retrievalRepo.semanticRule({ asks: 'ask', channel: 'voice', embedding: titan });
    expect([call.limit, call.room]).toEqual([1, 3]);
    expect(
      retrievalRepo.semanticRule(
        { asks: 'ask', channel: 'text', embedding: titan },
        { semantic: { floor: 0.34, relative: 0.6, limit: 1 } },
      ),
    ).toMatchObject({ floor: 0.34, relative: 0.6, limit: 1 });
  });
});

describe('a turn’s evidence', () => {
  const args: RetrievalArgs = {
    tenantId: 't',
    ventureId: null,
    personaId: 'p',
    stage: null,
    query: 'q',
    founderText: 'q',
    embedding: null,
    dataClassCeiling: 'venture_private',
    budgets: { memory: 0, chunks: 0, doctrine: 2, resources: 0, patterns: 0 },
    privateOwnerId: null,
  };
  const titan = tagEmbedding([1], 'amazon.titan-embed-text-v2:0');
  const found = {
    ...none,
    shared: [
      near('A', 0.5),
      passage('L1', 'core'),
      passage('L2', 'core'),
      passage('T1', 'corpus'),
      passage('T2', 'corpus'),
      near('B', 0.49, { family: 'reference', sourceScope: 'public' }),
    ],
  };
  const titles = (extra: Partial<RetrievalArgs>) =>
    packEvidence(found, { ...args, ...extra }).items.map((k) => k.item.title);

  it('holds the admitted notes beside everything the gates bring, and none on a turn that asks nothing', () => {
    expect(titles({ semantic: { asks: 'ask', embedding: titan } })).toEqual([
      'A',
      'L1',
      'L2',
      'T1',
      'T2',
      'B',
    ]);
    expect(titles({ semantic: { asks: 'ask', embedding: titan }, channel: 'voice' })).not.toContain('B');
  });

  it('shows of a reference note its opening, with its evidence limits, as the gate’s are', () => {
    const limits = `Evidence limits: one study. ${'Words about something else. '.repeat(40)}`;
    const pack = packEvidence(
      { ...none, shared: [near('B', 0.5, { family: 'reference', excerpt: limits })] },
      { ...args, query: 'something else', semantic: { asks: 'ask', embedding: titan } },
    );
    expect(pack.items[0]?.item.excerpt.startsWith('Evidence limits: one study.')).toBe(true);
  });
});

describe('the reranker', () => {
  const shared = [near('A', 0.5), passage('L', 'core'), near('B', 0.2)];
  const scores = async (reranker: EvidenceReranker, items = shared) => {
    const out = await rerankScores(reranker, 'q', { shared: items });
    return out === null
      ? null
      : items.flatMap((i) => (out.has(i.refId) ? [[i.title, out.get(i.refId)]] : []));
  };

  it('reads the notes near the founder’s words, and nothing else', async () => {
    const rerank = vi.fn(() => Promise.resolve([0.1, 0.9]));
    expect(await scores({ id: 'm', timeoutMs: 1_000, rerank })).toEqual([
      ['A', 0.1],
      ['B', 0.9],
    ]);
    expect(rerank.mock.calls[0]?.slice(0, 2)).toEqual([
      'q',
      [shared[0], shared[2]].map((i) => `${i?.title ?? ''}\n${i?.excerpt ?? ''}`),
    ]);
    rerank.mockClear();
    expect(await scores({ id: 'm', timeoutMs: 1_000, rerank }, [passage('L', 'core')])).toBeNull();
    expect(rerank).not.toHaveBeenCalled();
  });

  it('leaves the choice to the similarity on failure, lateness or a malformed answer', async () => {
    const answers = [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve([1]),
      () => Promise.resolve([1, NaN]),
    ];
    for (const rerank of answers) expect(await scores({ id: 'm', timeoutMs: 1_000, rerank })).toBeNull();
    const aborted = vi.fn();
    expect(
      await scores({
        id: 'm',
        timeoutMs: 5,
        rerank: (_q, _t, { signal }) =>
          new Promise(() => {
            signal.addEventListener('abort', aborted);
          }),
      }),
    ).toBeNull();
    expect(aborted).toHaveBeenCalledOnce();
  });
});
