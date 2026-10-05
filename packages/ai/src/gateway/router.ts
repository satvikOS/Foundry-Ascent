import { z } from 'zod';

import { createPricingTable, costFor, sumUsd, type ModelPrice, type PricingTable } from '../pricing.js';
import { createBedrockRuntimeTransport, type ConverseFn, type InvokeModelFn } from './bedrock-runtime.js';
import { Deadline } from './deadline.js';
import { ModelGatewayError, ModelUnavailableError, isModelGatewayError } from './errors.js';
import { toStrictJsonSchema } from './json-schema.js';
import { LunaProvider, type LunaReasoningEffort } from './luna.js';
import { MockModelGateway, type MockModelGatewayOptions } from './mock.js';
import { NovaProvider } from './nova.js';
import type { StructuredProvider } from './provider.js';
import type { AwsCredentialProvider, AwsCredentials, FetchFn } from './sigv4-fetch.js';
import { TitanEmbedder } from './titan.js';
import {
  MODEL_PURPOSES,
  noopLogger,
  type EmbedOptions,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type ModelAttempt,
  type ModelGateway,
  type ModelGatewayInfo,
  type ModelLogger,
  type ModelUsage,
  type RawModelAttempt,
} from './types.js';

export const DEFAULT_PRIMARY_TIMEOUT_MS = 25_000;
export const DEFAULT_FALLBACK_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

export const DEFAULT_MODEL_IDS = {
  primary: 'openai.gpt-6-luna',
  fallback: 'amazon.nova-2-lite-v1:0',
  embeddings: 'amazon.titan-embed-text-v2:0',
} as const;

export interface BedrockGatewayConfig {
  provider: 'bedrock';
  region: string;
  primaryModelId: string;
  fallbackModelId: string;
  embeddingsModelId: string;
  /** Budget for the primary model (incl. its repair retry) when a request does not set one. Default 25 s. */
  primaryTimeoutMs?: number;
  /** Budget for the fallback model. Default 25 s. Primary + fallback must fit the Lambda timeout. */
  fallbackTimeoutMs?: number;
  /** Price overrides by model id (merged over `DEFAULT_MODEL_PRICES`). */
  pricing?: Readonly<Record<string, ModelPrice>>;
  logger?: ModelLogger;
  credentials?: AwsCredentials | AwsCredentialProvider;
  embeddingConcurrency?: number;
  lunaReasoningEffort?: LunaReasoningEffort;
  /** Test seams: replace the network transports. */
  transports?: { mantleFetch?: FetchFn; converse?: ConverseFn; invokeModel?: InvokeModelFn };
  /** Test seams: replace whole providers. */
  providers?: { primary?: StructuredProvider; fallback?: StructuredProvider; embedder?: TitanEmbedder };
}

export interface MockGatewayConfig extends MockModelGatewayOptions {
  provider: 'mock';
}

export type ModelGatewayConfig = BedrockGatewayConfig | MockGatewayConfig;

function priceAttempts(raw: readonly RawModelAttempt[], pricing: PricingTable): ModelAttempt[] {
  return raw.map((a) => ({ ...a, costUsd: costFor(a.modelId, a.usage, pricing) }));
}

