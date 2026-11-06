import { knowledgePack, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { proposeMemoryCandidates, type EvidenceIndex } from './memory.js';
import { conversationGrounding } from './memory-dedupe.js';

/*
 * The shared reference library (the startup knowledge base, scope `public`) is general material about other
 * companies and methods: it never becomes a venture's memory unless the founder said the thing themselves.
 */

let h: CoreHarness;
let ventureId: string;
let nonaChunk: string;

beforeAll(async () => {
  h = await createCoreHarness();
  ventureId = h.ventures.quietquad.id;
  const r = await h.t.db.system((sx) =>
    sx.query(`SELECT id FROM knowledge_chunks WHERE source_id = :s AND ordinal = 1`, {
      s: p.uuid(knowledgePack.packSourceId(h.seed.tenantId, 'case/SC01')),
    }),
  );
  nonaChunk = String(r.rows[0]?.id);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

const evidence: () => EvidenceIndex = () =>
  new Map([
    [
      'E1',
      {
        kind: 'chunk',
        refId: nonaChunk,
        title: 'NONA Technologies: Choosing a viable initial market — Documented account · MIT / J-WAFS',
        source: { id: knowledgePack.packSourceId(h.seed.tenantId, 'case/SC01'), scope: 'public' },
      },
    ],
  ]);

async function aiItems(): Promise<{ title: string; refs: string }[]> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT title, source_refs::text AS refs FROM memory_objects WHERE venture_id = :v AND origin = 'ai'
       ORDER BY created_at`,
      { v: p.uuid(ventureId) },
    ),
  );
  return r.rows.map((row) => ({ title: String(row.title), refs: String(row.refs) }));
}

describe('reference-library evidence and venture memory', () => {
  it('drops a candidate that rests only on a reference passage', async () => {
    const before = await aiItems();
    const result = await h.t.db.system((sx) =>
      proposeMemoryCandidates(sx, {
        tenantId: h.seed.tenantId,
        ventureId,
        createdBy: h.people.maya,
        candidates: [
          {
            type: 'fact',
            title: 'Twenty-four interviews ruled out two markets',
            content:
              'The first 24 interviews ruled out the first two markets and helped identify a beachhead.',
            evidence_ids: ['E1'],
            confidence: 0.8,
            source: 'founder_stated',
          },
        ],
        evidence: evidence(),
        source: { kind: 'session', id: '00000000-0000-4000-8000-000000000001' },
        visibility: 'team',
        grounding: conversationGrounding([
          { founder: 'How did NONA use customer discovery to choose a market?', answer: null },
        ]),
        forgotten: [],
      }),
    );
    expect(result).toMatchObject({ created: 0, dropped: 1 });
    expect(await aiItems()).toEqual(before);
  });

  it('keeps what the founder said even when a reference passage was cited, without linking the passage', async () => {
    const result = await h.t.db.system((sx) =>
      proposeMemoryCandidates(sx, {
        tenantId: h.seed.tenantId,
        ventureId,
        createdBy: h.people.maya,
        candidates: [
          {
            type: 'decision',
            title: 'Library interviews before choosing a campus',
            content: 'Maya decided to run library interviews at three campuses before choosing one.',
            evidence_ids: ['E1'],
            confidence: 0.9,
            source: 'founder_stated',
          },
        ],
        evidence: evidence(),
        source: { kind: 'session', id: '00000000-0000-4000-8000-000000000002' },
        visibility: 'team',
        grounding: conversationGrounding([
          {
            founder: 'I decided to run library interviews at three campuses before choosing one.',
            answer: null,
          },
        ]),
        forgotten: [],
      }),
    );
    expect(result.created).toBe(1);
    const kept = (await aiItems()).find((m) => m.title === 'Library interviews before choosing a campus');
    expect(kept?.refs).not.toContain(nonaChunk);
  });
});
