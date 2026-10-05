import { DeleteObjectCommand, GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ObjectNotFoundError, ObjectTooLargeError } from '@foundry/core';
import { describe, expect, it, vi } from 'vitest';

import { createS3Client, S3ObjectStore } from './s3-object-store.js';
import { SqsJobQueue } from './sqs-job-queue.js';

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const key =
  'tenants/11111111-1111-4111-8111-111111111111/ventures/22222222-2222-4222-8222-222222222222/documents/33333333-3333-4333-8333-333333333333/plan.pdf';

function storeWith(client: S3Client, now = new Date('2026-10-05T12:00:00.000Z')): S3ObjectStore {
  return new S3ObjectStore({ bucket: 'foundry-docs', region: 'us-east-1', client, now: () => now });
}

describe('S3ObjectStore.presignPut', () => {
  it('signs content-type and content-length, expires in 5 minutes and adds no checksum parameters', async () => {
    const store = storeWith(createS3Client('us-east-1', { credentials }));
    const upload = await store.presignPut({
      key,
      contentType: 'application/pdf',
      contentLength: 1234,
      expiresInSeconds: 900,
    });
    const url = new URL(upload.url);
    expect(url.hostname).toBe('foundry-docs.s3.us-east-1.amazonaws.com');
    expect(decodeURIComponent(url.pathname)).toBe(`/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261005T120000Z');
    for (const name of url.searchParams.keys()) {
      expect(name.toLowerCase()).not.toContain('checksum');
    }
    expect(upload.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(upload.expiresAt).toBe('2026-10-05T12:05:00.000Z');
  });

  it('refuses keys outside the documents prefix and bad lengths', async () => {
    const store = storeWith(createS3Client('us-east-1', { credentials }));
    await expect(
      store.presignPut({
        key: 'site/index.html',
        contentType: 'text/plain',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.presignPut({
        key: 'tenants/../x',
        contentType: 'text/plain',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.presignPut({ key, contentType: 'text/plain', contentLength: 0, expiresInSeconds: 60 }),
    ).rejects.toThrow(TypeError);
  });
});

describe('S3ObjectStore.getObject / delete', () => {
  function fakeClient(handler: (command: unknown) => unknown): {
    client: S3Client;
    send: ReturnType<typeof vi.fn>;
  } {
    const client = createS3Client('us-east-1', { credentials });
    const send = vi.fn((command: unknown) => Promise.resolve().then(() => handler(command)));
    (client as unknown as { send: typeof send }).send = send;
    return { client, send };
  }

  it('returns the bytes', async () => {
    const { client, send } = fakeClient(() => ({
      ContentLength: 3,
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
    }));
    await expect(storeWith(client).getObject(key, { maxBytes: 10 })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    const command: unknown = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({ Bucket: 'foundry-docs', Key: key });
  });

  it('maps missing objects and enforces maxBytes before reading', async () => {
    const missing = fakeClient(() => {
      throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    });
    await expect(storeWith(missing.client).getObject(key, { maxBytes: 10 })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );

    const destroy = vi.fn();
    const read = vi.fn();
    const large = fakeClient(() => ({ ContentLength: 11, Body: { destroy, transformToByteArray: read } }));
    await expect(storeWith(large.client).getObject(key, { maxBytes: 10 })).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
    expect(destroy).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    const sneaky = fakeClient(() => ({
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(11)) },
    }));
    await expect(storeWith(sneaky.client).getObject(key, { maxBytes: 10 })).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
  });

  it('deletes within the prefix only', async () => {
    const { client, send } = fakeClient(() => ({}));
    await storeWith(client).delete(key);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    await expect(storeWith(client).delete('other/thing')).rejects.toThrow(TypeError);
  });
});

describe('SqsJobQueue', () => {
  const job = {
    type: 'ingest_document' as const,
    documentId: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    ventureId: '22222222-2222-4222-8222-222222222222',
    requestId: 'req-1',
  };

  function queue(url: string): { queue: SqsJobQueue; send: ReturnType<typeof vi.fn> } {
    const client = new SQSClient({ region: 'us-east-1', credentials });
    const send = vi.fn(() => Promise.resolve({ MessageId: 'm' }));
    (client as unknown as { send: typeof send }).send = send;
    return { queue: new SqsJobQueue({ queueUrl: url, region: 'us-east-1', client }), send };
  }

  it('sends the job as JSON (standard queue: no FIFO fields)', async () => {
    const { queue: q, send } = queue('https://sqs.us-east-1.amazonaws.com/123456789012/FoundryAscent-Jobs');
    await q.enqueue(job, { deduplicationId: 'doc:1' });
    const command = send.mock.calls[0]?.[0] as unknown as SendMessageCommand;
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(JSON.parse(command.input.MessageBody ?? '')).toEqual(job);
    expect(command.input.MessageDeduplicationId).toBeUndefined();
    expect(command.input.MessageAttributes?.jobType?.StringValue).toBe('ingest_document');
  });

  it('uses group and deduplication ids on FIFO queues', async () => {
    const { queue: q, send } = queue('https://sqs.us-east-1.amazonaws.com/123456789012/jobs.fifo');
    await q.enqueue(job, { deduplicationId: 'doc:1' });
    const command = send.mock.calls[0]?.[0] as unknown as SendMessageCommand;
    expect(command.input).toMatchObject({ MessageGroupId: job.ventureId, MessageDeduplicationId: 'doc:1' });
  });
});
