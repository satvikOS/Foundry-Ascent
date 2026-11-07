import { z } from 'zod';

import { createPricingTable, costFor, sumUsd, type ModelPrice, type PricingTable } from '../pricing.js';
import {
  createBedrockRuntimeTransport,
  type ConverseFn,
  type ConverseStreamFn,
  type InvokeModelFn,
} from './bedrock-runtime.js';
import { Deadline } from './deadline.js';
import { ModelGatewayError, ModelUnavailableError, isModelGatewayError } from './errors.js';
import { toStrictJsonSchema } from './json-schema.js';
import { LunaProvider, type LunaReasoningEffort } from './luna.js';
import { MockModelGateway, type MockModelGatewayOptions } from './mock.js';
import { NovaProvider } from './nova.js';
import type { ProviderStreamResult, StructuredProvider } from './provider.js';
import type { AwsCredentialProvider, AwsCredentials, FetchFn } from './sigv4-fetch.js';
import { TitanEmbedder } from './titan.js';
import {
  MODEL_PURPOSES,
  noopLogger,
  type BackgroundModels,
  type EmbedOptions,
  type EmbedResult,
  type GatewayPurpose,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type ModelAttempt,
  type ModelGateway,
  type ModelGatewayInfo,
  type ModelLogger,
  type ModelUsage,
  type RawModelAttempt,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
} from './types.js';

export const DEFAULT_PRIMARY_TIMEOUT_MS = 25_000;
export const DEFAULT_FALLBACK_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** Default bound on a streamed plain-text answer. */
export const DEFAULT_STREAM_MAX_OUTPUT_TOKENS = 1_500;

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
  /**
   * The background purposes' own primary and fallback (`MODEL_BACKGROUND_*`), or absent: every purpose then uses
   * `primaryModelId` and `fallbackModelId`.
   */
  background?: BackgroundModels;
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
  /**
   * Bedrock prompt caching (`MODEL_PROMPT_CACHE`): Converse requests to a model with priced cache rates (Amazon Nova,
   * Claude Haiku 4.5: nova.ts `usesCachePoints`) carry cache checkpoints where the request's `promptCache` hint says
   * its unchanging prefix ends. Default true (docs/runbooks/latency.md).
   */
  promptCache?: boolean;
  /** Test seams: replace the network transports. */
  transports?: {
    mantleFetch?: FetchFn;
    converse?: ConverseFn;
    converseStream?: ConverseStreamFn;
    invokeModel?: InvokeModelFn;
  };
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

