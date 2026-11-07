import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { RECORDING_LIMITS } from '@foundry/contracts';
import {
  type PresignedDownload,
  type PresignedUpload,
  type RecordingGetInput,
  type RecordingPutInput,
  type RecordingStore,
} from '@foundry/core';

import { UPLOAD_URL_TTL_SECONDS } from '../config.js';
import { type Logger } from '../logging.js';
import { createS3Client, presignBoundPut } from './s3-object-store.js';

/** Every recording key lives under this prefix (the bucket's IAM scopes it): `tenants/{t}/ventures/{v}/sessions/…`. */
export const RECORDING_KEY_PREFIX = 'tenants/';

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

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound' || statusOf(err) === 404)
  );
}

export interface S3RecordingStoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: S3Client;
  readonly now?: () => Date;
  /** Where a HEAD that S3 refused is reported (`recordings.head_denied`). */
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Recordings bucket adapter (core `RecordingStore` port; ADR-0023).
 *
 * - `presignPut`: SigV4 query-signed PUT binding `content-type` and `content-length`, so the browser uploads exactly
 *   the declared type and size; at most 5 minutes to start; recording keys only.
 * - `presignGet`: SigV4 query-signed GET whose response type is fixed and never cached, valid as long as core asks
 *   (the recording's length and a margin, at most `RECORDING_LIMITS.maxPlaybackUrlSeconds`): the player streams it
 *   with range requests for as long as someone watches.
 * - `size`: HeadObject; null for a key that is not there. The functions may not list the bucket (ADR-0023 §8), so S3
 *   answers a HEAD of a missing key with 403, not 404: a 403 is taken as "not uploaded yet" too, and logged
 *   (`recordings.head_denied`, without the key) so that a real denial (a policy regression, the wrong bucket) shows.
 * - `delete`: idempotent.
 */
export class S3RecordingStore implements RecordingStore {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #now: () => Date;
  readonly #logger: Pick<Logger, 'warn'>;

  constructor(options: S3RecordingStoreOptions) {
    this.#bucket = options.bucket;
    this.#client = options.client ?? createS3Client(options.region);
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  async presignPut(input: RecordingPutInput): Promise<PresignedUpload> {
    assertRecordingKey(input.key);
    return presignBoundPut(this.#client, this.#bucket, input, {
      maxSeconds: UPLOAD_URL_TTL_SECONDS,
      signedAt: this.#now(),
    });
  }

  async presignGet(input: RecordingGetInput): Promise<PresignedDownload> {
    assertRecordingKey(input.key);
    const expiresIn = Math.max(60, Math.min(input.expiresInSeconds, RECORDING_LIMITS.maxPlaybackUrlSeconds));
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
      if (isNotFound(err)) return null;
      if (statusOf(err) === 403) {
        this.#logger.warn('recordings.head_denied', { status: 403 });
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertRecordingKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
