/**
 * A coaching answer's evidence names the knowledge source of each cited passage by id and scope, so a citation
 * is linked to its own document or library source even when a program source and the vEIR's library carry the
 * very name of one of the venture's files (the web used to match by title and counted them as that file).
 */
import { MockModelGateway } from '@foundry/ai';
import { TurnEvidenceResponse } from '@foundry/contracts';
import { knowledgeRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { type IngestDocumentJob } from '../ports.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let maya: RequestContext;
let corin: RequestContext;

const FILENAME = 'pricing-memo.md';
const MARKER = 'quokka ledger';

beforeAll(async () => {
  // Room for every shared passage that matches (the handbook passage has no embedding, so it ranks lexically).
  h = await createCoreHarness({
    config: { retrieval: { memory: 8, chunks: 6, doctrine: 12, resources: 4, patterns: 2 } },
  });
  maya = await h.ctxFor(h.people.maya);
  corin = await h.ctxFor(h.people.eirCorin);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

/** Uploads a venture document and runs its ingestion; returns its id. */
async function uploadDocument(filename: string, body: string): Promise<string> {
  const ventureId = h.ventures.quietquad.id;
  const created = await h.core.documents.createUpload(maya, ventureId, {
    filename,
    contentType: 'text/markdown',
    sizeBytes: Buffer.byteLength(body),
  });
  const presigned = h.objectStore.presigned.at(-1);
  if (!presigned) throw new Error('no presign');
  h.objectStore.put(presigned.key, body);
  await h.core.documents.complete(maya, created.document.id);
  const job = h.jobQueue
    .drain()
    .find(
      (j): j is IngestDocumentJob => j.type === 'ingest_document' && j.documentId === created.document.id,
    );
  if (!job) throw new Error('no ingestion job');
  expect(await h.core.ingestion.process(job, { requestId: 'ingest', attempt: 1 })).toMatchObject({
    status: 'ready',
  });
  return created.document.id;
}

describe('the source of a cited passage', () => {
  it('links each citation to its own source, whatever the sources are called', async () => {
    const ventureId = h.ventures.quietquad.id;
    const personaId = h.ventures.quietquad.personaId;
    const documentId = await uploadDocument(
      FILENAME,
      `# Pricing memo\n\nThe ${MARKER} shows students would pay two dollars a week for seat alerts during finals.`,
    );
    // The vEIR's library and the program's handbook each hold a source with the very same name.
    const library = await h.core.library.create(corin, personaId, {
      kind: 'note',
      title: FILENAME,
      body: `When a founder brings a ${MARKER}, ask which line item a customer would cut first.`,
    });
    const handbook = await h.t.db.system(async (sx) => {
      const source = await knowledgeRepo.createKnowledgeSource(sx, {
        tenantId: h.seed.tenantId,
        scope: 'program',
        title: FILENAME,
        kind: 'note',
        body: `Program guidance: a ${MARKER} is evidence only when customers paid.`,
      });
      await knowledgeRepo.insertChunks(sx, {
        sourceId: source.id,
        tenantId: h.seed.tenantId,
        scope: 'program',
        chunks: [
          { ordinal: 0, content: `Program guidance: a ${MARKER} is evidence only when customers paid.` },
        ],
      });
      return source.id;
    });

    const session = await h.core.sessions.create(maya, ventureId, { mode: 'coach' });
    const accepted = await h.core.orchestrator.runTurn(
      maya,
      session.id,
      { text: `What does the ${MARKER} tell us about pricing?` },
      () => undefined,
    );
    const turnId = accepted.turnId ?? '';
    const evidence = TurnEvidenceResponse.parse({
      items: await h.core.sessions.getTurnEvidence(maya, turnId),
    }).items;
    const document = (await h.core.documents.list(maya, ventureId)).find((d) => d.id === documentId);
    const documentSource = document?.sourceId ?? null;
    expect(documentSource).not.toBeNull();

    const named = evidence.filter((item) => item.title.startsWith(FILENAME));
    expect(new Set(named.map((item) => item.title.split(' — ')[0]))).toEqual(new Set([FILENAME]));
    expect(
      named.map((item) => item.source).sort((a, b) => (a?.scope ?? '').localeCompare(b?.scope ?? '')),
    ).toEqual([
      { id: library.id, scope: 'persona' },
      { id: handbook, scope: 'program' },
      { id: documentSource, scope: 'venture' },
    ]);
    // Only the venture document's passage is the document's; the library one is doctrine.
    expect(named.find((item) => item.source?.scope === 'venture')?.kind).toBe('chunk');
    expect(named.find((item) => item.source?.scope === 'persona')?.kind).toBe('doctrine');
    // Evidence other than passages names no source.
    expect(
      evidence
        .filter((item) => item.kind !== 'chunk' && item.kind !== 'doctrine')
        .every((i) => i.source === null),
    ).toBe(true);

    // The answer read back with its conversation carries the same sources.
    const detail = await h.core.sessions.get(maya, session.id);
    const turn = detail.turns.find((t) => t.id === turnId);
    expect(turn?.evidence.map((item) => item.source)).toEqual(evidence.map((item) => item.source));
  });
});

describe('program guidance for a definitional question (LAB-C1)', () => {
  it('puts the handbook passage in front of the model, asked short or long, first or later in a conversation', async () => {
    const seen: string[] = [];
    const gateway = new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: (context) => {
        seen.push(context.messages.at(-1)?.content ?? '');
        return 'What would you test first, and what result would change your plan?';
      },
    });
    const core = createCore({
      db: h.t.db,
      gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
    });
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, {});
    for (const text of [
      'What should an experiment card state? I need a success threshold set in advance and a time box.',
      "What's an experiment card?",
    ]) {
      await core.orchestrator.runTurn(maya, session.id, { text }, () => undefined);
      expect(seen.at(-1), text).toContain('Every experiment card states');
    }
  });
});