function totalUsage(attempts: readonly ModelAttempt[]): ModelUsage {
  return attempts.reduce<ModelUsage>(
    (acc, a) => ({
      inputTokens: acc.inputTokens + a.usage.inputTokens,
      outputTokens: acc.outputTokens + a.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/** Model ids served by Bedrock Mantle (OpenAI-compatible Chat Completions, e.g. `openai.gpt-6-luna`). */
export const MANTLE_MODEL_PREFIX = 'openai.';

/**
 * Which adapter serves a reasoning model id: `openai.*` goes to Bedrock Mantle (Luna provider, SigV4
 * service `bedrock-mantle`); every other id — bare foundation models (`amazon.nova-2-lite-v1:0`) and
 * cross-region / global inference profiles (`us.…`, `global.…`) — goes to Bedrock Converse, with the id
 * passed through unchanged.
 */
export function reasoningAdapterFor(modelId: string): 'mantle' | 'converse' {
  return modelId.startsWith(MANTLE_MODEL_PREFIX) ? 'mantle' : 'converse';
}

/**
 * Whether a primary failure should go to the fallback model. Everything except caller cancellation
 * falls back: model unavailable (timeouts, throttling, 5xx, network), refusals and invalid output (per
 * the spec), and also 4xx/config errors, because those indicate a primary-side problem (model access,
 * region, schema support) the fallback does not share. They are logged as `ai.model.fallback` with the
 * reason, so a persistent primary misconfiguration is visible in metrics rather than silently absorbed.
 */
function shouldFallback(error: unknown): boolean {
  if (!isModelGatewayError(error)) return false;
  return !(error instanceof ModelUnavailableError && error.reason === 'aborted');
}

class BedrockModelGateway implements ModelGateway {
  readonly info: ModelGatewayInfo;
  readonly #primary: StructuredProvider;
  readonly #fallback: StructuredProvider;
  readonly #embedder: TitanEmbedder;
  readonly #pricing: PricingTable;
  readonly #logger: ModelLogger;
  readonly #primaryTimeoutMs: number;
  readonly #fallbackTimeoutMs: number;

  constructor(config: BedrockGatewayConfig) {
    this.#pricing = createPricingTable(config.pricing);
    this.#logger = config.logger ?? noopLogger;
    this.#primaryTimeoutMs = config.primaryTimeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
    this.#fallbackTimeoutMs = config.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
    const credentials = config.credentials ? { credentials: config.credentials } : {};

    const usesConverse =
      (!config.providers?.primary && reasoningAdapterFor(config.primaryModelId) === 'converse') ||
      (!config.providers?.fallback && reasoningAdapterFor(config.fallbackModelId) === 'converse');
    const needsRuntime =
      (usesConverse && !config.transports?.converse) ||
      (!config.providers?.embedder && !config.transports?.invokeModel);
    // One BedrockRuntimeClient shared by every Converse provider and the embedder.
    const runtime = needsRuntime
      ? createBedrockRuntimeTransport({ region: config.region, ...credentials })
      : null;
    const converse = config.transports?.converse ?? runtime?.converse;

    const reasoningProvider = (modelId: string): StructuredProvider =>
      reasoningAdapterFor(modelId) === 'mantle'
        ? new LunaProvider({
            modelId,
            region: config.region,
            ...credentials,
            ...(config.transports?.mantleFetch ? { fetch: config.transports.mantleFetch } : {}),
            ...(config.lunaReasoningEffort ? { reasoningEffort: config.lunaReasoningEffort } : {}),
          })
        : new NovaProvider({
            modelId,
            region: config.region,
            ...credentials,
            ...(converse ? { converse } : {}),
          });
    this.#primary = config.providers?.primary ?? reasoningProvider(config.primaryModelId);
    this.#fallback = config.providers?.fallback ?? reasoningProvider(config.fallbackModelId);
    const invokeModel = config.transports?.invokeModel ?? runtime?.invokeModel;
    this.#embedder =
      config.providers?.embedder ??
      new TitanEmbedder({
        modelId: config.embeddingsModelId,
        region: config.region,
        ...credentials,
        ...(invokeModel ? { invokeModel } : {}),
        ...(config.embeddingConcurrency ? { concurrency: config.embeddingConcurrency } : {}),
      });

    this.info = {
      provider: 'bedrock',
      primaryModelId: this.#primary.modelId,
      fallbackModelId: this.#fallback.modelId,
      embeddingsModelId: this.#embedder.modelId,
      embeddingDimensions: this.#embedder.dimensions,
    };
  }

  #logAttempts(attempts: readonly ModelAttempt[], requestId: string, purpose: string): void {
    for (const a of attempts) {
      const fields = {
        requestId,
        purpose,
        provider: a.provider,
        modelId: a.modelId,
        kind: a.kind,
        outcome: a.outcome,
        latencyMs: a.latencyMs,
        inputTokens: a.usage.inputTokens,
        outputTokens: a.usage.outputTokens,
        costUsd: a.costUsd,
        errorName: a.errorName,
      };
      if (a.outcome === 'ok') this.#logger.info('ai.model.attempt', fields);
      else this.#logger.warn('ai.model.attempt', fields);
    }
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    if (!(MODEL_PURPOSES as readonly string[]).includes(request.purpose)) {
      throw new TypeError(`Unknown model purpose: ${request.purpose}`);
    }
    const started = performance.now();
    const strict = toStrictJsonSchema(request.zodSchema);
    const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const raw: RawModelAttempt[] = [];

    const run = async (provider: StructuredProvider, timeoutMs: number) => {
      const deadline = new Deadline(timeoutMs, request.signal);
      try {
        const result = await provider.generate({
          system: request.system,
          messages: request.messages,
          schemaName: request.schemaName,
          zodSchema: request.zodSchema,
          strict,
          maxOutputTokens,
          deadline,
          requestId: request.requestId,
        });
        raw.push(...result.rawAttempts);
        return result;
      } catch (error) {
        if (isModelGatewayError(error)) raw.push(...error.rawAttempts);
        throw error;
      } finally {
        deadline.dispose();
      }
    };

    const finish = (value: T, modelId: string, fallbackUsed: boolean): GenerateStructuredResult<T> => {
      const attempts = priceAttempts(raw, this.#pricing);
      this.#logAttempts(attempts, request.requestId, request.purpose);
      return {
        value,
        modelId,
        fallbackUsed,
        usage: totalUsage(attempts),
        costUsd: sumUsd(attempts.map((a) => a.costUsd)),
        latencyMs: Math.round(performance.now() - started),
        attempts,
      };
    };

    const failWith = (error: unknown): never => {
      if (error instanceof ModelGatewayError) {
        error.attempts = priceAttempts(raw, this.#pricing);
        error.rawAttempts = [...raw];
        this.#logAttempts(error.attempts, request.requestId, request.purpose);
      }
      throw error;
    };

    let primaryError: unknown;
    try {
      const result = await run(this.#primary, request.timeoutMs ?? this.#primaryTimeoutMs);
      return finish(result.value, result.modelId, false);
    } catch (error) {
      if (!shouldFallback(error)) return failWith(error);
      primaryError = error;
    }

    this.#logger.warn('ai.model.fallback', {
      requestId: request.requestId,
      purpose: request.purpose,
      from: this.#primary.modelId,
      to: this.#fallback.modelId,
      reason:
        primaryError instanceof ModelUnavailableError
          ? primaryError.reason
          : (primaryError as ModelGatewayError).code,
    });
    try {
      const result = await run(this.#fallback, this.#fallbackTimeoutMs);
      return finish(result.value, result.modelId, true);
    } catch (error) {
      return failWith(error);
    }
  }

  async embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        modelId: this.#embedder.modelId,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
      };
    }
    const started = performance.now();
    try {
      const result = await this.#embedder.embed(texts, options.signal);
      const costUsd = costFor(result.modelId, result.usage, this.#pricing);
      this.#logger.info('ai.embed', {
        requestId: options.requestId ?? null,
        purpose: options.purpose,
        modelId: result.modelId,
        count: texts.length,
        inputTokens: result.usage.inputTokens,
        costUsd,
        latencyMs: Math.round(performance.now() - started),
      });
      return { ...result, costUsd, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      if (error instanceof ModelGatewayError) {
        error.attempts = priceAttempts(error.rawAttempts, this.#pricing);
        this.#logger.warn('ai.embed.failed', {
          requestId: options.requestId ?? null,
          purpose: options.purpose,
          modelId: this.#embedder.modelId,
          count: texts.length,
          code: error.code,
          attempts: error.attempts.length,
        });
      }
      throw error;
    }
  }
}

/**
 * Creates the model gateway. Primary and fallback each get the adapter their model id calls for
 * ({@link reasoningAdapterFor}): `openai.*` → Luna on Mantle (strict JSON schema, one repair retry),
 * anything else → Converse with a forced tool (Nova 2 Lite, also through `us.`/`global.` inference
 * profiles). The fallback runs when the primary is unavailable (timeout, throttling, 5xx, access),
 * refuses or returns invalid output. Titan V2 embeddings. `provider: 'mock'` returns the deterministic
 * {@link MockModelGateway}.
 */
export function createModelGateway(config: ModelGatewayConfig): ModelGateway {
  if (config.provider === 'mock') return new MockModelGateway(config);
  return new BedrockModelGateway(config);
}

const EnvSchema = z.object({
  APP_ENV: z.enum(['production', 'development', 'test']).default('development'),
  MODEL_PROVIDER: z.enum(['bedrock', 'mock']).optional(),
  MODEL_PRIMARY_ID: z.string().min(1).default(DEFAULT_MODEL_IDS.primary),
  MODEL_FALLBACK_ID: z.string().min(1).default(DEFAULT_MODEL_IDS.fallback),
  MODEL_EMBEDDINGS_ID: z.string().min(1).default(DEFAULT_MODEL_IDS.embeddings),
  BEDROCK_REGION: z
    .string()
    .regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/)
    .default('us-east-1'),
});

