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
 * Distils one conversation into its digest, the vEIR notebook, memory and lesson drafts. Sent after each
 * completed turn (delayed), when a conversation or a call in it ends, and when the person's next conversation
 * starts; the worker skips it cheaply when there is nothing new or the conversation is still active.
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
  /**
   * The conversation is settled: it ended, a call in it ended, or its person moved on to a new conversation.
   * It is distilled now even though its last turn is recent (never skipped as active).
   */
  settled: z.boolean().optional(),
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

/**
 * Audio a synthesizer returns: MP3 for the call's own speakers, or raw 16-bit mono PCM (little-endian) for a
 * vendor face, which renders PCM at 24 kHz (`pcm_16000` is resampled by core; Amazon Polly's PCM stops at 16 kHz).
 */
export type SpeechFormat = 'mp3' | 'pcm_16000' | 'pcm_24000';

export interface SpeechSynthesisInput {
  /** Validated text to speak. Content: never log it. */
  readonly text: string;
  readonly voiceId: string;
  /** Engines to try in order (the first one the voice supports in this Region wins). */
  readonly engines: readonly SpeechEngine[];
  readonly requestId: string;
  readonly signal?: AbortSignal;
  /** `mp3` unless a face renders the call's audio (`pcm_16000`). */
  readonly format?: 'mp3' | 'pcm_16000';
}

