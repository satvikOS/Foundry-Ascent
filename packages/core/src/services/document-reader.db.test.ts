import { DocumentFileResponse, SourceTextResponse } from '@foundry/contracts/viewer';
import { p, venturesRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { isDomainError } from '../errors.js';
import { type IngestDocumentJob } from '../ports.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let maya: RequestContext;
let graham: RequestContext;
let corin: RequestContext;
let priya: RequestContext;
let jonah: RequestContext;
let ventureId: string;
let otherVentureId: string;
let programSourceId: string;
let personaSourceId: string;

const sentence = (i: number): string =>
  `Sentence ${String(i).padStart(3, '0')} records where students found a quiet seat during finals.`;
const LONG_DOC = `# Seat study\n\n## Findings\n\n${Array.from({ length: 60 }, (_, p) =>
  Array.from({ length: 5 }, (_, s) => sentence(p * 5 + s)).join(' '),
).join('\n\n')}`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    if (isDomainError(err)) return err.code;
    throw err;
  }
}

/** Registers, uploads and (unless `stop`) ingests a markdown document; returns its id. */
async function uploadDocument(
  filename: string,
  body: string,
  stop?: 'before_upload' | 'before_ingestion',
): Promise<string> {
  const created = await h.core.documents.createUpload(maya, ventureId, {
    filename,
    contentType: 'text/markdown',
    sizeBytes: Buffer.byteLength(body),
  });
  if (stop === 'before_upload') return created.document.id;
  const presigned = h.objectStore.presigned.at(-1);
  if (!presigned) throw new Error('no presign');
  h.objectStore.put(presigned.key, body);
  await h.core.documents.complete(maya, created.document.id);
  const job = h.jobQueue
    .drain()
    .find(
      (j): j is IngestDocumentJob => j.type === 'ingest_document' && j.documentId === created.document.id,
    );
  if (!job) throw new Error('job not enqueued');
  if (stop === 'before_ingestion') return created.document.id;
  await h.core.ingestion.process(job, { requestId: `ingest-${filename}`, attempt: 1 });
  return created.document.id;
}

/** Audit rows of one action on one object (as stored: identifiers and metadata only). */
async function auditOf(
  action: string,
  objectId: string,
): Promise<{ venture_id: unknown; object_type: unknown; outcome: unknown; metadata: string }[]> {
  const result = await h.t.db.system((sx) =>
    sx.query(
      `SELECT venture_id, object_type, outcome, metadata::text AS metadata FROM audit_events
       WHERE action = :action AND object_id = :objectId ORDER BY id`,
      { action: p.text(action), objectId: p.text(objectId) },
    ),
  );
  return result.rows as { venture_id: unknown; object_type: unknown; outcome: unknown; metadata: string }[];
}

async function sourceOf(documentId: string): Promise<string> {
  const docs = await h.core.documents.list(maya, ventureId);
  const sourceId = docs.find((d) => d.id === documentId)?.sourceId;
  if (!sourceId) throw new Error('document has no source');
  return sourceId;
}

