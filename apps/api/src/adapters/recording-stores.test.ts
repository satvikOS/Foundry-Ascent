import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeleteObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LocalUploadRejectedError } from './local-object-store.js';
import { LocalRecordingStore, parseRange } from './local-recording-store.js';
import { createS3Client } from './s3-object-store.js';
import { isRecordingKey, S3RecordingStore } from './s3-recording-store.js';

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const prefix =
  'tenants/11111111-1111-4111-8111-111111111111/ventures/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/recordings/44444444-4444-4444-8444-444444444444';
const media = `${prefix}/call.webm`;
const captions = `${prefix}/captions.vtt`;
const NOW = new Date('2026-11-06T12:00:00.000Z');

function s3With(client: S3Client, logger = { warn: vi.fn() }): S3RecordingStore {
  return new S3RecordingStore({
    bucket: 'foundry-recordings',
    region: 'us-east-1',
    client,
    now: () => NOW,
    logger,
  });
}

describe('recording keys', () => {
  it('are a conversation’s recording files under tenants/, nothing else', () => {
    expect(isRecordingKey(media)).toBe(true);
    expect(isRecordingKey(captions)).toBe(true);
    expect(isRecordingKey(`${prefix}/call.mp4`)).toBe(true);
    expect(isRecordingKey(`${prefix}/notes.md`)).toBe(false);
    expect(isRecordingKey(media.replace('/sessions/', '/documents/'))).toBe(false);
    expect(isRecordingKey(`site/${media}`)).toBe(false);
    expect(isRecordingKey(media.replace('tenants/', 'tenants/../'))).toBe(false);
  });
});

