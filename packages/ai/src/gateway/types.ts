import type { z } from 'zod';

/**
 * Why a model call is made. Mirrors the `usage_ledger.purpose` CHECK constraint in
 * packages/db/migrations/0001_init.sql so every call can be written to the ledger as-is.
 */
export const MODEL_PURPOSES = [
  'turn',
  'recap',
  'classification',
  'embedding',
  'ingestion',
  'eval',
  'seed',
] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/** Which concrete backend served (or failed) an attempt. */
export type ModelProviderName = 'luna' | 'nova' | 'titan' | 'mock';

/** A conversational message. The system prompt is passed separately. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The classified outcome of one network call to a model. Outcomes are coarse on purpose: they are
 * logged and persisted, and must never carry model output or provider error messages (which can echo
 * prompt content).
 */
export type AttemptOutcome =
  | 'ok'
  | 'invalid_output'
  | 'refusal'
  | 'timeout'
  | 'throttled'
  | 'server_error'
  | 'client_error'
  | 'network'
  | 'aborted';

/** `initial` = first call; `repair` = re-ask after invalid output; `profile_retry` = Nova inference-profile retry. */
export type AttemptKind = 'initial' | 'repair' | 'profile_retry';

/** One network call to a model as reported by a provider (before pricing is applied). */
export interface RawModelAttempt {
  provider: ModelProviderName;
  modelId: string;
  kind: AttemptKind;
  outcome: AttemptOutcome;
  latencyMs: number;
  usage: ModelUsage;
  /** Provider error class name (e.g. `ThrottlingException`), never the error message. */
  errorName: string | null;
}

/** One priced network call. Each attempt is billable and should become one `usage_ledger` row. */
export interface ModelAttempt extends RawModelAttempt {
  costUsd: number;
}

export interface GenerateStructuredRequest<T> {
  purpose: ModelPurpose;
  /** Trusted instructions (see `buildSystemPrompt`). */
  system: string;
  /** Conversation, oldest first; the last message must be from the user. */
  messages: readonly ChatMessage[];
  /** JSON-schema name sent to the model: `^[A-Za-z0-9_-]{1,64}$`. */
  schemaName: string;
  /** Output contract. Must be representable as a strict JSON schema (no records, no tuples). */
  zodSchema: z.ZodType<T>;
  /** Upper bound on generated tokens per attempt. Default 4096. */
  maxOutputTokens?: number;
  /** Budget for the primary model including its repair retry. Default 25 000 ms. */
  timeoutMs?: number;
  /** Correlates log lines and ledger rows. */
  requestId: string;
  /** Caller cancellation (e.g. client disconnected). Cancellation never triggers the fallback. */
  signal?: AbortSignal;
}

export interface GenerateStructuredResult<T> {
  /** Schema-valid value (already parsed by `zodSchema`). */
  value: T;
  /** Model id that produced `value` (may be an inference-profile id such as `us.amazon.nova-2-lite-v1:0`). */
  modelId: string;
  fallbackUsed: boolean;
  /** Total tokens across **all** attempts (failed primary attempts are billed too). */
  usage: ModelUsage;
  /** Total cost across all attempts. Use this, not `costFor(modelId, usage)`, for turn cost. */
  costUsd: number;
  /** Wall-clock latency of the whole call, including retries and fallback. */
  latencyMs: number;
  /** Every network call made, in order. Write one `usage_ledger` row per attempt. */
  attempts: ModelAttempt[];
}

export interface EmbedOptions {
  purpose: ModelPurpose;
  requestId?: string;
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** One unit-length vector per input text, in input order. */
  vectors: number[][];
  modelId: string;
  usage: ModelUsage;
  costUsd: number;
  latencyMs: number;
}

export interface ModelGatewayInfo {
  provider: 'bedrock' | 'mock';
  primaryModelId: string;
  fallbackModelId: string;
  embeddingsModelId: string;
  embeddingDimensions: number;
}

/** Provider-neutral model access used by packages/core. */
export interface ModelGateway {
  readonly info: ModelGatewayInfo;
  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>>;
  embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult>;
}

/** Structured-log sink. Fields are identifiers, counts and timings only, never content. */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export interface ModelLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export const noopLogger: ModelLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/** Embedding dimensionality used across the platform (`vector(1024)` columns). */
export const EMBEDDING_DIMENSIONS = 1024;
