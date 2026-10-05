import { type DocumentContentType } from '@foundry/contracts';
import { type z } from 'zod';

import {
  ExtractionFailedError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  type Clock,
  type CoreLogFields,
  type CoreLogger,
  type ExtractedText,
  type JobMessage,
  type JobQueue,
  type ObjectStore,
  type PresignPutInput,
  type PresignedUpload,
  type TextExtractor,
} from '../ports.js';

/** In-memory ObjectStore: presigned URLs are fake; tests `put` the bytes a browser would upload. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly presigned: PresignPutInput[] = [];
  readonly deleted: string[] = [];
  /** When set, getObject throws this error once (transient-failure tests). */
  failNextGet: Error | null = null;

  presignPut(input: PresignPutInput): Promise<PresignedUpload> {
    this.presigned.push(input);
    return Promise.resolve({
      url: `https://uploads.test/${encodeURI(input.key)}?signature=fake`,
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  put(key: string, data: Uint8Array | string): void {
    this.objects.set(key, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  getObject(key: string, options: { readonly maxBytes: number }): Promise<Uint8Array> {
    if (this.failNextGet) {
      const err = this.failNextGet;
      this.failNextGet = null;
      return Promise.reject(err);
    }
    const data = this.objects.get(key);
    if (!data) return Promise.reject(new ObjectNotFoundError('object not found'));
    if (data.byteLength > options.maxBytes)
      return Promise.reject(new ObjectTooLargeError('object too large'));
    return Promise.resolve(data);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }
}

/** In-memory JobQueue (jobs are drained by the test). */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: { job: JobMessage; deduplicationId: string | null }[] = [];
  failNext = false;

  enqueue(job: JobMessage, options?: { readonly deduplicationId?: string }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    this.jobs.push({ job, deduplicationId: options?.deduplicationId ?? null });
    return Promise.resolve();
  }

  drain(): JobMessage[] {
    return this.jobs.splice(0).map((j) => j.job);
  }
}

/**
 * Test extractor: UTF-8 text for text/markdown; PDF/DOCX bytes are treated as UTF-8 text too unless they
 * start with "%CORRUPT" (simulated unreadable file).
 */
export class Utf8TextExtractor implements TextExtractor {
  extract(data: Uint8Array, _contentType: z.infer<typeof DocumentContentType>): Promise<ExtractedText> {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    if (text.startsWith('%CORRUPT')) return Promise.reject(new ExtractionFailedError('unreadable document'));
    return Promise.resolve({ text });
  }
}

/** Manually advanced clock. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start: Date | string = new Date()) {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(date: Date | string): void {
    this.#now = new Date(date).getTime();
  }
}

export interface LogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: CoreLogFields;
}

/** Captures log lines so tests can assert that no content is ever logged. */
export class RecordingLogger implements CoreLogger {
  readonly records: LogRecord[] = [];

  info(event: string, fields: CoreLogFields): void {
    this.records.push({ level: 'info', event, fields });
  }

  warn(event: string, fields: CoreLogFields): void {
    this.records.push({ level: 'warn', event, fields });
  }

  error(event: string, fields: CoreLogFields): void {
    this.records.push({ level: 'error', event, fields });
  }

  /** Every logged value as one string (for "never contains X" assertions). */
  dump(): string {
    return JSON.stringify(this.records);
  }
}