describe('S3RecordingStore', () => {
  it('signs a 5-minute PUT binding the type and the exact size, without checksum parameters', async () => {
    const store = s3With(createS3Client('us-east-1', { credentials }));
    const upload = await store.presignPut({
      key: media,
      contentType: 'video/webm',
      contentLength: 4_096,
      expiresInSeconds: 900,
    });
    const url = new URL(upload.url);
    expect(url.hostname).toBe('foundry-recordings.s3.us-east-1.amazonaws.com');
    expect(decodeURIComponent(url.pathname)).toBe(`/${media}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    for (const name of url.searchParams.keys()) expect(name.toLowerCase()).not.toContain('checksum');
    expect(upload.headers).toEqual({ 'content-type': 'video/webm' });
    expect(upload.expiresAt).toBe('2026-11-06T12:05:00.000Z');
  });

  it('signs a replay GET as long as asked (at most 4 hours), typed and never cached', async () => {
    const store = s3With(createS3Client('us-east-1', { credentials }));
    const replay = await store.presignGet({
      key: captions,
      contentType: 'text/vtt',
      expiresInSeconds: 1_800,
    });
    const url = new URL(replay.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('1800');
    expect(url.searchParams.get('response-content-type')).toBe('text/vtt');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(replay.expiresAt).toBe('2026-11-06T12:30:00.000Z');
    const long = await store.presignGet({ key: media, contentType: 'video/webm', expiresInSeconds: 99_999 });
    expect(new URL(long.url).searchParams.get('X-Amz-Expires')).toBe('14400');
  });

  it('signs a download GET that saves the file under its name (attachment), and a replay GET that does not', async () => {
    const store = s3With(createS3Client('us-east-1', { credentials }));
    const download = await store.presignGet({
      key: media,
      contentType: 'video/webm',
      expiresInSeconds: 300,
      downloadAs: 'Thomas call 2026-11-07 14-22.webm',
    });
    const url = new URL(download.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('video/webm');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Thomas call 2026-11-07 14-22.webm"; filename*=UTF-8''Thomas%20call%202026-11-07%2014-22.webm`,
    );
    const replay = await store.presignGet({ key: media, contentType: 'video/webm', expiresInSeconds: 300 });
    expect(new URL(replay.url).searchParams.has('response-content-disposition')).toBe(false);
  });

  it('refuses anything but a recording key', async () => {
    const store = s3With(createS3Client('us-east-1', { credentials }));
    await expect(
      store.presignPut({
        key: 'site/index.html',
        contentType: 'video/webm',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.presignGet({ key: `${prefix}/x.pdf`, contentType: 'video/webm', expiresInSeconds: 60 }),
    ).rejects.toThrow(TypeError);
    await expect(store.delete('tenants/x')).rejects.toThrow(TypeError);
    await expect(
      store.presignPut({ key: media, contentType: 'video/webm', contentLength: 0, expiresInSeconds: 60 }),
    ).rejects.toThrow(TypeError);
  });

  it('measures an upload with HEAD (null when it never arrived, a 403 logged) and deletes idempotently', async () => {
    const missing = Object.assign(new Error('not found'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const forbidden = Object.assign(new Error('forbidden'), {
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ContentLength: 4_096 })
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(forbidden)
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({});
    const logger = { warn: vi.fn() };
    const store = s3With({ send } as unknown as S3Client, logger);
    expect(await store.size(media)).toBe(4_096);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(await store.size(media)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    // Without ListBucket S3 answers a missing key with 403: not uploaded, but said, so a real denial shows (no key).
    expect(await store.size(media)).toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('recordings.head_denied', { status: 403 });
    await expect(store.size(media)).rejects.toThrow('throttled');
    await store.delete(captions);
    const deleted = send.mock.calls[4]?.[0] as DeleteObjectCommand;
    expect(deleted).toBeInstanceOf(DeleteObjectCommand);
    expect(deleted.input).toEqual({ Bucket: 'foundry-recordings', Key: captions });
  });
});

describe('LocalRecordingStore', () => {
  let dir: string;
  let now = NOW;
  let store: LocalRecordingStore;
  const tokenOf = (url: string): string => url.split('/_local/recordings/')[1] ?? '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fa-local-recordings-'));
    store = new LocalRecordingStore({ directory: dir, origin: 'http://localhost:8787/', now: () => now });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts exactly the signed upload and serves it back, whole or by byte range', async () => {
    const upload = await store.presignPut({
      key: media,
      contentType: 'video/webm',
      contentLength: 10,
      expiresInSeconds: 300,
    });
    expect(upload.url).toMatch(/^http:\/\/localhost:8787\/api\/v1\/_local\/recordings\//);
    const body = new TextEncoder().encode('0123456789');
    const token = tokenOf(upload.url);
    await expect(store.receive(token, 'video/mp4', body)).rejects.toBeInstanceOf(LocalUploadRejectedError);
    await expect(store.receive(token, 'video/webm', body.slice(1))).rejects.toBeInstanceOf(
      LocalUploadRejectedError,
    );
    await expect(store.receive(`${token}x`, 'video/webm', body)).rejects.toBeInstanceOf(
      LocalUploadRejectedError,
    );
    await store.receive(token, 'video/webm;codecs=vp8,opus', body);
    expect(await store.size(media)).toBe(10);

    const replay = await store.presignGet({ key: media, contentType: 'video/webm', expiresInSeconds: 1_800 });
    const get = tokenOf(replay.url);
    // A GET token never uploads, and an upload token never reads.
    await expect(store.receive(get, 'video/webm', body)).rejects.toBeInstanceOf(LocalUploadRejectedError);
    await expect(store.read(token, undefined)).rejects.toBeInstanceOf(LocalUploadRejectedError);
    const whole = await store.read(get, undefined);
    expect(new TextDecoder().decode(whole.body)).toBe('0123456789');
    expect(whole).toMatchObject({
      contentType: 'video/webm',
      contentDisposition: null,
      size: 10,
      range: null,
    });
    const part = await store.read(get, 'bytes=2-5');
    expect(new TextDecoder().decode(part.body)).toBe('2345');
    expect(part.range).toEqual({ start: 2, end: 5 });

    now = new Date(NOW.getTime() + 2 * 3_600_000);
    await expect(store.read(get, undefined)).rejects.toMatchObject({ status: 403 });
    now = NOW;
    await store.delete(media);
    expect(await store.size(media)).toBeNull();
    await expect(store.read(get, undefined)).rejects.toMatchObject({ status: 404 });
    await store.delete(media);
  });

  it('serves a download as an attachment under the name it was signed with', async () => {
    const upload = await store.presignPut({
      key: captions,
      contentType: 'text/vtt',
      contentLength: 6,
      expiresInSeconds: 300,
    });
    await store.receive(tokenOf(upload.url), 'text/vtt', new TextEncoder().encode('WEBVTT'));
    const download = await store.presignGet({
      key: captions,
      contentType: 'text/vtt',
      expiresInSeconds: 300,
      downloadAs: 'Maya’s vEIR call 2026-11-07 09-05 transcript.vtt',
    });
    const file = await store.read(tokenOf(download.url), undefined);
    expect(file).toMatchObject({ contentType: 'text/vtt', size: 6, range: null });
    expect(file.contentDisposition).toBe(
      `attachment; filename="Maya_s vEIR call 2026-11-07 09-05 transcript.vtt"; filename*=UTF-8''Maya%E2%80%99s%20vEIR%20call%202026-11-07%2009-05%20transcript.vtt`,
    );
    await store.delete(captions);
  });

  it('parses one byte range of a file', () => {
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=4-100', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBeNull();
    expect(parseRange('bytes=5-2', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange(undefined, 10)).toBeNull();
  });
});
