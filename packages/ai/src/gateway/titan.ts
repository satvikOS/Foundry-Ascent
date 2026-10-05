import { createBedrockRuntimeTransport, mapAwsError, type InvokeModelFn } from './bedrock-runtime.js';
import { Deadline } from './deadline.js';
import { ModelOutputInvalidError, isModelGatewayError } from './errors.js';
import type { AwsCredentialProvider, AwsCredentials } from './sigv4-fetch.js';
import { EMBEDDING_DIMENSIONS, type ModelUsage, type RawModelAttempt } from './types.js';

export interface TitanEmbedderOptions {
  /** e.g. `amazon.titan-embed-text-v2:0`. */
  modelId: string;
  region: string;
  credentials?: AwsCredentials | AwsCredentialProvider;
  invokeModel?: InvokeModelFn;
  /** Parallel InvokeModel calls. Default 4. */
  concurrency?: number;
  /** 256, 512 or 1024. Default 1024 (the `vector(1024)` columns). */
  dimensions?: number;
  /** Per-call timeout. Default 15 000 ms. */
  timeoutMs?: number;
}

export interface EmbedBatchResult {
  vectors: number[][];
  modelId: string;
  usage: ModelUsage;
  rawAttempts: RawModelAttempt[];
}

/** Titan Text Embeddings V2 accepts up to 50 000 characters per input. */
export const TITAN_MAX_INPUT_CHARS = 50_000;

interface TitanResponse {
  embedding?: unknown;
  inputTextTokenCount?: unknown;
}

/**
 * Embeddings with Amazon Titan Text Embeddings V2 (`InvokeModel`, one text per call, normalized).
 * Inputs are processed with bounded concurrency and results keep input order.
 */
export class TitanEmbedder {
  readonly modelId: string;
  readonly dimensions: number;
  readonly #invoke: InvokeModelFn;
  readonly #concurrency: number;
  readonly #timeoutMs: number;

  constructor(options: TitanEmbedderOptions) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.#invoke =
      options.invokeModel ??
      createBedrockRuntimeTransport({
        region: options.region,
        ...(options.credentials ? { credentials: options.credentials } : {}),
        maxAttempts: 3,
      }).invokeModel;
    this.#concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbedBatchResult> {
    for (const text of texts) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new TypeError('embed: every input must be a non-empty string');
      }
    }
    const vectors: number[][] = new Array<number[]>(texts.length);
    const rawAttempts: RawModelAttempt[] = [];
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    const state: { next: number; failure: { error: unknown } | null } = { next: 0, failure: null };

    const worker = async (): Promise<void> => {
      while (state.failure === null) {
        const index = state.next;
        state.next += 1;
        if (index >= texts.length) return;
        try {
          const result = await this.#embedOne(texts[index] ?? '', signal);
          vectors[index] = result.vector;
          usage.inputTokens += result.attempt.usage.inputTokens;
          rawAttempts.push(result.attempt);
        } catch (error) {
          if (isModelGatewayError(error)) rawAttempts.push(...error.rawAttempts);
          state.failure ??= { error };
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.#concurrency, texts.length) }, () => worker()));
    if (state.failure !== null) {
      const { error } = state.failure;
      if (isModelGatewayError(error)) error.rawAttempts = rawAttempts;
      throw error;
    }
    return { vectors, modelId: this.modelId, usage, rawAttempts };
  }

  async #embedOne(
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<{ vector: number[]; attempt: RawModelAttempt }> {
    const deadline = new Deadline(this.#timeoutMs, signal);
    const started = performance.now();
    const body = JSON.stringify({
      inputText: text.length > TITAN_MAX_INPUT_CHARS ? text.slice(0, TITAN_MAX_INPUT_CHARS) : text,
      dimensions: this.dimensions,
      normalize: true,
    });
    const base = { provider: 'titan' as const, modelId: this.modelId, kind: 'initial' as const };
    try {
      let raw: string;
      try {
        raw = await this.#invoke({ modelId: this.modelId, body }, deadline.signal);
      } catch (error) {
        const mapped = mapAwsError(error, deadline, this.modelId);
        mapped.rawAttempts = [
          {
            ...base,
            outcome: mapped.reason === 'config' ? 'client_error' : mapped.reason,
            latencyMs: Math.round(performance.now() - started),
            usage: { inputTokens: 0, outputTokens: 0 },
            errorName: mapped.errorName,
          },
        ];
        throw mapped;
      }
      const latencyMs = Math.round(performance.now() - started);
      let parsed: TitanResponse;
      try {
        parsed = JSON.parse(raw) as TitanResponse;
      } catch {
        parsed = {};
      }
      const tokens = typeof parsed.inputTextTokenCount === 'number' ? parsed.inputTextTokenCount : 0;
      const attemptUsage = { inputTokens: tokens, outputTokens: 0 };
      const embedding = parsed.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length !== this.dimensions ||
        !embedding.every((v): v is number => typeof v === 'number' && Number.isFinite(v))
      ) {
        const error = new ModelOutputInvalidError(this.modelId, ['embedding: invalid_vector']);
        error.rawAttempts = [
          { ...base, outcome: 'invalid_output', latencyMs, usage: attemptUsage, errorName: null },
        ];
        throw error;
      }
      return {
        vector: embedding,
        attempt: { ...base, outcome: 'ok', latencyMs, usage: attemptUsage, errorName: null },
      };
    } finally {
      deadline.dispose();
    }
  }
}