export interface SynthesizedSpeech {
  /** The audio, streamed as the service produces it. */
  readonly audio: ReadableStream<Uint8Array>;
  /** `audio/mpeg`, `audio/wav` (PCM in a WAV container, for a face) or `audio/pcm` (raw, from a synthesizer). */
  readonly contentType: 'audio/mpeg' | 'audio/wav' | 'audio/pcm';
  /** Characters billed (the input length). */
  readonly characters: number;
  /** The Polly engine, or `clone` for the EIR's cloned voice at a vendor. */
  readonly engine: SpeechEngine | 'clone';
  readonly voiceId: string;
  /** Raw PCM's sample rate (`audio/pcm` only). */
  readonly sampleRateHertz?: number;
  /**
   * The face-audio manifest of this unit (`POST /speech` for a call with a live face; see
   * orchestrator/face-audio.ts): the browser hands the audio back with it when the face should render it.
   */
  readonly faceManifest?: string;
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

/**
 * A unit of the vEIR's speech whose server signature verified (`verifySpeechUnit` over
 * `sessionId|turnId|seq|text`): the identity guard, the meta-narration gate and the sentence gate passed it. Only
 * {@link verifiedSpeechUnit} makes one, after checking the signature itself, so the cloned voice and the face can
 * only ever be handed words the validators approved (docs/architecture/calls.md §4).
 */
export interface VerifiedSpeechUnit {
  readonly [verifiedUnitBrand]: true;
  readonly sessionId: string;
  /** Null for the call intro. */
  readonly turnId: string | null;
  readonly seq: number;
  /** The validated words. Content: never log them. */
  readonly text: string;
  readonly sig: string;
}
declare const verifiedUnitBrand: unique symbol;

/**
 * A synthesized voice for calls other than Amazon Polly: the EIR's cloned voice at a vendor (ElevenLabs, or the
 * development stand-in `fake`). It synthesizes only {@link VerifiedSpeechUnit}s, on the server, with the vendor key
 * the API holds: no voice credential ever reaches the browser.
 */
export interface VoiceProvider {
  readonly id: 'elevenlabs' | 'fake';
  /** The vendor model, metered as `<id>:<model>`. */
  readonly model: string;
  /** Price per 1,000 characters (packages/core/media-vendors.json). */
  readonly usdPer1kCharacters: number;
  synthesize(input: VoiceSynthesisInput): Promise<SynthesizedSpeech>;
}

export interface VoiceSynthesisInput {
  readonly unit: VerifiedSpeechUnit;
  /** The persona's voice at the vendor (`persona_media.vendor_ref`). */
  readonly voiceRef: string;
  /** `mp3` for the call's speakers, `pcm_24000` for a face. */
  readonly format: 'mp3' | 'pcm_24000';
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

/** Thrown when a vendor face session cannot be started or driven (vendor down, key missing, quota). */
export class EmbodimentSessionError extends Error {
  override readonly name = 'EmbodimentSessionError';
}

export interface FaceSessionRequest {
  /** The caller's live call: the vendor session belongs to it and ends with it. */
  readonly callId: string;
  readonly personaId: string;
  /** The persona's avatar at the vendor (`persona_media.vendor_ref`); null for the stand-in. */
  readonly avatarRef: string | null;
  /** Seconds the face may last: the vendor session ends by itself then (`max_session_duration`). */
  readonly maxSeconds: number;
  readonly requestId: string;
}

export interface StartedFaceSession {
  /**
   * What the browser joins the face's video with: a short-lived room token that can only watch (a LiveKit client
   * token) and the room URL. A credential: never logged or stored.
   */
  readonly browser: { readonly token: string; readonly url: string | null; readonly expiresAt: string };
  /** The vendor's session id (not a secret). */
  readonly sessionRef: string;
  /**
   * The server-held control channel (LITE's `ws_url`), which can make the face speak: never sent to the
   * browser, stored only encrypted, erased when the face ends. Null when the vendor has none (the stand-in).
   */
  readonly control: string | null;
}

/** A live face session, as the API drives it. */
export interface FaceSessionHandle {
  readonly sessionRef: string;
  readonly control: string | null;
  readonly requestId: string;
}

/**
 * Audio the face may render: PCM (16-bit mono little-endian, 24 kHz) our server synthesized from a
 * {@link VerifiedSpeechUnit} of this call, checked against the server's face-audio manifest. Only the face relay
 * makes one.
 */
export interface VerifiedFaceAudio {
  readonly [verifiedFaceAudioBrand]: true;
  readonly pcm: Uint8Array;
  /** The unit it belongs to (`call_speech` key): the vendor groups its chunks into one utterance. */
  readonly utterance: string;
  /** The first and last parts of the unit (a long unit arrives in several parts). */
  readonly first: boolean;
  readonly last: boolean;
}
declare const verifiedFaceAudioBrand: unique symbol;

/**
 * The face of calls (docs/architecture/calls.md §4): a vendor's realtime avatar that renders audio our server
 * synthesized from validated units (HeyGen LiveAvatar LITE), driven entirely from the API with the vendor key it
 * holds (Secrets Manager). The browser only watches. Absent: every call keeps the built-in presence. The local
 * API can run the development stand-in (`fake`, no one's likeness).
 */
export interface EmbodimentProvider {
  /** The provider id the call screen loads (`EmbodimentProviderId`). */
  readonly id: 'fake' | 'heygen';
  /** The face renders the call's own audio (`AvatarVoicing` `audio`). */
  readonly voicing: 'audio';
  /**
   * Whether the face is a real person's likeness (a vendor avatar of the EIR): then it serves only personas whose
   * face is ready under likeness consent. The stand-in draws no one and serves any.
   */
  readonly likeness: boolean;
  /** Per minute of face session (packages/core/media-vendors.json); the vendor bills elapsed time. */
  readonly usdPerMinute: number;
  createSession(request: FaceSessionRequest): Promise<StartedFaceSession>;
  /** Makes the face render one part of a unit's audio (and close the utterance on its last part). */
  speak(session: FaceSessionHandle, audio: VerifiedFaceAudio): Promise<void>;
  /** Barge-in: discards what the face still has to say. */
  interrupt(session: FaceSessionHandle): Promise<void>;
  /** Keeps an idle session from timing out at the vendor. */
  keepAlive(session: FaceSessionHandle): Promise<void>;
  /** Ends the vendor session (so it stops billing). Never throws for a session already gone. */
  end(session: FaceSessionHandle, reason: 'call_ended' | 'face_stopped' | 'face_dropped'): Promise<void>;
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