beforeAll(async () => {
  h = await createCoreHarness();
  ventureId = h.ventures.quietquad.id;
  otherVentureId = h.ventures.benchtally.id;
  [maya, graham, corin, priya, jonah] = await Promise.all([
    h.ctxFor(h.people.maya),
    h.ctxFor(h.people.graham),
    h.ctxFor(h.people.eirCorin),
    h.ctxFor(h.people.priya),
    h.ctxFor(h.people.jonah),
  ]);
  const ids = await h.t.db.system(async (sx) => {
    await venturesRepo.addMembership(sx, { ventureId, principalId: h.people.graham, role: 'advisor' });
    const program = await sx.query(
      "SELECT id FROM knowledge_sources WHERE scope = 'program' AND tenant_id = :t ORDER BY created_at LIMIT 1",
      { t: p.uuid(h.seed.tenantId) },
    );
    const persona = await sx.query(
      `SELECT s.id FROM knowledge_sources s JOIN assignments a ON a.persona_id = s.persona_id
       WHERE s.scope = 'persona' AND a.venture_id = :v AND a.status = 'active' ORDER BY s.created_at LIMIT 1`,
      { v: p.uuid(ventureId) },
    );
    return { program: program.rows[0]?.id, persona: persona.rows[0]?.id };
  });
  if (typeof ids.program !== 'string' || typeof ids.persona !== 'string') throw new Error('seed sources');
  programSourceId = ids.program;
  personaSourceId = ids.persona;
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('document file (presigned GET)', () => {
  it('signs one GET of the stored file to show it for venture readers, audited by id as opened', async () => {
    const documentId = await uploadDocument('Seat notes.md', '# Seat notes\n\nThe east wing fills first.\n');
    const before = h.objectStore.presignedGets.length;
    const file = DocumentFileResponse.parse(await h.core.reader.documentFile(maya, documentId));
    const signed = h.objectStore.presignedGets.slice(before);
    // Only what was asked for is signed: the file to show, not a download nobody asked for.
    expect(signed.map((s) => s.disposition)).toEqual(['inline']);
    for (const s of signed) {
      expect(s.key).toMatch(new RegExp(`^tenants/[0-9a-f-]+/ventures/${ventureId}/documents/${documentId}/`));
      expect(s.filename).toBe('Seat notes.md');
      expect(s.contentType).toBe('text/markdown');
      expect(s.expiresInSeconds).toBeLessThanOrEqual(120);
    }
    expect(file.url).toContain('disposition=inline');

    // Every reader of the venture may open it: an advisor and the assigned EIR too.
    await expect(codeOf(h.core.reader.documentFile(graham, documentId))).resolves.toBe('ok');
    await expect(codeOf(h.core.reader.documentFile(corin, documentId))).resolves.toBe('ok');

    const events = await auditOf('document.file_opened', documentId);
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e).toMatchObject({ venture_id: ventureId, object_type: 'document', outcome: 'succeeded' });
      expect(e.metadata).not.toContain('east wing');
    }
    expect(await auditOf('document.file_downloaded', documentId)).toHaveLength(0);
  });

  it('signs a download only when one is asked for, audited as a download', async () => {
    const documentId = await uploadDocument('Seat plan.md', '# Seat plan\n\nThe annex opens at nine.\n');
    const before = h.objectStore.presignedGets.length;
    const file = DocumentFileResponse.parse(
      await h.core.reader.documentFile(maya, documentId, { disposition: 'attachment' }),
    );
    expect(h.objectStore.presignedGets.slice(before).map((s) => s.disposition)).toEqual(['attachment']);
    expect(file.url).toContain('disposition=attachment');
    expect(await auditOf('document.file_downloaded', documentId)).toHaveLength(1);
    expect(await auditOf('document.file_opened', documentId)).toHaveLength(0);
    await expect(
      codeOf(h.core.reader.documentFile(maya, documentId, { disposition: 'preview' as 'inline' })),
    ).resolves.toBe('validation_failed');
    expect(h.objectStore.presignedGets.length).toBe(before + 1);
  });

  it('is not found for anyone outside the venture, and signs nothing for them', async () => {
    const documentId = await uploadDocument('Private plan.md', '# Plan\n\nOnly for QuietQuad.\n');
    const before = h.objectStore.presignedGets.length;
    await expect(codeOf(h.core.reader.documentFile(priya, documentId))).resolves.toBe('not_found');
    await expect(codeOf(h.core.reader.documentFile(jonah, documentId))).resolves.toBe('not_found');
    await expect(codeOf(h.core.reader.documentFile(maya, 'not-a-uuid'))).resolves.toBe('not_found');
    expect(h.objectStore.presignedGets.length).toBe(before);
  });

  it('refuses a document whose file has not arrived, and a deleted one', async () => {
    const pending = await uploadDocument('Unfinished.md', '# Unfinished\n', 'before_upload');
    await expect(codeOf(h.core.reader.documentFile(maya, pending))).resolves.toBe('conflict');
    // While it is processed the file is there to read.
    const processing = await uploadDocument('Processing.md', '# Processing\n', 'before_ingestion');
    await expect(codeOf(h.core.reader.documentFile(maya, processing))).resolves.toBe('ok');
    await h.core.documents.remove(maya, processing);
    await expect(codeOf(h.core.reader.documentFile(maya, processing))).resolves.toBe('not_found');
  });
});

