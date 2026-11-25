/**
 * A turn's evidence as the coach gets it: the play the path chose and the sources it cites are always there, a passage
 * says where it can be checked, and what the answer cited is kept with it (migration 0034). And the query embedding:
 * not made for courtesy, made once for words already seen, and tagged with the model that made it.
 */
import { MockModelGateway, MOCK_EMBEDDINGS_MODEL_ID } from '@foundry/ai';
import { embeddingModelOf, p, turnsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CORE_CONFIG } from '../config.js';
import { type RequestContext } from '../context.js';
import { resolveDeps } from '../deps.js';
import { Kit } from '../internal/kit.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { EXCERPT_WINDOW_CHARS } from './excerpt.js';
import { embedRetrievalQuery, retrieveEvidence, type RetrievalArgs } from './retrieval.js';

let h: CoreHarness;
let maya: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const PLAY = {
  play: {
    id: 'choose-legal-structure',
    title: 'Choose a legal structure',
    answer: 'Stay a sole proprietor until you sell something someone could sue you over, then form an LLC.',
    why: 'It costs money and paperwork before it protects anything.',
    citations: [
      { sourceId: 'sba-launch', locator: 'Choose a business structure' },
      { sourceId: 'ain-curriculum', locator: 'Module 2, Unit 1' },
    ],
  },
  sources: [
    {
      id: 'sba-launch',
      kind: 'government' as const,
      title: 'Launch your business',
      authors: 'U.S. Small Business Administration',
      year: null,
      url: 'https://www.sba.gov/business-guide/launch-your-business',
    },
  ],
};

async function evidence(founderText: string, extra: Partial<RetrievalArgs> = {}) {
  return h.t.db.withContext(
    { principalId: maya.principalId, tenantId: maya.tenantId, requestId: 'grounded' },
    (tx) =>
      retrieveEvidence(tx, {
        tenantId: maya.tenantId,
        ventureId: h.ventures.quietquad.id,
        personaId: h.ventures.quietquad.personaId,
        stage: 'discovery',
        query: founderText,
        founderText,
        embedding: null,
        dataClassCeiling: 'venture_private',
        budgets: { memory: 8, chunks: 6, doctrine: 2, resources: 4, patterns: 2 },
        privateOwnerId: null,
        ...extra,
      }),
  );
}

