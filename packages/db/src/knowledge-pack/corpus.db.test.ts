/**
 * The cited corpus in a tenant: stored once and kept in line with the code, a person's withdrawal kept, the programme's
 * notes in the programme's tenant alone; and what a turn may draw from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import * as retrievalRepo from '../repositories/retrieval.js';
import { PROGRAMME_NOTES } from '../seed/programme-notes.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { CORPUS, LIBRARY_URI_PREFIX, OPEN_LIBRARY, PROGRAMME_NOTES_URI_PREFIX } from './corpus.js';
import {
  corpusSourceId,
  LIBRARY_STORE,
  PROGRAMME_STORE,
  syncCorpus,
  syncCorpusToTenants,
} from './corpus-sync.js';

let t: TestDatabase;
let tenantId: string;
let founder: string;
let personaId: string;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  const venture = t.seed?.ventures.find((v) => v.key === 'quietquad');
  if (!t.seed || !venture) throw new Error('seed missing');
  tenantId = t.seed.tenantId;
  founder = venture.members[0]?.principalId ?? '';
  personaId = venture.personaId;
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

async function ask(
  text: string,
  corpus: Partial<retrievalRepo.CorpusQuery> | null = {},
  extra: Partial<retrievalRepo.SharedChunkQuery> = {},
): Promise<retrievalRepo.RetrievedItem[]> {
  return t.db.withContext(makeContext(founder, tenantId), (tx) =>
    retrievalRepo.searchSharedChunks(tx, {
      tenantId,
      personaId,
      query: text,
      embedding: null,
      limit: 2,
      reference: { founderText: text, limit: 2, sessionId: null },
      ...(corpus === null ? {} : { corpus: { founderText: text, ...corpus } }),
      ...extra,
    }),
  );
}
const fromCorpus = (items: readonly retrievalRepo.RetrievedItem[]) =>
  items.filter((i) => i.lane === 'corpus' || i.lane === 'pinned');

describe('storing the corpus', () => {
  it('stores every note with its place, page, licence and attribution, and changes nothing when run again', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT s.uri, s.scope, s.classification, s.url, s.license, s.attribution, s.accessed_on::text AS accessed,
                c.locator, c.content
         FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         WHERE s.tenant_id = :t AND (starts_with(s.uri, :library) OR starts_with(s.uri, :noteUris))`,
        {
          t: p.uuid(tenantId),
          library: p.text(LIBRARY_URI_PREFIX),
          noteUris: p.text(PROGRAMME_NOTES_URI_PREFIX),
        },
      ),
    );
    expect(rows.rows).toHaveLength(CORPUS.reduce((n, s) => n + s.notes.length, 0));
    const byUri = new Map(CORPUS.map((s) => [s.uri, s]));
    for (const row of rows.rows) {
      const source = byUri.get(String(row.uri));
      expect(row).toMatchObject({
        url: source?.url,
        license: source?.licence,
        attribution: source?.attribution,
        accessed: source?.accessedOn,
        scope: String(row.uri).startsWith('library:') ? 'public' : 'program',
        classification: String(row.uri).startsWith('library:') ? 'public' : 'program_internal',
      });
      expect(source?.notes.find((n) => n.content === row.content)?.locator).toBe(row.locator);
    }
    for (const store of [LIBRARY_STORE, PROGRAMME_STORE]) {
      const again = await t.db.system((sx) => syncCorpus(sx, { tenantId, store }));
      expect(again).toEqual({
        inserted: 0,
        updated: 0,
        withdrawn: 0,
        unchanged: store.sources.length,
        keptWithdrawn: 0,
      });
    }
  });

  it('gives another tenant the open library and none of the programme’s notes', async () => {
    const other = await t.db.system(async (sx) => {
      const r = await sx.query(
        `INSERT INTO tenants (slug, name, kind) VALUES ('corpus-other', 'Other', 'partner') RETURNING id`,
      );
      await syncCorpusToTenants(sx, 'ain');
      const counts = await sx.query(
        `SELECT count(*) FILTER (WHERE starts_with(uri, :library))::int AS library,
                count(*) FILTER (WHERE starts_with(uri, :noteUris))::int AS notes
         FROM knowledge_sources WHERE tenant_id = :t`,
        {
          t: p.uuid(String(r.rows[0]?.id)),
          library: p.text(LIBRARY_URI_PREFIX),
          noteUris: p.text(PROGRAMME_NOTES_URI_PREFIX),
        },
      );
      return counts.rows[0];
    });
    expect(other).toEqual({ library: OPEN_LIBRARY.length, notes: 0 });
    expect(PROGRAMME_NOTES.length).toBeGreaterThan(0);
  });

  it('re-ingests a changed source, drops one the code dropped, and never undoes a person’s withdrawal', async () => {
    const [changed, dropped, withdrawn, ...rest] = LIBRARY_STORE.sources;
    if (!changed || !dropped || !withdrawn) throw new Error('library too small');
    const edited = {
      ...changed,
      notes: [{ heading: 'Edited', locator: 'Here', content: 'A changed note.' }],
    };
    const report = await t.db.system(async (sx) => {
      await sx.query(`UPDATE knowledge_sources SET status = 'withdrawn' WHERE id = :id`, {
        id: p.uuid(corpusSourceId(tenantId, withdrawn.uri)),
      });
      return syncCorpus(sx, {
        tenantId,
        store: { ...LIBRARY_STORE, sources: [edited, withdrawn, ...rest] },
      });
    });
    expect(report).toEqual({
      inserted: 0,
      updated: 1,
      withdrawn: 1,
      unchanged: rest.length,
      keptWithdrawn: 1,
    });
    const state = await t.db.system((sx) =>
      sx.query(
        `SELECT s.uri, s.status, count(c.id)::int AS notes FROM knowledge_sources s
         LEFT JOIN knowledge_chunks c ON c.source_id = s.id
         WHERE s.id = ANY (:ids) GROUP BY s.id`,
        { ids: p.uuidArray([changed, dropped, withdrawn].map((s) => corpusSourceId(tenantId, s.uri))) },
      ),
    );
    const of = (uri: string) => state.rows.find((r) => r.uri === uri);
    expect(of(changed.uri)).toMatchObject({ status: 'active', notes: 1 });
    expect(of(dropped.uri)).toMatchObject({ status: 'withdrawn', notes: 0 });
    expect(of(withdrawn.uri)).toMatchObject({ status: 'withdrawn' });
    // Back as the code has it; the person's withdrawal still stands, then is lifted by them.
    await t.db.system((sx) => syncCorpus(sx, { tenantId, store: LIBRARY_STORE }));
    const back = await t.db.system((sx) =>
      sx.query(`SELECT status FROM knowledge_sources WHERE id = :id`, {
        id: p.uuid(corpusSourceId(tenantId, dropped.uri)),
      }),
    );
    expect(back.rows[0]).toEqual({ status: 'active' });
    await t.db.system((sx) =>
      sx.query(`UPDATE knowledge_sources SET status = 'active' WHERE id = :id`, {
        id: p.uuid(corpusSourceId(tenantId, withdrawn.uri)),
      }),
    );
  });
});

describe('drawing on the corpus', () => {
  it('answers a topic question with located, licensed notes beside the coach’s own two', async () => {
    const found = await ask('Should I form an LLC or a corporation?');
    const notes = fromCorpus(found);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(retrievalRepo.CORPUS_LIMIT);
    for (const note of notes) {
      expect(note.citation?.locator).toBeTruthy();
      expect(note.citation?.url).toMatch(/^https:/);
      expect(note.citation?.licence).toBeTruthy();
      expect(note.citation?.attribution).toBeTruthy();
    }
    // One note per source, so two sources answer rather than one twice.
    expect(new Set(notes.map((n) => n.sourceId)).size).toBe(notes.length);
  });

  it('gives the programme’s own note on a question of its course', async () => {
    const found = fromCorpus(await ask('What is the difference between a customer and a user?'));
    expect(found[0]?.title).toContain('Ain Foundry Module 1, Unit 2: Key term: customer vs. user');
    expect(found[0]?.citation?.locator).toMatch(/^Module 1, Unit 2, .+ to \d\d:\d\d$/);
  });

  it('gives nothing to a message that only tells, nor without a corpus query, nor beyond the limit asked', async () => {
    expect(fromCorpus(await ask('I told my customer about the LLC and the pitch deck today.'))).toEqual([]);
    expect(fromCorpus(await ask('Should I form an LLC or a corporation?', null))).toEqual([]);
    expect(fromCorpus(await ask('Should I form an LLC or a corporation?', { limit: 0 }))).toEqual([]);
    expect(fromCorpus(await ask('Should I form an LLC or a corporation?', { limit: 1 }))).toHaveLength(1);
  });

  it('gives a caller’s topic too, and ignores one it does not have', async () => {
    const text = 'Which one fits a student team best?';
    expect(fromCorpus(await ask(text))).toEqual([]);
    expect(fromCorpus(await ask(text, { topics: ['no-such-topic'] }))).toEqual([]);
    const named = fromCorpus(
      await ask('Which legal form fits a student team?', { topics: ['legal-structure'] }),
    );
    expect(named.length).toBeGreaterThan(0);
  });

  it('gives the one note the play rests on whatever the message is, and none when no cited note is about the play', async () => {
    const patent = {
      title: 'File a patent now or wait',
      text: 'A public disclosure starts a one-year clock; a provisional application holds your date. See a patent attorney.',
      citations: [
        { sourceId: 'mom-test', locator: 'Chapter 1' },
        { sourceId: 'uspto-provisional', locator: null },
        { sourceId: 'ain-curriculum', locator: 'Module 2, Unit 2' },
      ],
    };
    // A message that names none of it: the citations are the play's.
    const found = await ask('ok do it', { play: patent });
    const pinned = found.filter((i) => i.lane === 'pinned').map((i) => i.title);
    expect(pinned).toHaveLength(retrievalRepo.CORPUS_PIN_LIMIT);
    expect(pinned[0]).toContain('Provisional application for patent');
    expect(pinned[0]).toContain('Public disclosure and the one-year clock');
    // The note is the play's, not the message's, whichever words the founder uses.
    const worded = await ask('is there a deadline after the 12 months lapse?', { play: patent });
    expect(worded.filter((i) => i.lane === 'pinned').map((i) => i.title)).toEqual(pinned);
    const honest = await ask('Tell me my idea is great', {
      play: {
        title: 'Write how many strangers must pay, then test it',
        text: 'I will not call it great, because neither of us knows yet. Great is what strangers show with their money.',
        citations: [{ sourceId: 'ain-foundry', locator: 'Module 3, Unit 2: Networking I' }],
      },
    });
    expect(honest.filter((i) => i.lane === 'pinned')).toEqual([]);
  });

  it('keeps to the assignment’s data class: a public-only coach gets the open library and not the programme’s notes', async () => {
    const found = fromCorpus(
      await ask(
        'What should my pitch to investors include?',
        {},
        { classifications: ['synthetic', 'public'] },
      ),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((i) => i.sourceScope === 'public')).toBe(true);
  });

  it('never reaches a founder of another tenant', async () => {
    const leaked = await t.db.withContext(makeContext(founder, tenantId), (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: '00000000-0000-4000-8000-000000000000',
        query: 'Should I form an LLC?',
        embedding: null,
        corpus: { founderText: 'Should I form an LLC?' },
      }),
    );
    expect(leaked).toEqual([]);
  });
});
