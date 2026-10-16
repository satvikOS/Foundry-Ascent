/**
 * The document viewer's endpoints through the Hono app against a real database: presigned GETs of a
 * document's file, the text of a cited source, and the development-only download route that stands in
 * for S3's presigned GETs.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProblemDetails } from '@foundry/contracts';
import { DocumentFileResponse, SourceTextResponse } from '@foundry/contracts/viewer';
import { type IngestDocumentJob } from '@foundry/core';
import { documentsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalObjectStore } from './adapters/local-object-store.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let maya: string;
let priya: string;
let dir: string;

beforeAll(async () => {
  api = await createApiHarness();
  [maya, priya] = await Promise.all([api.signInAs(api.h.people.maya), api.signInAs(api.h.people.priya)]);
  dir = await mkdtemp(join(tmpdir(), 'fa-viewer-'));
});
afterAll(async () => {
  await api.cleanup();
  await rm(dir, { recursive: true, force: true });
});

const quietquad = (): string => api.h.ventures.quietquad.id;

async function problemCode(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  return ProblemDetails.parse(await res.json()).code;
}

/** A ready markdown document of QuietQuad's with its passages; returns the document and source ids. */
async function readyDocument(body: string): Promise<{ documentId: string; sourceId: string }> {
  const ctx = await api.h.ctxFor(api.h.people.maya);
  const created = await api.h.core.documents.createUpload(ctx, quietquad(), {
    filename: 'Library visits.md',
    contentType: 'text/markdown',
    sizeBytes: Buffer.byteLength(body),
  });
  const presigned = api.h.objectStore.presigned.at(-1);
  if (!presigned) throw new Error('no presign');
  api.h.objectStore.put(presigned.key, body);
  await api.h.core.documents.complete(ctx, created.document.id);
  const job = api.h.jobQueue
    .drain()
    .find(
      (j): j is IngestDocumentJob => j.type === 'ingest_document' && j.documentId === created.document.id,
    );
  if (!job) throw new Error('no ingestion job');
  await api.h.core.ingestion.process(job, { requestId: 'viewer-ingest', attempt: 1 });
  const listed = await api.h.core.documents.list(ctx, quietquad());
  const sourceId = listed.find((d) => d.id === created.document.id)?.sourceId;
  if (!sourceId) throw new Error('document was not ingested');
  return { documentId: created.document.id, sourceId };
}

describe('GET /documents/:id/file', () => {
  it('returns a presigned GET to a venture reader (to show, or to save), and 404 to anyone else', async () => {
    const { documentId } = await readyDocument('# Library visits\n\nFive of six left without a seat.\n');
    const res = await api.request(`/documents/${documentId}/file`, { cookie: maya });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const file = DocumentFileResponse.parse(await res.json());
    expect(file.url).toContain('disposition=inline');
    const saved = DocumentFileResponse.parse(
      await (
        await api.request(`/documents/${documentId}/file?disposition=attachment`, { cookie: maya })
      ).json(),
    );
    expect(saved.url).toContain('disposition=attachment');
    expect(
      await problemCode(
        await api.request(`/documents/${documentId}/file?disposition=preview`, { cookie: maya }),
        422,
      ),
    ).toBe('validation_failed');
    expect(
      await problemCode(await api.request(`/documents/${documentId}/file`, { cookie: priya }), 404),
    ).toBe('not_found');
    expect(await problemCode(await api.request(`/documents/${documentId}/file`), 401)).toBe(
      'unauthenticated',
    );
  });

  it('answers 409 while the file has not been uploaded', async () => {
    const id = randomUUID();
    await api.h.t.db.system((sx) =>
      documentsRepo.createDocument(sx, {
        id,
        tenantId: api.h.seed.tenantId,
        ventureId: quietquad(),
        filename: 'pending.md',
        contentType: 'text/markdown',
        sizeBytes: 10,
        s3Key: `tenants/${api.h.seed.tenantId}/ventures/${quietquad()}/documents/${id}/pending.md`,
        uploadedBy: api.h.people.maya,
      }),
    );
    expect(await problemCode(await api.request(`/documents/${id}/file`, { cookie: maya }), 409)).toBe(
      'conflict',
    );
  });
});

describe('GET /ventures/:id/sources/:sourceId/text', () => {
  it('returns the passages in order, or the one cited', async () => {
    const { documentId, sourceId } = await readyDocument(
      '# Library visits\n\n## Findings\n\nFive of six left without a seat.\n\n## Next\n\nAsk the library.\n',
    );
    const path = `/ventures/${quietquad()}/sources/${sourceId}/text`;
    const all = SourceTextResponse.parse(await (await api.request(path, { cookie: maya })).json());
    expect(all.source).toMatchObject({ id: sourceId, scope: 'venture', documentId });
    expect(all.passages.length).toBeGreaterThan(0);
    expect(all.passages.map((x) => x.text).join('\n')).toContain('Five of six left without a seat.');

    const first = all.passages[0];
    if (!first) throw new Error('no passage');
    const one = SourceTextResponse.parse(
      await (await api.request(`${path}?passage=${first.id}`, { cookie: maya })).json(),
    );
    expect(one.passages).toEqual([first]);
    expect(await problemCode(await api.request(`${path}?passage=not-an-id`, { cookie: maya }), 422)).toBe(
      'validation_failed',
    );
    expect(await problemCode(await api.request(path, { cookie: priya }), 404)).toBe('not_found');
  });

  it('lists both endpoints as authenticated, read-only routes', () => {
    expect(api.app.routeTable).toContainEqual({
      method: 'GET',
      path: '/documents/:id/file',
      auth: 'session',
      idempotency: 'none',
    });
    expect(api.app.routeTable).toContainEqual({
      method: 'GET',
      path: '/ventures/:id/sources/:sourceId/text',
      auth: 'session',
      idempotency: 'none',
    });
  });
});

describe('GET /_local/objects/:token (development only)', () => {
  const key = (): string =>
    `tenants/${api.h.seed.tenantId}/ventures/${quietquad()}/documents/${randomUUID()}/notes.md`;

  it('serves a presigned download with its type, disposition and CORS for local origins', async () => {
    const store = new LocalObjectStore({
      directory: dir,
      publicOrigin: 'http://localhost:5173',
      maxUploadBytes: 1024,
    });
    const app = api.appWith({ appEnv: 'development', localUploads: store });
    const objectKey = key();
    const upload = await store.presignPut({
      key: objectKey,
      contentType: 'text/markdown',
      contentLength: 7,
      expiresInSeconds: 60,
    });
    await store.receive(
      upload.url.split('/_local/uploads/')[1] ?? '',
      'text/markdown',
      Buffer.from('# Notes'),
    );
    const view = await store.presignGet({
      key: objectKey,
      disposition: 'inline',
      filename: 'notes.md',
      contentType: 'text/markdown',
      expiresInSeconds: 60,
    });
    const path = new URL(view.url).pathname;
    const res = await app.request(
      new Request(`http://localhost${path}`, { headers: { origin: 'http://localhost:5183' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# Notes');
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="notes\.md"/);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5183');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    // A foreign origin gets no CORS grant; a tampered token is refused.
    const foreign = await app.request(
      new Request(`http://localhost${path}`, { headers: { origin: 'https://evil.example' } }),
    );
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect((await app.request(new Request(`http://localhost${path}x`))).status).toBe(403);
  });

  it('is not mounted outside development', () => {
    expect(api.app.routeTable.some((r) => r.path.startsWith('/_local/'))).toBe(false);
  });
});
