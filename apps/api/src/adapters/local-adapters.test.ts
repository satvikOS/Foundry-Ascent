import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type JobMessage,
  ObjectNotFoundError,
  ObjectTooLargeError,
  RetryableIngestionError,
} from '@foundry/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('InlineJobQueue', () => {
  const job: JobMessage = {
    type: 'ingest_document',
    documentId: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    ventureId: '22222222-2222-4222-8222-222222222222',
    requestId: 'req-1',
  };

  it('processes jobs after enqueue returns and retries transient failures', async () => {
    const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1 });
    const attempts: number[] = [];
    queue.attach((_job, { attempt }) => {
      attempts.push(attempt);
      return attempt < 2 ? Promise.reject(new RetryableIngestionError('transient')) : Promise.resolve();
    });
    await queue.enqueue(job);
    expect(attempts).toEqual([]);
    await queue.idle();
    expect(attempts).toEqual([1, 2]);
  });

  it('does not retry permanent failures and refuses jobs without a processor', async () => {
    const queue = new InlineJobQueue({ logger: silentLogger, retryDelayMs: 1 });
    await expect(queue.enqueue(job)).rejects.toThrow();
    let calls = 0;
    queue.attach(() => {
      calls += 1;
      return Promise.reject(new Error('permanent'));
    });
    await queue.enqueue(job);
    await queue.idle();
    expect(calls).toBe(1);
  });
});