/**
 * Reads gateway configuration from the runtime contract's environment variables
 * (`MODEL_PROVIDER`, `MODEL_PRIMARY_ID`, `MODEL_FALLBACK_ID`, `MODEL_EMBEDDINGS_ID`, `BEDROCK_REGION`).
 * `MODEL_PROVIDER` defaults to `mock` outside production and is mandatory in production.
 */
export function modelGatewayConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  extras: { logger?: ModelLogger; pricing?: Readonly<Record<string, ModelPrice>> } = {},
): ModelGatewayConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid model gateway environment: ${keys}`);
  }
  const e = parsed.data;
  const provider = e.MODEL_PROVIDER ?? (e.APP_ENV === 'production' ? null : 'mock');
  if (provider === null) throw new Error('MODEL_PROVIDER must be set in production');
  if (provider === 'mock') return { provider: 'mock' };
  return {
    provider: 'bedrock',
    region: e.BEDROCK_REGION,
    primaryModelId: e.MODEL_PRIMARY_ID,
    fallbackModelId: e.MODEL_FALLBACK_ID,
    embeddingsModelId: e.MODEL_EMBEDDINGS_ID,
    ...(extras.logger ? { logger: extras.logger } : {}),
    ...(extras.pricing ? { pricing: extras.pricing } : {}),
  };
}