describe('source text', () => {
  it('reads a venture document back in order, without the text its passages repeat', async () => {
    const documentId = await uploadDocument('Seat study.md', LONG_DOC);
    const sourceId = await sourceOf(documentId);
    const text = SourceTextResponse.parse(await h.core.reader.sourceText(maya, ventureId, sourceId));
    expect(text.source).toMatchObject({ id: sourceId, scope: 'venture', documentId, kind: 'document' });
    expect(text.body).toBeNull();
    expect(text.truncated).toBe(false);
    expect(text.passages.length).toBeGreaterThan(2);
    expect(text.passages.map((x) => x.ordinal)).toEqual(text.passages.map((_, i) => i + 1));
    const joined = text.passages.map((x) => x.text).join('\n\n');
    for (let i = 0; i < 300; i += 1) expect(joined.split(sentence(i)).length - 1).toBe(1);

    // One passage on its own (a citation): the same text as in the whole document.
    const third = text.passages[2];
    if (!third) throw new Error('expected a third passage');
    const one = await h.core.reader.sourceText(maya, ventureId, sourceId, { passage: third.id });
    expect(one.passages).toEqual([third]);
    await expect(
      codeOf(h.core.reader.sourceText(maya, ventureId, sourceId, { passage: programSourceId })),
    ).resolves.toBe('not_found');
    await expect(
      codeOf(h.core.reader.sourceText(maya, ventureId, sourceId, { passage: 'nope' })),
    ).resolves.toBe('validation_failed');

    const opened = await auditOf('knowledge_source.text_opened', sourceId);
    expect(opened.length).toBeGreaterThanOrEqual(2);
    for (const e of opened) {
      expect(e).toMatchObject({ venture_id: ventureId, object_type: 'knowledge_source' });
      const metadata = JSON.parse(e.metadata) as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(['passages', 'scope']);
      expect(metadata.scope).toBe('venture');
      expect(typeof metadata.passages).toBe('number');
    }
  });

  it('keeps a venture document inside its venture', async () => {
    const documentId = await uploadDocument('Venture only.md', '# Venture only\n\nQuietQuad numbers.\n');
    const sourceId = await sourceOf(documentId);
    // Another venture's founder, through their own venture or this one.
    await expect(codeOf(h.core.reader.sourceText(priya, otherVentureId, sourceId))).resolves.toBe(
      'not_found',
    );
    await expect(codeOf(h.core.reader.sourceText(priya, ventureId, sourceId))).resolves.toBe('not_found');
    // A reader of this venture asking through the wrong venture.
    await expect(codeOf(h.core.reader.sourceText(maya, otherVentureId, sourceId))).resolves.toBe('not_found');
    // Even one who reads both ventures: a venture's document opens through its own venture only.
    await h.t.db.system((sx) =>
      venturesRepo.addMembership(sx, {
        ventureId: otherVentureId,
        principalId: h.people.maya,
        role: 'advisor',
      }),
    );
    await expect(codeOf(h.core.reader.sourceText(maya, otherVentureId, sourceId))).resolves.toBe('not_found');
    await expect(codeOf(h.core.reader.sourceText(maya, ventureId, sourceId))).resolves.toBe('ok');
    // Deleted: its passages are gone and the source is withdrawn.
    await h.core.documents.remove(maya, documentId);
    await expect(codeOf(h.core.reader.sourceText(maya, ventureId, sourceId))).resolves.toBe('not_found');
  });

  it('opens program material within the venture’s data class, with its written text', async () => {
    const text = await h.core.reader.sourceText(maya, ventureId, programSourceId);
    expect(text.source).toMatchObject({ scope: 'program', documentId: null, kind: 'note' });
    expect(text.body).toEqual(expect.any(String));
    expect(text.passages.length).toBeGreaterThan(0);

    // A venture whose data class stops at public material cannot open program-internal guidance.
    await h.t.db.system((sx) =>
      sx.query(
        "UPDATE assignments SET data_class_ceiling = 'public' WHERE venture_id = :v AND status = 'active'",
        { v: p.uuid(ventureId) },
      ),
    );
    try {
      await expect(codeOf(h.core.reader.sourceText(maya, ventureId, programSourceId))).resolves.toBe(
        'not_found',
      );
    } finally {
      await h.t.db.system((sx) =>
        sx.query(
          "UPDATE assignments SET data_class_ceiling = 'venture_private' WHERE venture_id = :v AND status = 'active'",
          { v: p.uuid(ventureId) },
        ),
      );
    }
    // Someone with no relationship to the venture opens nothing through it.
    await expect(codeOf(h.core.reader.sourceText(jonah, ventureId, programSourceId))).resolves.toBe(
      'not_found',
    );
  });

  it('opens a vEIR’s own library only for EIR-studio roles', async () => {
    await expect(codeOf(h.core.reader.sourceText(maya, ventureId, personaSourceId))).resolves.toBe(
      'not_found',
    );
    await expect(codeOf(h.core.reader.sourceText(graham, ventureId, personaSourceId))).resolves.toBe(
      'not_found',
    );
    const text = await h.core.reader.sourceText(corin, ventureId, personaSourceId);
    expect(text.source.scope).toBe('persona');
  });
});