describe('the evidence of a turn with a play', () => {
  it('always holds the play and the note of its sources that is about it, whatever the message says', async () => {
    const pack = await evidence('ok lets do that', { play: PLAY });
    expect(pack.items[0]?.item).toMatchObject({
      key: 'E1',
      kind: 'doctrine',
      title: 'Playbook: Choose a legal structure',
    });
    expect(pack.playKeys.length).toBe(2);
    const cited = pack.items.filter((k) => pack.playKeys.slice(1).includes(k.item.key)).map((k) => k.item);
    expect(cited[0]?.title).toMatch(
      /Choose a business structure|Ain Foundry Module 2, Unit 1: Key term: legal/,
    );
    for (const item of cited) expect(item.citation).toMatchObject({ kind: 'passage' });
    expect(pack.items.map((k) => k.item.key)).toEqual(pack.items.map((_, i) => `E${String(i + 1)}`));
  });

  it('pins no note that is not about the play, though the play cites its unit', async () => {
    const pack = await evidence('Tell me my idea is great', {
      play: {
        play: {
          id: 'honest-read',
          title: 'Write how many strangers must pay, then test it',
          answer:
            'I will not call it great, because neither of us knows yet. Great is what strangers show with their money. Its strength is whatever you have seen people do about the problem so far.',
          why: 'Praise feels good and tells you nothing.',
          citations: [{ sourceId: 'ain-foundry', locator: 'Module 3, Unit 2: Networking I' }],
        },
        sources: [],
      },
    });
    expect(pack.playKeys).toEqual(['E1']);
    // The founder's own record may be shown; nothing of the shared library is about "my idea is great".
    expect(pack.items.slice(1).filter((k) => k.item.kind !== 'memory')).toEqual([]);
  });

  it('shows of every other item only the sentences about the message, at most 350 characters', async () => {
    const pack = await evidence('What do we know about exam week and library seats?', { play: PLAY });
    expect(pack.items.length).toBeGreaterThan(2);
    for (const { item } of pack.items.slice(1))
      expect(item.excerpt.length, item.title).toBeLessThanOrEqual(EXCERPT_WINDOW_CHARS);
  });

  it('gives one topic note beside a play, and at most one resource and lesson by default', async () => {
    const notes = (await evidence('Should I raise money or bootstrap?', { play: PLAY })).items.filter(
      (k) => k.item.citation?.kind === 'passage',
    );
    // The play's own note, and one the message asks for.
    expect(notes.length).toBeLessThanOrEqual(2);
    const pack = await evidence('how should I price my first pilot, and is there a workshop on interviews?', {
      budgets: DEFAULT_CORE_CONFIG.retrieval,
    });
    expect(pack.counts.resources).toBeLessThanOrEqual(1);
    expect(pack.counts.patterns).toBeLessThanOrEqual(1);
  });

  it('is the same for the same turn, every time', async () => {
    const keys = async () =>
      (await evidence('Should I form an LLC?', { play: PLAY })).items.map(
        (k) => `${k.item.key}:${k.item.refId}`,
      );
    const first = await keys();
    expect(await keys()).toEqual(first);
    expect(await keys()).toEqual(first);
  });

  it('gives a call one topic note, a typed turn two, and neither an unasked one', async () => {
    const notes = async (channel: 'text' | 'voice', text: string) =>
      (await evidence(text, { channel })).items.filter((k) => k.item.citation != null).length;
    expect(await notes('text', 'Should I raise money or bootstrap?')).toBe(2);
    expect(await notes('voice', 'Should I raise money or bootstrap?')).toBe(1);
    expect(await notes('text', 'We raised our prices and bootstrapped the booth today.')).toBe(0);
  });

  it('keeps what a shared citation showed with the answer, and nothing of the venture’s own', async () => {
    const pack = await evidence('Should I form an LLC?', { play: PLAY });
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const read = await h.t.db.withContext(
      { principalId: maya.principalId, tenantId: maya.tenantId, requestId: 'grounded' },
      async (tx) => {
        const turn = await turnsRepo.createTurn(tx, {
          tenantId: maya.tenantId,
          ventureId: h.ventures.quietquad.id,
          sessionId: session.id,
          authorId: maya.principalId,
          mode: 'coach',
          founderText: 'Should I form an LLC?',
          riskCategories: [],
        });
        await turnsRepo.insertTurnEvidence(
          tx,
          turn.id,
          pack.items.map((k) => ({
            key: k.item.key,
            kind: k.item.kind,
            refId: k.item.refId,
            score: k.item.score,
            title: k.item.title,
            ventureId: k.ventureId,
            source: k.item.source ?? null,
            citation: k.item.citation ?? null,
            excerpt: k.item.excerpt,
          })),
        );
        return (await turnsRepo.listTurnEvidence(tx, [turn.id])).get(turn.id) ?? [];
      },
    );
    const play = read.find((i) => i.key === 'E1');
    expect(play?.excerpt).toBe(pack.items[0]?.item.excerpt);
    expect(play?.citation).toEqual(pack.items[0]?.item.citation);
    for (const key of pack.playKeys.slice(1)) {
      const before = pack.items.find((k) => k.item.key === key)?.item;
      const after = read.find((i) => i.key === key);
      expect(after?.excerpt).toBe(before?.excerpt);
      expect(after?.citation).toEqual(before?.citation);
    }
    // Reworded or gone later: the answer still shows what it cited.
    const cited = read.find((i) => i.key === pack.playKeys[1]);
    await h.t.db.system((sx) =>
      sx.query('DELETE FROM knowledge_chunks WHERE id = :id', { id: p.uuid(cited?.refId ?? '') }),
    );
    const stored = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*) FILTER (WHERE te.citation IS NOT NULL)::int AS kept,
                count(*) FILTER (WHERE te.citation IS NOT NULL AND te.venture_id IS NOT NULL)::int AS venture
         FROM turn_evidence te JOIN turns t ON t.id = te.turn_id WHERE t.session_id = :s`,
        { s: p.uuid(session.id) },
      ),
    );
    expect(Number(stored.rows[0]?.kept)).toBeGreaterThanOrEqual(3);
    expect(stored.rows[0]?.venture).toBe(0);
    const later = await h.core.sessions.get(maya, session.id);
    const again = later.turns[0]?.evidence.find((i) => i.key === cited?.key);
    expect(again?.excerpt).toBe(cited?.excerpt);
    expect(again?.citation).toEqual(cited?.citation);
  });
});

describe('the query embedding', () => {
  const kit = (gateway: MockModelGateway, previous?: MockModelGateway) =>
    new Kit(
      resolveDeps({
        db: h.t.db,
        gateway,
        config: h.config,
        objectStore: h.objectStore,
        jobQueue: h.jobQueue,
        logger: h.logger,
        ...(previous === undefined ? {} : { previousEmbeddings: previous }),
      }),
    );
  const meter = () => ({ purpose: 'turn' as const, ventureId: h.ventures.quietquad.id });
  const embeds = (gateway: MockModelGateway) => gateway.calls.filter((c) => c.kind === 'embed').length;

  it('is not made for courtesy, and once for words already embedded', async () => {
    const gateway = new MockModelGateway({ streamDelayMs: 0 });
    const k = kit(gateway);
    expect(await embedRetrievalQuery(k, maya, meter(), 'Thanks so much!')).toBeNull();
    expect(
      await embedRetrievalQuery(
        k,
        maya,
        meter(),
        'Hi!\nWhat is your riskiest assumption?',
        undefined,
        undefined,
        'Hi!',
      ),
    ).toBeNull();
    expect(embeds(gateway)).toBe(0);
    const first = await embedRetrievalQuery(k, maya, meter(), 'How do I price a pilot?');
    const second = await embedRetrievalQuery(k, maya, meter(), 'how do I price a  pilot?');
    expect(second).toEqual(first);
    expect(embeds(gateway)).toBe(1);
    expect(embeddingModelOf(first)).toBe(MOCK_EMBEDDINGS_MODEL_ID);
  });

  it('is made by both models while one is being replaced', async () => {
    const gateway = new MockModelGateway({ streamDelayMs: 0 });
    const previous = new MockModelGateway({ streamDelayMs: 0 });
    await embedRetrievalQuery(kit(gateway, previous), maya, meter(), 'How do I price a pilot?');
    expect(embeds(gateway)).toBe(1);
    expect(embeds(previous)).toBe(1);
  });
});
