import { randomUUID } from 'node:crypto';

import { type DocumentContentType } from '@foundry/contracts';
import { z } from 'zod';

/**
 * Infrastructure ports implemented by apps/api (S3, SQS, text extraction) and by in-memory fakes in
 * tests. Core never imports AWS SDKs.
 */

export interface PresignPutInput {
  /** Object key, always `tenants/{t}/ventures/{v}/documents/{id}/{filename}` (built by core). */
  readonly key: string;
  readonly contentType: z.infer<typeof DocumentContentType>;
  /** Exact byte length the client declared (sign it as Content-Length so larger bodies are rejected). */
  readonly contentLength: number;
  readonly expiresInSeconds: number;
}

export interface PresignedUpload {
  readonly url: string;
  /** Headers the browser must send with the PUT (e.g. content-type). */
  readonly headers: Readonly<Record<string, string>>;
  /** ISO-8601 expiry. */
  readonly expiresAt: string;
}

/** Venture document storage (S3 documents bucket). */
export interface ObjectStore {
  presignPut(input: PresignPutInput): Promise<PresignedUpload>;
  /**
   * Reads an uploaded object (ingestion worker). Must reject objects larger than `maxBytes` and throw
   * {@link ObjectNotFoundError} when the key does not exist.
   */
  getObject(key: string, options: { readonly maxBytes: number }): Promise<Uint8Array>;
  /** Deletes an object; deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** Thrown by ObjectStore.getObject when the object does not exist (the upload never completed). */
export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
}

/** Thrown by ObjectStore.getObject when the object exceeds `maxBytes`. */
export class ObjectTooLargeError extends Error {
  override readonly name = 'ObjectTooLargeError';
}

/** Background jobs (SQS jobs queue → worker Lambda). */
export const IngestDocumentJob = z.object({
  type: z.literal('ingest_document'),
  documentId: z.uuid(),
  tenantId: z.uuid(),
  ventureId: z.uuid(),
  /** Request that enqueued the job (correlation only). */
  requestId: z.string().max(128).nullable(),
});
export type IngestDocumentJob = z.infer<typeof IngestDocumentJob>;

export const JobMessage = z.discriminatedUnion('type', [IngestDocumentJob]);
export type JobMessage = z.infer<typeof JobMessage>;

export interface JobQueue {
  /** Enqueues a job. `deduplicationId` lets FIFO/idempotent consumers drop duplicates. */
  enqueue(job: JobMessage, options?: { readonly deduplicationId?: string }): Promise<void>;
}

export interface ExtractedText {
  /**
   * Plain text or Markdown. Headings should be rendered as Markdown `#` lines when the format has them
   * (DOCX via mammoth's Markdown output); the chunker is heading-aware.
   */
  readonly text: string;
}

/** Thrown by TextExtractor implementations for corrupt or unreadable files (not retried). */
export class ExtractionFailedError extends Error {
  override readonly name = 'ExtractionFailedError';
}

/** Text extraction for uploaded documents (unpdf for PDF, mammoth for DOCX, UTF-8 for text/markdown). */
export interface TextExtractor {
  extract(data: Uint8Array, contentType: z.infer<typeof DocumentContentType>): Promise<ExtractedText>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

/** Structured log fields: identifiers, counts, timings and codes only — never content. */
export type CoreLogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface CoreLogger {
  info(event: string, fields: CoreLogFields): void;
  warn(event: string, fields: CoreLogFields): void;
  error(event: string, fields: CoreLogFields): void;
}

export const systemClock: Clock = { now: () => new Date() };
export const randomIds: IdGenerator = { uuid: () => randomUUID() };
export const noopCoreLogger: CoreLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
