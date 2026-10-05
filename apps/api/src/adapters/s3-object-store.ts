import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ObjectNotFoundError,
  type ObjectStore,
  ObjectTooLargeError,
  type PresignedUpload,
  type PresignPutInput,
} from '@foundry/core';

import { UPLOAD_URL_TTL_SECONDS } from '../config.js';

/** Every venture document key lives under this prefix (bucket policy and IAM scope it). */
export const DOCUMENT_KEY_PREFIX = 'tenants/';

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: S3Client;
  /** Upper bound on presigned URL lifetime (default 5 minutes). */
  readonly maxPresignSeconds?: number;
  readonly now?: () => Date;
}

function assertDocumentKey(key: string): void {
  if (!key.startsWith(DOCUMENT_KEY_PREFIX) || key.includes('..') || key.includes('//') || key.length > 1024) {
    throw new TypeError('object key is outside the documents prefix');
  }
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || status === 404;
}

/**
 * Creates the S3 client used for documents. Flexible checksums are only computed when an operation
 * requires them: the SDK default would add a CRC32 of the *empty* presign body to the URL, and S3 would
 * then reject the browser's upload.
 */
export function createS3Client(region: string, overrides: Omit<S3ClientConfig, 'region'> = {}): S3Client {
  return new S3Client({
    ...overrides,
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Documents bucket adapter (core `ObjectStore` port).
 *
 * - `presignPut`: SigV4 query-signed PUT that signs `content-type` and `content-length`, so the browser
 *   must upload exactly the declared type and size; at most 5 minutes; keys under `tenants/` only.
 * - `getObject`: rejects objects above `maxBytes` from ContentLength before reading the payload.
 * - `delete`: idempotent (S3 returns 204 for missing keys).
 */
export class S3ObjectStore implements ObjectStore {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #maxPresignSeconds: number;
  readonly #now: () => Date;

  constructor(options: S3ObjectStoreOptions) {
    this.#bucket = options.bucket;
    this.#client = options.client ?? createS3Client(options.region);
    this.#maxPresignSeconds = options.maxPresignSeconds ?? UPLOAD_URL_TTL_SECONDS;
    this.#now = options.now ?? (() => new Date());
  }

  async presignPut(input: PresignPutInput): Promise<PresignedUpload> {
    assertDocumentKey(input.key);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
      throw new TypeError('contentLength must be a positive integer');
    }
    const expiresIn = Math.max(60, Math.min(input.expiresInSeconds, this.#maxPresignSeconds));
    const signedAt = this.#now();
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });
    const url = await getSignedUrl(this.#client, command, {
      expiresIn,
      signingDate: signedAt,
      // Both are bound into the signature: a different type or size fails with 403 at S3.
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      // Content-Length is set by the browser from the body (it cannot be set by scripts).
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(signedAt.getTime() + expiresIn * 1000).toISOString(),
    };
  }

  async getObject(key: string, options: { readonly maxBytes: number }): Promise<Uint8Array> {
    assertDocumentKey(key);
    let response;
    try {
      response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError('object not found');
      throw err;
    }
    const body = response.Body;
    if (body === undefined) throw new ObjectNotFoundError('object has no body');
    if (response.ContentLength !== undefined && response.ContentLength > options.maxBytes) {
      // Release the connection without reading the payload.
      (body as { destroy?: () => void }).destroy?.();
      throw new ObjectTooLargeError('object too large');
    }
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > options.maxBytes) throw new ObjectTooLargeError('object too large');
    return bytes;
  }

  async delete(key: string): Promise<void> {
    assertDocumentKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
