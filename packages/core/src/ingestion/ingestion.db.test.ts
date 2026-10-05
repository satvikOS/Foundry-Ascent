import { DocumentView, type TurnStreamEvent } from '@foundry/contracts';
import { auditRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { type IngestDocumentJob } from '../ports.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { RetryableIngestionError } from './processor.js';

let h: CoreHarness;
let maya: RequestContext;
let priya: RequestContext;
let ventureId: string;

const MARKER = 'zebracrossing telemetry';
const DOC = [
  '# Library occupancy pilot',
  '',
  'This memo summarises the door counter pilot.',
  '',
  '## Findings',
  '',
  `During finals week the ${MARKER} showed that the third floor fills by 10am.`,
  '',
  ...Array.from(
    { length: 40 },
    (_, i) => `Observation ${i + 1}: occupancy rose steadily on weekday mornings and fell after 6pm.`,
  ),
  '',
  '## Next steps',
  '',
  'Extend the counters to the science library.',
].join('\n');

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
  priya = await h.ctxFor(h.people.priya);
  ventureId = h.ventures.quietquad.id;
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

async function upload(
  filename: string,
  body: string,
): Promise<{ documentId: string; key: string; job: IngestDocumentJob }> {
  const created = await h.core.documents.createUpload(maya, ventureId, {
    filename,
    contentType: 'text/markdown',
    sizeBytes: Buffer.byteLength(body),
  });
  const presigned = h.objectStore.presigned.at(-1);
  if (!presigned) throw new Error('no presign');
  h.objectStore.put(presigned.key, body);
  const done = await h.core.documents.complete(maya, created.document.id);
  expect(done.status).toBe('processing');
  const jobs = h.jobQueue.drain();
  const job = jobs.find((j) => j.documentId === created.document.id);
  if (!job) throw new Error('job not enqueued');
  return { documentId: created.document.id, key: presigned.key, job };
}

async function chunkRows(
  documentId: string,
): Promise<{ venture_id: unknown; embedded: unknown; heading: unknown }[]> {
  const result = await h.t.db.system((sx) =>
    sx.query(
      `SELECT c.venture_id, c.embedding IS NOT NULL AS embedded, c.heading
       FROM knowledge_chunks c JOIN documents d ON d.source_id = c.source_id WHERE d.id = :id ORDER BY c.ordinal`,
      { id: p.uuid(documentId) },
    ),
  );
  return result.rows as { venture_id: unknown; embedded: unknown; heading: unknown }[];
}

describe('documents and ingestion', () => {
  it('registers an upload under the venture-scoped key and presigns with the declared length', async () => {
    const created = await h.core.documents.createUpload(maya, ventureId, {
      filename: 'Pilot notes (v2).md',
      contentType: 'text/markdown',
      sizeBytes: 1234,
    });
    DocumentView.parse(created.document);
    expect(created.document.status).toBe('pending_upload');
    expect(created.upload.method).toBe('PUT');
    const presigned = h.objectStore.presigned.at(-1);
    expect(presigned?.key).toBe(
      `tenants/${h.seed.tenantId}/ventures/${ventureId}/documents/${created.document.id}/Pilot-notes-(v2).md`,
    );
    expect(presigned?.contentLength).toBe(1234);
    await expect(
      h.core.documents.createUpload(maya, ventureId, {
        filename: '../etc/passwd',
        contentType: 'text/plain',
        sizeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.documents.createUpload(maya, ventureId, {
        filename: 'big.pdf',
        contentType: 'application/pdf',
        sizeBytes: 11 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('ingests into venture-scoped chunks with embeddings; retrieval finds them only in that venture', async () => {
    const { documentId, job } = await upload('occupancy-memo.md', DOC);
    expect(job).toMatchObject({ type: 'ingest_document', tenantId: h.seed.tenantId, ventureId });
    const result = await h.core.ingestion.process(job, { requestId: 'ingest-1', attempt: 1 });
    expect(result).toMatchObject({ status: 'ready', documentId });
    expect(result.chunks).toBeGreaterThan(1);

    const docs = await h.core.documents.list(maya, ventureId);
    const doc = docs.find((d) => d.id === documentId);
    expect(doc).toMatchObject({ status: 'ready', chunkCount: result.chunks });
    const rows = await chunkRows(documentId);
    expect(rows.length).toBe(result.chunks);
    for (const r of rows) {
      expect(r.venture_id).toBe(ventureId);
      expect(r.embedded).toBe(true);
    }
    expect(rows.some((r) => String(r.heading).includes('Findings'))).toBe(true);

    // Same question in two ventures: only QuietQuad sees the document.
    const ask = async (ctx: RequestContext, vId: string): Promise<string> => {
      const session = await h.core.sessions.create(ctx, vId, {});
      const events: TurnStreamEvent[] = [];
      await h.core.orchestrator.runTurn(ctx, session.id, { text: `What did the ${MARKER} show?` }, (e) => {
        events.push(e);
      });
      return JSON.stringify(events);
    };
    expect(await ask(maya, ventureId)).toContain('occupancy-memo.md');
    const other = await ask(priya, h.ventures.benchtally.id);
    expect(other).not.toContain('occupancy-memo.md');
    expect(other).not.toContain('third floor fills by 10am');

    // Processing the same job again is a no-op.
    await expect(h.core.ingestion.process(job, { requestId: 'ingest-2' })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'status_ready',
    });
  });

  it('rejects a job whose ids do not match the document row', async () => {
    const { documentId, job } = await upload('scoped.md', '# Scoped\n\nOnly for QuietQuad.');
    const forged = { ...job, ventureId: h.ventures.benchtally.id };
    await expect(h.core.ingestion.process(forged, { requestId: 'forged-1' })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'scope_mismatch',
    });
    expect(await chunkRows(documentId)).toEqual([]);
    const audit = await h.t.db.system((sx) =>
      auditRepo.listAuditEvents(sx, { action: 'ingestion.rejected' }),
    );
    expect(audit.items.some((e) => e.objectId === documentId)).toBe(true);
    await expect(h.core.ingestion.process({ type: 'nope' }, { requestId: 'bad' })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'invalid_job',
    });
  });

  it('marks unreadable, empty or missing files failed, and retries after a new complete()', async () => {
    const corrupt = await upload('corrupt.pdf', '%CORRUPT binary');
    await expect(h.core.ingestion.process(corrupt.job, { requestId: 'c1' })).resolves.toMatchObject({
      status: 'failed',
      reason: 'extract_failed',
    });
    let doc = (await h.core.documents.list(maya, ventureId)).find((d) => d.id === corrupt.documentId);
    expect(doc).toMatchObject({ status: 'failed', failureReason: 'extract_failed' });

    h.objectStore.put(corrupt.key, '# Fixed\n\nReadable now with enough words to chunk.');
    const retried = await h.core.documents.complete(maya, corrupt.documentId);
    expect(retried.status).toBe('processing');
    const [job] = h.jobQueue.drain();
    if (!job) throw new Error('no retry job');
    await expect(h.core.ingestion.process(job, { requestId: 'c2' })).resolves.toMatchObject({
      status: 'ready',
    });

    const empty = await upload('empty.md', '   \n\n  ');
    await expect(h.core.ingestion.process(empty.job, { requestId: 'e1' })).resolves.toMatchObject({
      reason: 'empty_text',
    });

    const missing = await upload('missing.md', 'temp');
    h.objectStore.objects.delete(missing.key);
    await expect(h.core.ingestion.process(missing.job, { requestId: 'm1' })).resolves.toMatchObject({
      reason: 'object_missing',
    });
    doc = (await h.core.documents.list(maya, ventureId)).find((d) => d.id === missing.documentId);
    expect(doc?.status).toBe('failed');
  });

  it('transient failures are retried by the queue, then fail after the last attempt', async () => {
    const { job, documentId } = await upload('flaky.md', '# Flaky\n\nNetwork trouble.');
    h.objectStore.failNextGet = new Error('socket hang up');
    await expect(
      h.core.ingestion.process(job, { requestId: 't1', attempt: 1, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableIngestionError);
    h.objectStore.failNextGet = new Error('socket hang up');
    await expect(
      h.core.ingestion.process(job, { requestId: 't3', attempt: 3, maxAttempts: 3 }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'retries_exhausted',
    });
    const doc = (await h.core.documents.list(maya, ventureId)).find((d) => d.id === documentId);
    expect(doc?.failureReason).toBe('retries_exhausted');
  });

  it('enqueue failure marks the document failed', async () => {
    const created = await h.core.documents.createUpload(maya, ventureId, {
      filename: 'queue.md',
      contentType: 'text/markdown',
      sizeBytes: 5,
    });
    h.jobQueue.failNext = true;
    await expect(h.core.documents.complete(maya, created.document.id)).rejects.toMatchObject({
      code: 'internal',
    });
    const doc = (await h.core.documents.list(maya, ventureId)).find((d) => d.id === created.document.id);
    expect(doc).toMatchObject({ status: 'failed', failureReason: 'enqueue_failed' });
  });

  it('delete removes chunks from retrieval and deletes the object', async () => {
    const { documentId, key, job } = await upload('to-delete.md', DOC.replace(MARKER, 'quokka migration'));
    await h.core.ingestion.process(job, { requestId: 'd1' });
    expect((await chunkRows(documentId)).length).toBeGreaterThan(0);
    await h.core.documents.remove(maya, documentId);
    expect(h.objectStore.deleted).toContain(key);
    expect((await h.core.documents.list(maya, ventureId)).map((d) => d.id)).not.toContain(documentId);
    const remaining = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*) AS n FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         JOIN documents d ON d.source_id = s.id WHERE d.id = :id`,
        { id: p.uuid(documentId) },
      ),
    );
    expect(Number(remaining.rows[0]?.n)).toBe(0);
    await expect(h.core.documents.remove(maya, documentId)).rejects.toMatchObject({ code: 'not_found' });
  });
});
