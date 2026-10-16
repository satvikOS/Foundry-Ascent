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

export interface PresignGetInput {
  /** Object key of a venture document (built by core from the document record, never from input). */
  readonly key: string;
  /** `inline` shows the file in the app; `attachment` saves it under `filename`. */
  readonly disposition: 'inline' | 'attachment';
  /** The name the file is saved under (the original upload name). */
  readonly filename: string;
  /** Served as this type (the stored type), whatever the object's own metadata says. */
  readonly contentType: z.infer<typeof DocumentContentType>;
  readonly expiresInSeconds: number;
}

export interface PresignedDownload {
  readonly url: string;
  /** ISO-8601 expiry. */
  readonly expiresAt: string;
}

/** Venture document storage (S3 documents bucket). */
export interface ObjectStore {
  presignPut(input: PresignPutInput): Promise<PresignedUpload>;
  /**
   * A short-lived GET of one stored file (the document viewer and downloads). Like a presigned PUT, the URL
   * is the authorization: core issues it only after checking the caller may read the document.
   */
  presignGet(input: PresignGetInput): Promise<PresignedDownload>;
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

/** Ingests a document uploaded to a persona's knowledge library (scope `persona`, no venture). */
export const IngestKnowledgeSourceJob = z.object({
  type: z.literal('ingest_knowledge_source'),
  sourceId: z.uuid(),
  tenantId: z.uuid(),
  personaId: z.uuid(),
  /** Request that enqueued the job (correlation only). */
  requestId: z.string().max(128).nullable(),
});
export type IngestKnowledgeSourceJob = z.infer<typeof IngestKnowledgeSourceJob>;

/** The jobs the ingestion processor handles. */
export const IngestionJob = z.discriminatedUnion('type', [IngestDocumentJob, IngestKnowledgeSourceJob]);
export type IngestionJob = z.infer<typeof IngestionJob>;

/**
 * Distils one conversation into its digest, the vEIR notebook, memory proposals and lesson drafts. Sent after
 * each completed turn (delayed), when a conversation ends and when the person's next one starts; the worker
 * skips it cheaply when there is nothing new or the conversation is still active.
 */
export const DistillSessionJob = z.object({
  type: z.literal('distill_session'),
  sessionId: z.uuid(),
  tenantId: z.uuid(),
  ventureId: z.uuid(),
  /**
   * Completed turns when the job was queued: a conversation that has more by the time the job runs was queued
   * again by its later turn, so this job is superseded and ends without a model call.
   */
  turns: z.number().int().min(0).optional(),
  /** Request that enqueued the job (correlation only). */
  requestId: z.string().max(128).nullable(),
});
export type DistillSessionJob = z.infer<typeof DistillSessionJob>;

export const JobMessage = z.discriminatedUnion('type', [
  IngestDocumentJob,
  IngestKnowledgeSourceJob,
  DistillSessionJob,
]);
export type JobMessage = z.infer<typeof JobMessage>;

/** Voice engines of the text-to-speech service, most natural first (Amazon Polly). */
export type SpeechEngine = 'generative' | 'neural' | 'standard';

export interface SpeechSynthesisInput {
  /** Validated text to speak. Content: never log it. */
  readonly text: string;
  readonly voiceId: string;
  /** Engines to try in order (the first one the voice supports in this Region wins). */
  readonly engines: readonly SpeechEngine[];
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface SynthesizedSpeech {
  /** MP3 audio, streamed as the service produces it. */
  readonly audio: ReadableStream<Uint8Array>;
  readonly contentType: 'audio/mpeg';
  /** Characters billed (the input length). */
  readonly characters: number;
  readonly engine: SpeechEngine;
  readonly voiceId: string;
}

/** Thrown when the speech service cannot synthesize (outage, throttling, unsupported voice). */
export class SpeechSynthesisError extends Error {
  override readonly name = 'SpeechSynthesisError';
}

/**
 * Text-to-speech for calls (Amazon Polly in the API). Absent locally and in tests unless injected: the
 * speech endpoint then answers `speech_unavailable` and the browser speaks the validated text itself.
 */
export interface SpeechSynthesizer {
  synthesize(input: SpeechSynthesisInput): Promise<SynthesizedSpeech>;
}

export interface EnqueueOptions {
  /** Lets FIFO/idempotent consumers drop duplicates. */
  readonly deduplicationId?: string;
  /** Delivers the job after this many seconds (0–{@link MAX_JOB_DELAY_SECONDS}; SQS `DelaySeconds`). */
  readonly delaySeconds?: number;
}

/** The longest delay a queued job can have (the SQS limit). */
export const MAX_JOB_DELAY_SECONDS = 900;

export interface SttGrantRequest {
  /** BCP-47 language of the founder's speech (`en-US`). */
  readonly languageCode: string;
  /** PCM sample rate the browser streams (16 000 Hz). */
  readonly sampleRateHertz: number;
  /** Lifetime of the grant: it only bounds opening the stream (at most 300 s). */
  readonly expiresInSeconds: number;
  readonly requestId: string;
}

export interface IssuedSttGrant {
  /** Presigned `wss://` URL the browser opens directly (audio never passes through our API). */
  readonly url: string;
  /** ISO-8601 expiry of the URL. */
  readonly expiresAt: string;
}

/** Thrown when a speech-to-text grant cannot be minted (no credentials, signing failure). */
export class SttGrantError extends Error {
  override readonly name = 'SttGrantError';
}

/**
 * Speech-to-text grants for calls: Amazon Transcribe streaming URLs presigned (SigV4) with the API's own role
 * credentials. Absent locally and in tests unless injected: calls then start without a grant and the founder
 * types instead.
 */
export interface SttGrantIssuer {
  issue(request: SttGrantRequest): Promise<IssuedSttGrant>;
}

export interface JobQueue {
  /** Enqueues a job, optionally delayed. */
  enqueue(job: JobMessage, options?: EnqueueOptions): Promise<void>;
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
