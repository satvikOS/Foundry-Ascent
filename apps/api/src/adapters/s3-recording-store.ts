import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type PresignedDownload,
  type PresignedUpload,
  type RecordingGetInput,
  type RecordingPutInput,
  type RecordingStore,
} from '@foundry/core';

import { UPLOAD_URL_TTL_SECONDS } from '../config.js';
import { createS3Client } from './s3-object-store.js';

/** Every recording key lives under this prefix (the bucket's IAM scopes it): `tenants/{t}/ventures/{v}/sessions/…`. */
export const RECORDING_KEY_PREFIX = 'tenants/';
/** The longest a replay's presigned GET lasts (core asks for the recording's length and a margin, at most this). */
export const MAX_PLAYBACK_URL_SECONDS = 4 * 3_600;

/** A recording's file key: under the prefix, a conversation's `recordings/` folder, no traversal. */
export function isRecordingKey(key: string): boolean {
  return (
    key.startsWith(RECORDING_KEY_PREFIX) &&
    /\/sessions\/[0-9a-f-]{36}\/recordings\/[0-9a-f-]{36}\/(call\.(webm|mp4|m4a)|captions\.vtt)$/.test(key) &&
    !key.includes('..') &&
    !key.includes('//') &&
    key.length <= 512
  );
}

function assertRecordingKey(key: string): void {
  if (!isRecordingKey(key)) throw new TypeError('object key is not a recording file');
}

/**
 * A HEAD of a key that is not there: 404, or 403 where the role may not list the bucket for that request (a HeadObject
 * carries no `s3:prefix`, which the listing grant is conditioned on). The key is always one core built for this
 * recording, so either way the upload has not arrived.
 */
function isMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || status === 404 || status === 403;
}

export interface S3RecordingStoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: S3Client;
  readonly now?: () => Date;
}

/**
 * Recordings bucket adapter (core `RecordingStore` port; ADR-0023).
 *
 * - `presignPut`: SigV4 query-signed PUT binding `content-type` and `content-length`, so the browser uploads exactly
 *   the declared type and size; at most 5 minutes to start; recording keys only.
 * - `presignGet`: SigV4 query-signed GET whose response type is fixed and never cached, valid as long as core asks
 *   (the recording's length and a margin, at most {@link MAX_PLAYBACK_URL_SECONDS}): the player streams it with range
 *   requests for as long as someone watches.
 * - `size`: HeadObject (null for a key that is not there).
 * - `delete`: idempotent.
 */
export class S3RecordingStore implements RecordingStore {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #now: () => Date;

  constructor(options: S3RecordingStoreOptions) {
    this.#bucket = options.bucket;
    this.#client = options.client ?? createS3Client(options.region);
    this.#now = options.now ?? (() => new Date());
  }

  async presignPut(input: RecordingPutInput): Promise<PresignedUpload> {
    assertRecordingKey(input.key);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
      throw new TypeError('contentLength must be a positive integer');
    }
    const expiresIn = Math.max(60, Math.min(input.expiresInSeconds, UPLOAD_URL_TTL_SECONDS));
    const signedAt = this.#now();
    const url = await getSignedUrl(
      this.#client,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn, signingDate: signedAt, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      url,
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(signedAt.getTime() + expiresIn * 1000).toISOString(),
    };
  }

  async presignGet(input: RecordingGetInput): Promise<PresignedDownload> {
    assertRecordingKey(input.key);
    const expiresIn = Math.max(60, Math.min(input.expiresInSeconds, MAX_PLAYBACK_URL_SECONDS));
    const signedAt = this.#now();
    const url = await getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: input.key,
        ResponseContentType: input.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn, signingDate: signedAt },
    );
    return { url, expiresAt: new Date(signedAt.getTime() + expiresIn * 1000).toISOString() };
  }

  async size(key: string): Promise<number | null> {
    assertRecordingKey(key);
    try {
      const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return head.ContentLength ?? null;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertRecordingKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
