import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { API_PREFIX, DocumentContentType } from '@foundry/contracts';
import {
  ObjectNotFoundError,
  type ObjectStore,
  ObjectTooLargeError,
  type PresignedUpload,
  type PresignPutInput,
} from '@foundry/core';
import { z } from 'zod';

import { UPLOAD_URL_TTL_SECONDS } from '../config.js';
import { DOCUMENT_KEY_PREFIX } from './s3-object-store.js';

/** Route (relative to /api/v1) that receives local "presigned" uploads. Development only. */
export const LOCAL_UPLOAD_ROUTE = '/_local/uploads/:token';

const UploadClaims = z.object({
  k: z.string().min(1).max(1024),
  t: DocumentContentType,
  l: z.number().int().min(1),
  e: z.number().int(),
});
type UploadClaims = z.infer<typeof UploadClaims>;

export class LocalUploadRejectedError extends Error {
  override readonly name = 'LocalUploadRejectedError';
  constructor(
    readonly status: 400 | 403 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

/** Receives uploads for the local upload route (implemented by {@link LocalObjectStore}). */
export interface LocalUploadTarget {
  receive(token: string, contentType: string | undefined, body: Uint8Array): Promise<void>;
  /** Largest body the route should read. */
  readonly maxUploadBytes: number;
}

export interface LocalObjectStoreOptions {
  /** Directory holding the objects (`<dir>/tenants/...`). */
  readonly directory: string;
  /** Origin the browser uses for the API (the Vite dev server proxies /api), e.g. http://localhost:5173. */
  readonly publicOrigin: string;
  readonly maxUploadBytes: number;
  readonly secret?: Uint8Array;
  readonly now?: () => Date;
}

/**
 * Filesystem ObjectStore for the local dev server, with S3-like presigned PUTs: the URL carries an
 * HMAC-signed token binding key, content type, exact length and expiry, and
 * `PUT /api/v1/_local/uploads/:token` (mounted only when APP_ENV=development) checks all four.
 */
export class LocalObjectStore implements ObjectStore, LocalUploadTarget {
  readonly #root: string;
  readonly #origin: string;
  readonly #secret: Uint8Array;
  readonly #now: () => Date;
  readonly maxUploadBytes: number;

  constructor(options: LocalObjectStoreOptions) {
    this.#root = resolve(options.directory);
    this.#origin = options.publicOrigin.replace(/\/+$/, '');
    this.#secret = options.secret ?? randomBytes(32);
    this.#now = options.now ?? (() => new Date());
    this.maxUploadBytes = options.maxUploadBytes;
  }

  #path(key: string): string {
    if (!key.startsWith(DOCUMENT_KEY_PREFIX) || key.includes('\0')) throw new TypeError('invalid object key');
    const path = resolve(this.#root, key);
    if (!path.startsWith(this.#root + sep)) throw new TypeError('object key escapes the storage directory');
    return path;
  }

  #sign(payload: string): Buffer {
    return createHmac('sha256', this.#secret).update(payload).digest();
  }

  async presignPut(input: PresignPutInput): Promise<PresignedUpload> {
    await Promise.resolve();
    this.#path(input.key);
    const expiresIn = Math.min(input.expiresInSeconds, UPLOAD_URL_TTL_SECONDS);
    const expiresAt = new Date(this.#now().getTime() + expiresIn * 1000);
    const claims: UploadClaims = {
      k: input.key,
      t: input.contentType,
      l: input.contentLength,
      e: expiresAt.getTime(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${this.#sign(payload).toString('base64url')}`;
    return {
      url: `${this.#origin}${API_PREFIX}/_local/uploads/${token}`,
      headers: { 'content-type': input.contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  async receive(token: string, contentType: string | undefined, body: Uint8Array): Promise<void> {
    const [payload, signature] = token.split('.');
    if (payload === undefined || signature === undefined)
      throw new LocalUploadRejectedError(403, 'malformed upload token');
    const expected = this.#sign(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new LocalUploadRejectedError(403, 'invalid upload signature');
    }
    let claims: UploadClaims;
    try {
      claims = UploadClaims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new LocalUploadRejectedError(403, 'invalid upload token');
    }
    if (claims.e < this.#now().getTime()) throw new LocalUploadRejectedError(403, 'upload URL expired');
    if (contentType?.split(';')[0]?.trim().toLowerCase() !== claims.t) {
      throw new LocalUploadRejectedError(403, 'content-type does not match the signed upload');
    }
    if (body.byteLength !== claims.l) {
      throw new LocalUploadRejectedError(403, 'content-length does not match the signed upload');
    }
    const path = this.#path(claims.k);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async getObject(key: string, options: { readonly maxBytes: number }): Promise<Uint8Array> {
    const path = this.#path(key);
    try {
      const info = await stat(path);
      if (info.size > options.maxBytes) throw new ObjectTooLargeError('object too large');
      return new Uint8Array(await readFile(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError('object not found');
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}