/** Tokens across attempts; the prompt-cache counts only when an attempt reported them. */
function totalUsage(attempts: readonly { readonly usage: ModelUsage }[]): ModelUsage {
  const sum = (pick: (u: ModelUsage) => number | undefined): number | undefined =>
    attempts.reduce<number | undefined>((acc, a) => {
      const value = pick(a.usage);
      return value === undefined ? acc : (acc ?? 0) + value;
    }, undefined);
  const read = sum((u) => u.cacheReadInputTokens);
  const write = sum((u) => u.cacheWriteInputTokens);
  return {
    inputTokens: sum((u) => u.inputTokens) ?? 0,
    outputTokens: sum((u) => u.outputTokens) ?? 0,
    ...(read === undefined ? {} : { cacheReadInputTokens: read }),
    ...(write === undefined ? {} : { cacheWriteInputTokens: write }),
  };
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

/** The primary and fallback provider a purpose is served by. */
interface Route {
  readonly primary: StructuredProvider;
  readonly fallback: StructuredProvider;
}

class BedrockModelGateway implements ModelGateway {
  readonly info: ModelGatewayInfo;
  /** Every purpose not in `#backgroundPurposes`. */
  readonly #route: Route;
  /** The background purposes' route, or null when there is none. */
  readonly #background: Route | null;
  readonly #backgroundPurposes: ReadonlySet<GatewayPurpose>;
  readonly #embedder: TitanEmbedder;
  readonly #pricing: PricingTable;
  readonly #logger: ModelLogger;
  readonly #primaryTimeoutMs: number;
  readonly #fallbackTimeoutMs: number;
  /** Opens the Bedrock runtime connection without a billed call (null when the transports are injected). */
  readonly #prewarm: (() => Promise<void>) | null;

  constructor(config: BedrockGatewayConfig) {
    this.#pricing = createPricingTable(config.pricing);
    this.#logger = config.logger ?? noopLogger;
    this.#primaryTimeoutMs = config.primaryTimeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
    this.#fallbackTimeoutMs = config.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
    const credentials = config.credentials ? { credentials: config.credentials } : {};

    const usesConverse =
      (!config.providers?.primary && reasoningAdapterFor(config.primaryModelId) === 'converse') ||
      (!config.providers?.fallback && reasoningAdapterFor(config.fallbackModelId) === 'converse') ||
      [config.background?.primaryModelId, config.background?.fallbackModelId].some(
        (id) => id !== undefined && reasoningAdapterFor(id) === 'converse',
      );
    const needsRuntime =
      (usesConverse && (!config.transports?.converse || !config.transports.converseStream)) ||
      (!config.providers?.embedder && !config.transports?.invokeModel);
    // One BedrockRuntimeClient shared by every Converse provider and the embedder.
    const runtime = needsRuntime
      ? createBedrockRuntimeTransport({ region: config.region, ...credentials })
      : null;
    // Titan is warmed with Nova when this gateway embeds with it over the same runtime client.
    const warmsEmbeddings = !config.providers?.embedder && !config.transports?.invokeModel;
    this.#prewarm =
      runtime === null
        ? null
        : () =>
            runtime.prewarm(config.primaryModelId, warmsEmbeddings ? config.embeddingsModelId : undefined);
    const converse = config.transports?.converse ?? runtime?.converse;
    const converseStream = config.transports?.converseStream ?? runtime?.converseStream;

    // One provider per model id: the same id on two routes shares its instance (and what it learned, such as an
    // inference-profile retry or a refused cache checkpoint).
    const providers = new Map<string, StructuredProvider>();
    const reasoningProvider = (modelId: string): StructuredProvider => {
      const known = providers.get(modelId);
      if (known) return known;
      const created = newReasoningProvider(modelId);
      providers.set(modelId, created);
      return created;
    };
    const newReasoningProvider = (modelId: string): StructuredProvider =>
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
            ...(converseStream ? { converseStream } : {}),
            promptCache: config.promptCache !== false,
          });
    this.#route = {
      primary: config.providers?.primary ?? reasoningProvider(config.primaryModelId),
      fallback: config.providers?.fallback ?? reasoningProvider(config.fallbackModelId),
    };
    const background = config.background;
    this.#background =
      background === undefined
        ? null
        : {
            primary: reasoningProvider(background.primaryModelId),
            fallback: reasoningProvider(background.fallbackModelId),
          };
    this.#backgroundPurposes = new Set(background?.purposes ?? []);
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
      primaryModelId: this.#route.primary.modelId,
      fallbackModelId: this.#route.fallback.modelId,
      background:
        this.#background === null || background === undefined
          ? null
          : {
              primaryModelId: this.#background.primary.modelId,
              fallbackModelId: this.#background.fallback.modelId,
              purposes: [...background.purposes],
            },
      embeddingsModelId: this.#embedder.modelId,
      embeddingDimensions: this.#embedder.dimensions,
    };
  }

  async prewarm(): Promise<void> {
    await this.#prewarm?.();
  }

  /** The providers a purpose is served by. */
  #routeFor(purpose: GatewayPurpose): Route {
    return this.#background !== null && this.#backgroundPurposes.has(purpose)
      ? this.#background
      : this.#route;
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
        // Of inputTokens: read from and written to Bedrock's prompt cache, and the checkpoints the request carried.
        cachedInputTokens: a.usage.cacheReadInputTokens,
        cacheWriteInputTokens: a.usage.cacheWriteInputTokens,
        cachePoints: a.cachePoints,
        outputTokens: a.usage.outputTokens,
        costUsd: a.costUsd,
        errorName: a.errorName,
        ...(a.issues && a.issues.length > 0 ? { issues: a.issues.slice(0, 8).join(',') } : {}),
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
    const route = this.#routeFor(request.purpose);
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
          ...(request.promptCache ? { promptCache: request.promptCache } : {}),
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
      const result = await run(route.primary, request.timeoutMs ?? this.#primaryTimeoutMs);
      return finish(result.value, result.modelId, false);
    } catch (error) {
      if (!shouldFallback(error)) return failWith(error);
      primaryError = error;
    }

    this.#logger.warn('ai.model.fallback', {
      requestId: request.requestId,
      purpose: request.purpose,
      from: route.primary.modelId,
      to: route.fallback.modelId,
      reason:
        primaryError instanceof ModelUnavailableError
          ? primaryError.reason
          : (primaryError as ModelGatewayError).code,
    });
    try {
      const result = await run(route.fallback, this.#fallbackTimeoutMs);
      return finish(result.value, result.modelId, true);
    } catch (error) {
      return failWith(error);
    }
  }

  async streamText(request: StreamTextRequest, onText: TextChunkHandler): Promise<StreamTextResult> {
    if (!(MODEL_PURPOSES as readonly string[]).includes(request.purpose)) {
      throw new TypeError(`Unknown model purpose: ${request.purpose}`);
    }
    const started = performance.now();
    const route = this.#routeFor(request.purpose);
    const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_STREAM_MAX_OUTPUT_TOKENS;
    const raw: RawModelAttempt[] = [];
    // An object, not a `let`: the handler sets it while the provider runs (control-flow analysis cannot see that).
    const timing: { firstTokenAt: number | null } = { firstTokenAt: null };
    const deliver: TextChunkHandler = async (text) => {
      timing.firstTokenAt ??= performance.now();
      await onText(text);
    };

    const run = async (provider: StructuredProvider, timeoutMs: number): Promise<ProviderStreamResult> => {
      if (!provider.streamText) throw new ModelUnavailableError('config', provider.modelId);
      const deadline = new Deadline(timeoutMs, request.signal);
      try {
        const result = await provider.streamText({
          system: request.system,
          messages: request.messages,
          maxOutputTokens,
          deadline,
          requestId: request.requestId,
          ...(request.promptCache ? { promptCache: request.promptCache } : {}),
          onText: deliver,
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

    const finish = (result: ProviderStreamResult, fallbackUsed: boolean): StreamTextResult => {
      const attempts = priceAttempts(raw, this.#pricing);
      this.#logAttempts(attempts, request.requestId, request.purpose);
      return {
        text: result.text,
        modelId: result.modelId,
        fallbackUsed,
        usage: totalUsage(attempts),
        costUsd: sumUsd(attempts.map((a) => a.costUsd)),
        latencyMs: Math.round(performance.now() - started),
        firstTokenMs: timing.firstTokenAt === null ? null : Math.round(timing.firstTokenAt - started),
        stopReason: result.stopReason,
        attempts,
      };
    };

    const failWith = (error: unknown): never => {
      if (error instanceof ModelGatewayError) {
        error.attempts = priceAttempts(raw, this.#pricing);
        error.rawAttempts = [...raw];
        error.textDelivered = timing.firstTokenAt !== null;
        this.#logAttempts(error.attempts, request.requestId, request.purpose);
      }
      throw error;
    };

    let primaryError: unknown;
    try {
      return finish(await run(route.primary, request.timeoutMs ?? this.#primaryTimeoutMs), false);
    } catch (error) {
      // Once text has been shown, another model's answer would contradict it: no fallback.
      if (timing.firstTokenAt !== null || !shouldFallback(error)) return failWith(error);
      primaryError = error;
    }
    this.#logger.warn('ai.model.fallback', {
      requestId: request.requestId,
      purpose: request.purpose,
      from: route.primary.modelId,
      to: route.fallback.modelId,
      reason:
        primaryError instanceof ModelUnavailableError
          ? primaryError.reason
          : (primaryError as ModelGatewayError).code,
    });
    try {
      return finish(await run(route.fallback, this.#fallbackTimeoutMs), true);
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
 * anything else → Converse with a submit tool (Claude Haiku 4.5 and Nova 2 Lite, also through `us.`/`global.`
 * inference profiles). With `background`, the purposes it names use its own primary and fallback. The fallback runs
 * when the primary is unavailable (timeout, throttling, 5xx, access), refuses or returns invalid output; for streamed
 * text only while no text was delivered.
 * Titan V2 embeddings. `provider: 'mock'` returns the deterministic {@link MockModelGateway}.
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
  /** Bedrock prompt caching (cache checkpoints after each turn's unchanging prefix, for models with cache rates). */
  MODEL_PROMPT_CACHE: z.enum(['on', 'off']).default('on'),
  /** The background purposes' own models (all three, or none): see {@link BackgroundModels}. */
  // Empty is unset (the deployed functions always receive the three; empty when there is no background route).
  MODEL_BACKGROUND_PRIMARY_ID: z.string().optional(),
  MODEL_BACKGROUND_FALLBACK_ID: z.string().optional(),
  /** Comma-separated purposes (`MODEL_PURPOSES` but `embedding`, always Titan, and `speech`). */
  MODEL_BACKGROUND_PURPOSES: z.string().optional(),
});

/** `MODEL_BACKGROUND_*`: all three set, or none; the purposes known and never empty. */
function backgroundFromEnv(e: z.infer<typeof EnvSchema>): BackgroundModels | null {
  const set = [
    e.MODEL_BACKGROUND_PRIMARY_ID,
    e.MODEL_BACKGROUND_FALLBACK_ID,
    e.MODEL_BACKGROUND_PURPOSES,
  ].filter((value) => value !== undefined && value.trim() !== '').length;
  if (set === 0) return null;
  if (set !== 3) {
    throw new Error(
      'Invalid model gateway environment: MODEL_BACKGROUND_PRIMARY_ID, MODEL_BACKGROUND_FALLBACK_ID and MODEL_BACKGROUND_PURPOSES go together',
    );
  }
  const purposes = [
    ...new Set(
      (e.MODEL_BACKGROUND_PURPOSES ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== ''),
    ),
  ];
  // Embeddings always go to Titan and speech never reaches a reasoning model: neither can be a background purpose.
  const unknown = purposes.filter(
    (p) => !(MODEL_PURPOSES as readonly string[]).includes(p) || p === 'embedding' || p === 'speech',
  );
  if (purposes.length === 0 || unknown.length > 0) {
    throw new Error('Invalid model gateway environment: MODEL_BACKGROUND_PURPOSES');
  }
  return {
    primaryModelId: (e.MODEL_BACKGROUND_PRIMARY_ID ?? '').trim(),
    fallbackModelId: (e.MODEL_BACKGROUND_FALLBACK_ID ?? '').trim(),
    purposes: purposes as GatewayPurpose[],
  };
}

/**
 * Reads gateway configuration from the runtime contract's environment variables
 * (`MODEL_PROVIDER`, `MODEL_PRIMARY_ID`, `MODEL_FALLBACK_ID`, `MODEL_EMBEDDINGS_ID`, `BEDROCK_REGION`), the
 * optional `MODEL_PROMPT_CACHE` (`on` by default, `off` sends no cache checkpoints; the mock ignores it), and the
 * optional background route (`MODEL_BACKGROUND_PRIMARY_ID`, `MODEL_BACKGROUND_FALLBACK_ID`,
 * `MODEL_BACKGROUND_PURPOSES`: all three or none).
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
  const background = backgroundFromEnv(e);
  if (provider === 'mock') return { provider: 'mock' };
  return {
    provider: 'bedrock',
    region: e.BEDROCK_REGION,
    primaryModelId: e.MODEL_PRIMARY_ID,
    fallbackModelId: e.MODEL_FALLBACK_ID,
    ...(background === null ? {} : { background }),
    embeddingsModelId: e.MODEL_EMBEDDINGS_ID,
    promptCache: e.MODEL_PROMPT_CACHE === 'on',
    ...(extras.logger ? { logger: extras.logger } : {}),
    ...(extras.pricing ? { pricing: extras.pricing } : {}),
  };
}
