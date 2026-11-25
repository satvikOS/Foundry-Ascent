/**
 * What founders ask each play for, stored for vector search: synced like the corpus, embedded and re-embedded like any
 * passage, found by the nearest play, and never evidence.
 */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tagAlternate, tagEmbedding } from '../embedding-model.js';
import { p } from '../params.js';
import * as knowledgeRepo from '../repositories/knowledge.js';
import * as retrievalRepo from '../repositories/retrieval.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/index.js';
import {
  PLAY_ASK_LOCATOR,
  playAsksSourceId,
  syncPlayAsks,
  syncPlayAsksToTenants,
  type PlayAsks,
} from './play-asks.js';

const MODEL = 'model-a';
let t: TestDatabase;
let tenantId: string;
let personaId: string;
let founder: string;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  const venture = t.seed?.ventures[0];
  if (!t.seed || !venture) throw new Error('seed missing');
  tenantId = t.seed.tenantId;
  personaId = venture.personaId;
  founder = venture.members[0]?.principalId ?? '';
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

/** A deterministic vector of a text's words: the same words, the same direction. */
function vectorOf(text: string, seed = ''): number[] {
  const v = new Array<number>(knowledgeRepo.EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const i = createHash('sha256').update(`${seed}${word}`).digest().readUInt32BE(0) % v.length;
    v[i] = (v[i] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
const embed = (text: string, model = MODEL): number[] => tagEmbedding(vectorOf(text, model), model);

async function embedBacklog(model = MODEL): Promise<number> {
  const backlog = await t.db.system((sx) => knowledgeRepo.listChunksMissingEmbeddings(sx, 5_000));
  await t.db.system((sx) =>
    knowledgeRepo.setChunkEmbeddings(
      sx,
      backlog.map((b) => ({ id: b.id, embedding: embed(b.text, model) })),
    ),
  );
  return backlog.length;
}

const ASKS: PlayAsks = {
  version: 'v1',
  asks: [
    { playId: 'pricing', text: 'set a first price' },
    { playId: 'pricing', text: 'what do I charge for it' },
    { playId: 'find-ten-people', text: 'find ten people to talk to' },
    { playId: 'zeta', text: 'twin words here' },
    { playId: 'alpha', text: 'here twin words' },
  ],
};
const sync = (playAsks: PlayAsks, tenant = tenantId) =>
  t.db.system((sx) => syncPlayAsks(sx, { tenantId: tenant, playAsks }));
const stored = async () =>
  (
    await t.db.system((sx) =>
      sx.query(
        `SELECT c.locator, c.content, c.embedding IS NOT NULL AS embedded, c.embedding_model, c.id
         FROM knowledge_chunks c WHERE c.source_id = :id ORDER BY c.locator, c.content`,
        { id: p.uuid(playAsksSourceId(tenantId)) },
      ),
    )
  ).rows;
const near = (text: string, limit = 3, model = MODEL) =>
  t.db.withContext(makeContext(founder, tenantId), (tx) =>
    retrievalRepo.nearestPlays(tx, { tenantId, embedding: embed(text, model), limit }),
  );

describe('syncing the asks', () => {
  it('stores each once, in every active tenant, and writes nothing when nothing changed', async () => {
    await t.db.system((sx) =>
      sx.query(`INSERT INTO tenants (slug, name, kind) VALUES ('asks-other', 'Other', 'partner')`),
    );
    const first = await t.db.system((sx) => syncPlayAsksToTenants(sx, ASKS));
    expect(first.map((r) => r.slug)).toEqual(['ain', 'asks-other']);
    for (const { report } of first)
      expect(report).toEqual({ inserted: 5, deleted: 0, unchanged: 0, keptWithdrawn: false });
    const rows = await stored();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => String(r.locator).startsWith(PLAY_ASK_LOCATOR))).toBe(true);
    const again = await t.db.system((sx) => syncPlayAsksToTenants(sx, ASKS));
    for (const { report } of again)
      expect(report).toEqual({ inserted: 0, deleted: 0, unchanged: 5, keptWithdrawn: false });
    expect(await stored()).toEqual(rows);
  });

  it('keeps the vectors of the asks a new version did not change', async () => {
    await embedBacklog();
    expect((await stored()).every((r) => r.embedded === true && r.embedding_model === MODEL)).toBe(true);
    expect(await sync({ ...ASKS, version: 'v2' })).toMatchObject({ inserted: 0, deleted: 0, unchanged: 5 });
    const changed: PlayAsks = {
      version: 'v3',
      asks: [...ASKS.asks.filter((a) => a.playId !== 'zeta'), { playId: 'zeta', text: 'another thing' }],
    };
    expect(await sync(changed)).toEqual({ inserted: 1, deleted: 1, unchanged: 4, keptWithdrawn: false });
    const rows = await stored();
    expect(rows.filter((r) => r.embedded === true)).toHaveLength(4);
    // One has no vector yet: nothing is matched until it has.
    expect(await near('what do I charge')).toBeNull();
    expect(await embedBacklog()).toBe(1);
    expect((await near('what do I charge'))?.plays[0]?.playId).toBe('pricing');
    await sync(ASKS);
    await embedBacklog();
  });

  it('refuses the same ask twice, and leaves asks someone withdrew', async () => {
    await expect(
      sync({ version: 'x', asks: [ASKS.asks[0], ASKS.asks[0]].flatMap((a) => (a ? [a] : [])) }),
    ).rejects.toThrow('twice');
    const status = (to: string) =>
      t.db.system((sx) =>
        sx.query(`UPDATE knowledge_sources SET status = :to WHERE id = :id`, {
          id: p.uuid(playAsksSourceId(tenantId)),
          to: p.text(to),
        }),
      );
    await status('withdrawn');
    expect(await sync({ ...ASKS, version: 'v9' })).toMatchObject({ keptWithdrawn: true, inserted: 0 });
    expect(await near('what do I charge')).toBeNull();
    await status('active');
    expect(await near('what do I charge')).not.toBeNull();
  });
});

describe('the nearest plays', () => {
  it('gives each play once by its closest ask, best first, equal ones by id', async () => {
    const found = await near('what do I charge for it', 5);
    expect(found?.modelId).toBe(MODEL);
    expect(found?.plays[0]).toMatchObject({ playId: 'pricing' });
    expect(found?.plays[0]?.score).toBeCloseTo(1, 5);
    expect(new Set(found?.plays.map((x) => x.playId)).size).toBe(4);
    expect((await near('twin words here'))?.plays.slice(0, 2).map((x) => x.playId)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect((await near('twin words here', 1))?.plays).toHaveLength(1);
    expect(await near('what do I charge for it', 5)).toEqual(found);
  });

  it('compares only vectors of one model, the message’s own or the one being replaced', async () => {
    const search = (embedding: readonly number[]) =>
      t.db.system((sx) => retrievalRepo.nearestPlays(sx, { tenantId, embedding, limit: 3 }));
    expect(await search(vectorOf('what do I charge', MODEL))).toBeNull();
    expect(await near('what do I charge', 3, 'model-b')).toBeNull();
    const both = () =>
      tagAlternate(embed('what do I charge for it', 'model-b'), {
        embedding: embed('what do I charge for it'),
        modelId: MODEL,
      });
    expect(await search(both())).toMatchObject({ modelId: MODEL, plays: [{ playId: 'pricing' }, {}, {}] });
    // Re-embedding, the runbook's way: half of them with each model say nothing, all of them the new one's.
    const old = await t.db.system((sx) => knowledgeRepo.listChunksOfOtherModels(sx, 'model-b', 5_000));
    const own = new Set((await stored()).map((r) => String(r.id)));
    const asks = old.filter((o) => own.has(o.id));
    expect(asks).toHaveLength(5);
    const reembed = (items: typeof asks) =>
      t.db.system((sx) =>
        knowledgeRepo.setChunkEmbeddings(
          sx,
          items.map((i) => ({ id: i.id, embedding: embed(i.text, 'model-b') })),
        ),
      );
    await reembed(asks.slice(0, 2));
    expect(await search(both())).toBeNull();
    await reembed(asks.slice(2));
    expect(await search(both())).toMatchObject({
      modelId: 'model-b',
      plays: [{ playId: 'pricing' }, {}, {}],
    });
    expect((await near('what do I charge for it', 3, 'model-b'))?.plays[0]?.playId).toBe('pricing');
  });

  it('is the tenant’s own', async () => {
    const nobody = await t.db.system((sx) =>
      retrievalRepo.nearestPlays(sx, {
        tenantId: '00000000-0000-4000-8000-000000000001',
        embedding: embed('what do I charge', 'model-b'),
        limit: 3,
      }),
    );
    expect(nobody).toBeNull();
  });
});

describe('never evidence', () => {
  it('changes nothing the shared search returns, not even a score, for the asks’ own words', async () => {
    const search = (query: string, embedding: readonly number[] | null) =>
      t.db.withContext(makeContext(founder, tenantId), (tx) =>
        retrievalRepo.searchSharedChunks(tx, {
          tenantId,
          personaId,
          query,
          embedding,
          limit: 10,
          candidates: 40,
          reference: { founderText: query, limit: 2, sessionId: null },
          corpus: { founderText: query, limit: 5 },
        }),
      );
    const queries = [...ASKS.asks.map((a) => a.text), 'What should I charge for my pilot?', 'who pays'];
    const all = async () => {
      const out: string[] = [];
      for (const query of queries)
        for (const embedding of [null, embed(query)])
          out.push(
            JSON.stringify(
              (await search(query, embedding)).map((i) => [i.refId, i.score.toFixed(5), i.lane]),
            ),
          );
      return out;
    };
    // With vectors of the passages' own model the asks would be the closest passages of all.
    await sync({ version: 'empty', asks: [] });
    const many = Array.from({ length: 120 }, (_, i) => ({
      playId: `play-${String(i)}`,
      text: `charge the price pilot people pays number ${String(i)}`,
    }));
    await sync({ version: 'many', asks: [...ASKS.asks, ...many] });
    expect(await embedBacklog()).toBe(125);
    const withAsks = await all();
    const ids = new Set((await stored()).map((r) => String(r.id)));
    expect(ids.size).toBe(125);
    for (const line of withAsks) for (const id of ids) expect(line).not.toContain(id);
    await sync({ version: 'empty', asks: [] });
    expect(await stored()).toHaveLength(0);
    expect(await all()).toEqual(withAsks);
  });
});
