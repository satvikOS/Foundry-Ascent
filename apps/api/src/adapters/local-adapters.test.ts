import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type JobMessage, ObjectNotFoundError, ObjectTooLargeError } from '@foundry/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../logging.js';
import { InlineJobQueue } from './inline-job-queue.js';
import { LocalObjectStore, LocalUploadRejectedError } from './local-object-store.js';

const key = 'tenants/t/ventures/v/documents/d/notes.md';
let dir: string;
let now = new Date('2026-10-05T12:00:00Z');
let store: LocalObjectStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fa-local-store-'));
  store = new LocalObjectStore({
    directory: dir,
    publicOrigin: 'http://localhost:5173/',
    maxUploadBytes: 1000,
    now: () => now,
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tokenOf(url: string): string {
  return url.split('/_local/uploads/')[1] ?? '';
}

describe('LocalObjectStore', () => {
  it('issues same-origin presigned URLs and accepts exactly the signed upload', async () => {
    const upload = await store.presignPut({
      key,
      contentType: 'text/markdown',
      contentLength: 5,
      expiresInSeconds: 900,
    });
    expect(upload.url).toMatch(/^http:\/\/localhost:5173\/api\/v1\/_local\/uploads\//);
    expect(upload.expiresAt).toBe('2026-10-05T12:05:00.000Z');
    const token = tokenOf(upload.url);
    const body = new TextEncoder().encode('hello');
    await expect(store.receive(token, 'text/plain', body)).rejects.toBeInstanceOf(LocalUploadRejectedError);
    await expect(
      store.receive(token, 'text/markdown', new TextEncoder().encode('hello!')),
    ).rejects.toBeInstanceOf(LocalUploadRejectedError);
    await expect(store.receive(`${token}x`, 'text/markdown', body)).rejects.toBeInstanceOf(
      LocalUploadRejectedError,
    );
    await store.receive(token, 'text/markdown; charset=utf-8', body);
    expect(new TextDecoder().decode(await store.getObject(key, { maxBytes: 10 }))).toBe('hello');
    await expect(store.getObject(key, { maxBytes: 4 })).rejects.toBeInstanceOf(ObjectTooLargeError);
    await store.delete(key);
    await expect(store.getObject(key, { maxBytes: 10 })).rejects.toBeInstanceOf(ObjectNotFoundError);
    await store.delete(key); // idempotent
  });

  it('rejects expired URLs and keys outside the storage root', async () => {
    const upload = await store.presignPut({
      key,
      contentType: 'text/plain',
      contentLength: 1,
      expiresInSeconds: 60,
    });
    now = new Date(now.getTime() + 61_000);
    await expect(store.receive(tokenOf(upload.url), 'text/plain', new Uint8Array(1))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      store.presignPut({
        key: 'tenants/../../etc/passwd',
        contentType: 'text/plain',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.presignPut({
        key: 'elsewhere/x',
        contentType: 'text/plain',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('LocalObjectStore downloads', () => {
  const downloadToken = (url: string): string => url.split('/_local/objects/')[1] ?? '';

  it('issues same-origin presigned GETs that serve the file with its type and disposition', async () => {
    const upload = await store.presignPut({
      key,
      contentType: 'text/markdown',
      contentLength: 7,
      expiresInSeconds: 60,
    });
    await store.receive(tokenOf(upload.url), 'text/markdown', new TextEncoder().encode('# Notes'));
    const view = await store.presignGet({
      key,
      disposition: 'inline',
      filename: 'Notes é.md',
      contentType: 'text/markdown',
      expiresInSeconds: 120,
    });
    expect(view.url).toMatch(/^http:\/\/localhost:5173\/api\/v1\/_local\/objects\//);
    const file = await store.serve(downloadToken(view.url));
    expect(new TextDecoder().decode(file.body)).toBe('# Notes');
    expect(file.contentType).toBe('text/markdown; charset=utf-8');
    expect(file.contentDisposition).toBe(`inline; filename="Notes e.md"; filename*=UTF-8''Notes%20%C3%A9.md`);

    // A download token cannot upload, an upload token cannot download, and a forged one does neither.
    await expect(
      store.receive(downloadToken(view.url), 'text/markdown', new TextEncoder().encode('# Notes')),
    ).rejects.toMatchObject({ status: 403 });
    await expect(store.serve(tokenOf(upload.url))).rejects.toMatchObject({ status: 403 });
    await expect(store.serve(`${downloadToken(view.url)}x`)).rejects.toMatchObject({ status: 403 });

    now = new Date(now.getTime() + 121_000);
    await expect(store.serve(downloadToken(view.url))).rejects.toMatchObject({ status: 403 });
    await store.delete(key);
  });

  it('signs GETs at another origin when given one (the end-to-end suite reads files cross-origin)', async () => {
    const crossOrigin = new LocalObjectStore({
      directory: dir,
      publicOrigin: 'http://localhost:5173',
      downloadOrigin: 'http://localhost:8787/',
      maxUploadBytes: 1024,
    });
    const view = await crossOrigin.presignGet({
      key,
      disposition: 'inline',
      filename: 'x.md',
      contentType: 'text/markdown',
      expiresInSeconds: 60,
    });
    expect(view.url).toMatch(/^http:\/\/localhost:8787\/api\/v1\/_local\/objects\//);
    // Uploads keep going through the app's own origin.
    const upload = await crossOrigin.presignPut({
      key,
      contentType: 'text/markdown',
      contentLength: 7,
      expiresInSeconds: 60,
    });
    expect(upload.url).toMatch(/^http:\/\/localhost:5173\/api\/v1\/_local\/uploads\//);
  });

  it('answers 404 for a file that is gone', async () => {
    const view = await store.presignGet({
      key: 'tenants/t/ventures/v/documents/gone/x.pdf',
      disposition: 'attachment',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      expiresInSeconds: 60,
    });
    await expect(store.serve(downloadToken(view.url))).rejects.toMatchObject({ status: 404 });
  });
});

describe('InlineJobQueue', () => {
  const job: JobMessage = {
    type: 'ingest_document',
    documentId: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    ventureId: '22222222-2222-4222-8222-222222222222',
    requestId: 'req-1',
  };
  const distill: JobMessage = {
    type: 'distill_session',
    sessionId: '44444444-4444-4444-8444-444444444444',
    tenantId: '11111111-1111-4111-8111-111111111111',
    ventureId: '22222222-2222-4222-8222-222222222222',
    requestId: 'req-2',
  };

  it('processes jobs after enqueue returns and retries the ones that ask for it', async () => {
    const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1 });
    const attempts: number[] = [];
    queue.attach((_job, { attempt }) => {
      attempts.push(attempt);
      return Promise.resolve(attempt < 2 ? 'retry' : 'done');
    });
    await queue.enqueue(job);
    expect(attempts).toEqual([]);
    await queue.idle();
    expect(attempts).toEqual([1, 2]);
  });

  it('stops after a crash and refuses jobs without a processor', async () => {
    const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1 });
    await expect(queue.enqueue(job)).rejects.toThrow();
    let calls = 0;
    queue.attach(() => {
      calls += 1;
      return Promise.reject(new Error('bug'));
    });
    await queue.enqueue(job);
    await queue.idle();
    expect(calls).toBe(1);
  });

  it('gives up after the last attempt', async () => {
    const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1, maxAttempts: 2 });
    let calls = 0;
    queue.attach(() => {
      calls += 1;
      return Promise.resolve('retry');
    });
    await queue.enqueue(job);
    await queue.idle();
    expect(calls).toBe(2);
  });

  it('runs a delayed job after its delay, like an SQS message with DelaySeconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1 });
      const seen: string[] = [];
      queue.attach((j) => {
        seen.push(j.type);
        return Promise.resolve('done');
      });
      await queue.enqueue(distill, { delaySeconds: 540 });
      await vi.advanceTimersByTimeAsync(539_000);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      await queue.idle();
      expect(seen).toEqual(['distill_session']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops delayed jobs on stop, refuses new ones and rejects delays SQS would refuse', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1 });
      let calls = 0;
      queue.attach(() => {
        calls += 1;
        return Promise.resolve('done');
      });
      await expect(queue.enqueue(distill, { delaySeconds: 901 })).rejects.toThrow(RangeError);
      await queue.enqueue(distill, { delaySeconds: 60 });
      queue.stop();
      await expect(queue.enqueue(job)).rejects.toThrow(/stopped/);
      await vi.advanceTimersByTimeAsync(120_000);
      await queue.idle();
      expect(calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
