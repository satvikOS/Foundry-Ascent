import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { API_PREFIX, RECORDING_CAPTIONS_TYPE, RECORDING_LIMITS, RecordingMimeType } from '@foundry/contracts';
import {
  type PresignedDownload,
  type PresignedUpload,
  type RecordingGetInput,
  type RecordingPutInput,
  type RecordingStore,
} from '@foundry/core';
import { z } from 'zod';

import { UPLOAD_URL_TTL_SECONDS } from '../config.js';
import { LocalUploadRejectedError } from './local-object-store.js';
import { isRecordingKey, MAX_PLAYBACK_URL_SECONDS } from './s3-recording-store.js';

/** Route (relative to /api/v1) of local "presigned" recording uploads and downloads. Development only. */
export const LOCAL_RECORDING_ROUTE = '/_local/recordings/:token';

const ContentType = z.union([RecordingMimeType, z.literal(RECORDING_CAPTIONS_TYPE)]);

const Claims = z.discriminatedUnion('o', [
  z.object({
    o: z.literal('put'),
    k: z.string().min(1).max(512),
    t: ContentType,
    l: z.number().int().min(1),
    e: z.number().int(),
  }),
  z.object({ o: z.literal('get'), k: z.string().min(1).max(512), t: ContentType, e: z.number().int() }),
]);
type Claims = z.infer<typeof Claims>;

/** A part of a stored recording, as the local route sends it (the whole file, or one byte range of it). */
export interface LocalRecordingRead {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly size: number;
  /** The range sent (inclusive), or null for the whole file. */
  readonly range: { readonly start: number; readonly end: number } | null;
}

/** What the local recording routes call (implemented by {@link LocalRecordingStore}). */
export interface LocalRecordingTarget {
  receive(token: string, contentType: string | undefined, body: Uint8Array): Promise<void>;
  /** The file a GET token names; `range` is the request's Range header (one `bytes=` range at most). */
  read(token: string, range: string | undefined): Promise<LocalRecordingRead>;
  /** Largest body the upload route reads. */
  readonly maxUploadBytes: number;
}

export interface LocalRecordingStoreOptions {
  /** Directory holding the recordings (`<dir>/tenants/...`). */
  readonly directory: string;
  /**
   * Origin of the presigned URLs: the API server itself in the end-to-end suite (cross-origin under the CSP, as the
   * recordings bucket is in production), or the web dev server that proxies /api.
   */
  readonly origin: string;
  readonly secret?: Uint8Array;
  readonly now?: () => Date;
}

/** Largest range one local GET answers with (players ask for the rest as they go). */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

/**
 * Filesystem RecordingStore for the local dev server and the end-to-end suite, with S3-like presigned URLs: a token
 * signed with HMAC binds the key, the content type, the exact length (uploads) and the expiry, and
 * `PUT|GET /api/v1/_local/recordings/:token` (mounted only when APP_ENV=development) checks them. GETs answer byte
 * ranges, so the player can seek as it does in the recordings bucket.
 */
export class LocalRecordingStore implements RecordingStore, LocalRecordingTarget {
  readonly #root: string;
  readonly #origin: string;
  readonly #secret: Uint8Array;
  readonly #now: () => Date;
  readonly maxUploadBytes = RECORDING_LIMITS.maxBytes;

  constructor(options: LocalRecordingStoreOptions) {
    this.#root = resolve(options.directory);
    this.#origin = options.origin.replace(/\/+$/, '');
    this.#secret = options.secret ?? randomBytes(32);
    this.#now = options.now ?? (() => new Date());
  }

  #path(key: string): string {
    if (!isRecordingKey(key) || key.includes('\0')) throw new TypeError('invalid recording key');
    const path = resolve(this.#root, key);
    if (!path.startsWith(this.#root + sep))
      throw new TypeError('recording key escapes the storage directory');
    return path;
  }

  #token(claims: Claims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', this.#secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  #claims(token: string): Claims {
    const [payload, signature] = token.split('.');
    if (payload === undefined || signature === undefined)
      throw new LocalUploadRejectedError(403, 'malformed token');
    const expected = createHmac('sha256', this.#secret).update(payload).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new LocalUploadRejectedError(403, 'invalid signature');
    }
    let claims: Claims;
    try {
      claims = Claims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new LocalUploadRejectedError(403, 'invalid token');
    }
    if (claims.e < this.#now().getTime()) throw new LocalUploadRejectedError(403, 'URL expired');
    return claims;
  }

  #url(token: string): string {
    return `${this.#origin}${API_PREFIX}/_local/recordings/${token}`;
  }

  async presignPut(input: RecordingPutInput): Promise<PresignedUpload> {
    await Promise.resolve();
    this.#path(input.key);
    const expiresIn = Math.min(input.expiresInSeconds, UPLOAD_URL_TTL_SECONDS);
    const expiresAt = new Date(this.#now().getTime() + expiresIn * 1000);
    const token = this.#token({
      o: 'put',
      k: input.key,
      t: input.contentType,
      l: input.contentLength,
      e: expiresAt.getTime(),
    });
    return {
      url: this.#url(token),
      headers: { 'content-type': input.contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  async presignGet(input: RecordingGetInput): Promise<PresignedDownload> {
    await Promise.resolve();
    this.#path(input.key);
    const expiresIn = Math.min(input.expiresInSeconds, MAX_PLAYBACK_URL_SECONDS);
    const expiresAt = new Date(this.#now().getTime() + expiresIn * 1000);
    const token = this.#token({ o: 'get', k: input.key, t: input.contentType, e: expiresAt.getTime() });
    return { url: this.#url(token), expiresAt: expiresAt.toISOString() };
  }

  async receive(token: string, contentType: string | undefined, body: Uint8Array): Promise<void> {
    const claims = this.#claims(token);
    if (claims.o !== 'put') throw new LocalUploadRejectedError(403, 'not an upload URL');
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

  async read(token: string, range: string | undefined): Promise<LocalRecordingRead> {
    const claims = this.#claims(token);
    if (claims.o !== 'get') throw new LocalUploadRejectedError(403, 'not a download URL');
    const path = this.#path(claims.k);
    const size = await this.size(claims.k);
    if (size === null) throw new LocalUploadRejectedError(404, 'object not found');
    const wanted = parseRange(range, size);
    const start = wanted?.start ?? 0;
    const end = wanted === null ? size - 1 : Math.min(wanted.end, start + MAX_RANGE_BYTES - 1);
    const length = Math.max(0, end - start + 1);
    const handle = await open(path, 'r');
    try {
      const body = new Uint8Array(length);
      await handle.read(body, 0, length, start);
      return {
        body,
        contentType: claims.t,
        size,
        range: wanted === null ? null : { start, end },
      };
    } finally {
      await handle.close();
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.#path(key))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}

/** One `bytes=` range of a file of `size` bytes (inclusive), or null for the whole file or an unusable header. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (match === null || size === 0) return null;
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Math.min(Number(to), size);
    return suffix === 0 ? null : { start: size - suffix, end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return null;
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? null : { start, end };
}
