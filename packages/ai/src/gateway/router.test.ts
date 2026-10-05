import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';

import { costFor } from '../pricing.js';
import type { ConverseFn, InvokeModelFn } from './bedrock-runtime.js';
import {
  ModelOutputInvalidError,
  ModelRefusalError,
  ModelUnavailableError,
  type ModelGatewayError,
} from './errors.js';
import { MockModelGateway } from './mock.js';
import type { ProviderRequest, ProviderResult, StructuredProvider } from './provider.js';
import {
  DEFAULT_MODEL_IDS,
  createModelGateway,
  modelGatewayConfigFromEnv,
  reasoningAdapterFor,
  type BedrockGatewayConfig,
} from './router.js';
import {
  Answer,
  STATIC_CREDENTIALS,
  VALID_ANSWER,
  awsError,
  chatCompletion,
  jsonResponse,
  scriptedFetch,
} from './test-helpers.js';
import type { LogFields, ModelLogger, RawModelAttempt } from './types.js';

type Behaviour = (request: ProviderRequest<unknown>) => Promise<ProviderResult<unknown>>;

class FakeProvider implements StructuredProvider {
  calls = 0;
  constructor(
    readonly name: 'luna' | 'nova',
    readonly modelId: string,
    private readonly behaviour: Behaviour,
  ) {}
  generate<T>(request: ProviderRequest<T>): Promise<ProviderResult<T>> {
    this.calls += 1;
    return this.behaviour(request) as Promise<ProviderResult<T>>;
  }
}

function attempt(
  provider: 'luna' | 'nova',
  modelId: string,
  outcome: RawModelAttempt['outcome'],
  input = 1_000,
  output = 200,
): RawModelAttempt {
  return {
    provider,
    modelId,
    kind: 'initial',
    outcome,
    latencyMs: 5,
    usage: { inputTokens: input, outputTokens: output },
    errorName: null,
  };
}

const LUNA = DEFAULT_MODEL_IDS.primary;
const NOVA = DEFAULT_MODEL_IDS.fallback;

const ok =
  (provider: 'luna' | 'nova', modelId: string): Behaviour =>
  () =>
    Promise.resolve({ value: VALID_ANSWER, modelId, rawAttempts: [attempt(provider, modelId, 'ok')] });

const fail =
  (error: ModelGatewayError, raw: RawModelAttempt[]): Behaviour =>
  () => {
    error.rawAttempts = raw;
    return Promise.reject(error);
  };

function recordingLogger(): ModelLogger & { events: { level: string; event: string; fields: LogFields }[] } {
  const events: { level: string; event: string; fields: LogFields }[] = [];
  return {
    events,
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
  };
}

function gateway(primary: Behaviour, fallback: Behaviour, extra: Partial<BedrockGatewayConfig> = {}) {
  const p = new FakeProvider('luna', LUNA, primary);
  const f = new FakeProvider('nova', NOVA, fallback);
  const logger = recordingLogger();
  const gw = createModelGateway({
    provider: 'bedrock',
    region: 'us-east-1',
    primaryModelId: LUNA,
    fallbackModelId: NOVA,
    embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
    credentials: STATIC_CREDENTIALS,
    providers: { primary: p, fallback: f },
    transports: { invokeModel: () => Promise.reject(new Error('unused')) },
    logger,
    ...extra,
  });
  return { gw, p, f, logger };
}

const request = {
  purpose: 'turn' as const,
  system: 'SYSTEM PROMPT SECRET',
  messages: [{ role: 'user' as const, content: 'FOUNDER TEXT SECRET' }],
  schemaName: 'Answer',
  zodSchema: Answer,
  requestId: 'req-1',
};

describe('model router — primary/fallback policy', () => {
  it('returns the primary result without fallback', async () => {
    const { gw, f } = gateway(ok('luna', LUNA), ok('nova', NOVA));
    const result = await gw.generateStructured(request);
    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.modelId).toBe(LUNA);
    expect(result.fallbackUsed).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 1_000, outputTokens: 200 });
    expect(result.attempts).toHaveLength(1);
    expect(result.costUsd).toBe(costFor(LUNA, { inputTokens: 1_000, outputTokens: 200 }));
    expect(result.costUsd).toBeCloseTo(((1_000 * 0.1 + 200 * 0.5) * 1.1) / 1_000_000, 9);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(f.calls).toBe(0);
  });

  it.each([
    ['timeout', () => new ModelUnavailableError('timeout', LUNA), 'timeout'],
    ['throttling', () => new ModelUnavailableError('throttled', LUNA), 'throttled'],
    ['5xx', () => new ModelUnavailableError('server_error', LUNA), 'server_error'],
    ['refusal', () => new ModelRefusalError(LUNA, 'model'), 'refusal'],
    [
      'invalid output after repair',
      () => new ModelOutputInvalidError(LUNA, ['answer: invalid_type']),
      'invalid_output',
    ],
    ['client error / access', () => new ModelUnavailableError('client_error', LUNA), 'client_error'],
  ] as const)('falls back to Nova on %s and records every attempt', async (_label, makeError, outcome) => {
    const { gw, f, logger } = gateway(
      fail(makeError(), [attempt('luna', LUNA, outcome, 900, 0)]),
      ok('nova', NOVA),
    );
    const result = await gw.generateStructured(request);
    expect(result.fallbackUsed).toBe(true);
    expect(result.modelId).toBe(NOVA);
    expect(f.calls).toBe(1);
    expect(result.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['luna', outcome],
      ['nova', 'ok'],
    ]);
    expect(result.usage).toEqual({ inputTokens: 1_900, outputTokens: 200 });
    const expectedCost =
      costFor(LUNA, { inputTokens: 900, outputTokens: 0 }) +
      costFor(NOVA, { inputTokens: 1_000, outputTokens: 200 });
    expect(result.costUsd).toBeCloseTo(expectedCost, 6);
    expect(logger.events.some((e) => e.event === 'ai.model.fallback' && e.fields.to === NOVA)).toBe(true);
  });

  it('does not fall back on caller cancellation', async () => {
    const { gw, f } = gateway(
      fail(new ModelUnavailableError('aborted', LUNA), [attempt('luna', LUNA, 'aborted', 0, 0)]),
      ok('nova', NOVA),
    );
    const error = (await gw.generateStructured(request).catch((e: unknown) => e)) as ModelUnavailableError;
    expect(error.reason).toBe('aborted');
    expect(error.attempts).toHaveLength(1);
    expect(f.calls).toBe(0);
  });

  it('enforces the primary timeout itself and falls back', async () => {
    const hanging: Behaviour = (req) =>
      new Promise((_resolve, reject) => {
        req.deadline.signal.addEventListener('abort', () => {
          const error = new ModelUnavailableError(req.deadline.timedOut ? 'timeout' : 'aborted', LUNA);
          error.rawAttempts = [attempt('luna', LUNA, 'timeout', 0, 0)];
          reject(error);
        });
      });
    const { gw } = gateway(hanging, ok('nova', NOVA));
    const started = Date.now();
    const result = await gw.generateStructured({ ...request, timeoutMs: 40 });
    expect(result.fallbackUsed).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('defaults the primary timeout to 25 s', async () => {
    let remaining = 0;
    const { gw } = gateway(
      (req) => {
        remaining = req.deadline.remainingMs();
        return ok('luna', LUNA)(req);
      },
      ok('nova', NOVA),
    );
    await gw.generateStructured(request);
    expect(remaining).toBeGreaterThan(24_000);
    expect(remaining).toBeLessThanOrEqual(25_000);
  });

  it('throws the fallback error with priced attempts from both models when both fail', async () => {
    const { gw } = gateway(
      fail(new ModelUnavailableError('server_error', LUNA), [attempt('luna', LUNA, 'server_error', 0, 0)]),
      fail(new ModelOutputInvalidError(NOVA, ['(root): no_tool_use:end_turn']), [
        attempt('nova', NOVA, 'invalid_output', 800, 50),
      ]),
    );
    const error = (await gw.generateStructured(request).catch((e: unknown) => e)) as ModelOutputInvalidError;
    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect(error.attempts.map((a) => a.provider)).toEqual(['luna', 'nova']);
    expect(error.attempts[1]?.costUsd).toBe(costFor(NOVA, { inputTokens: 800, outputTokens: 50 }));
  });

  it('rejects unknown purposes', async () => {
    const { gw } = gateway(ok('luna', LUNA), ok('nova', NOVA));
    await expect(gw.generateStructured({ ...request, purpose: 'bogus' as 'turn' })).rejects.toThrow(
      TypeError,
    );
  });

  it('never logs prompt or founder text', async () => {
    const { gw, logger } = gateway(
      fail(new ModelUnavailableError('server_error', LUNA), [attempt('luna', LUNA, 'server_error', 0, 0)]),
      ok('nova', NOVA),
    );
    await gw.generateStructured(request);
    const serialized = JSON.stringify(logger.events);
    expect(logger.events.length).toBeGreaterThanOrEqual(3);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).toContain('req-1');
  });

  it('exposes model info', () => {
    const { gw } = gateway(ok('luna', LUNA), ok('nova', NOVA));
    expect(gw.info).toEqual({
      provider: 'bedrock',
      primaryModelId: LUNA,
      fallbackModelId: NOVA,
      embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
      embeddingDimensions: 1024,
    });
  });
});

describe('model router — end to end over fake transports', () => {
  it('Mantle 503 → Nova Converse fallback, both through the real providers', async () => {
    const { fetch, requests } = scriptedFetch([
      () => jsonResponse({ error: { message: 'unavailable' } }, 503),
    ]);
    const converse: ConverseFn = () =>
      Promise.resolve({
        $metadata: {},
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 't1', name: 'submit_response', input: VALID_ANSWER } }],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 700, outputTokens: 90, totalTokens: 790 },
        metrics: { latencyMs: 5 },
      } satisfies ConverseCommandOutput);
    const invokeModel: InvokeModelFn = () =>
      Promise.resolve(
        JSON.stringify({ embedding: new Array<number>(1024).fill(0.03125), inputTextTokenCount: 4 }),
      );
    const gw = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: LUNA,
      fallbackModelId: NOVA,
      embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
      credentials: STATIC_CREDENTIALS,
      transports: { mantleFetch: fetch, converse, invokeModel },
    });
    const result = await gw.generateStructured(request);
    expect(result.fallbackUsed).toBe(true);
    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['luna', 'server_error'],
      ['nova', 'ok'],
    ]);
    expect(requests[0]?.headers.get('authorization')).toContain('/bedrock-mantle/aws4_request');

    const embedded = await gw.embed(['hello world', 'second'], { purpose: 'ingestion', requestId: 'req-2' });
    expect(embedded.vectors).toHaveLength(2);
    expect(embedded.vectors[0]).toHaveLength(1024);
    expect(embedded.usage).toEqual({ inputTokens: 8, outputTokens: 0 });
    expect(embedded.costUsd).toBe(costFor(DEFAULT_MODEL_IDS.embeddings, embedded.usage));
    expect(await gw.embed([], { purpose: 'ingestion' })).toMatchObject({ vectors: [], costUsd: 0 });
  });

  it('Mantle success path returns Luna output', async () => {
    const { fetch } = scriptedFetch([() => chatCompletion(JSON.stringify(VALID_ANSWER))]);
    const gw = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: LUNA,
      fallbackModelId: NOVA,
      embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
      credentials: STATIC_CREDENTIALS,
      transports: {
        mantleFetch: fetch,
        converse: () => Promise.reject(new Error('unused')),
        invokeModel: () => Promise.reject(new Error('unused')),
      },
    });
    const result = await gw.generateStructured(request);
    expect(result).toMatchObject({
      modelId: LUNA,
      fallbackUsed: false,
      usage: { inputTokens: 1_000, outputTokens: 200 },
    });
  });
});

describe('model router — adapter chosen by model id', () => {
  const NOVA_US = 'us.amazon.nova-2-lite-v1:0';
  const NOVA_GLOBAL = 'global.amazon.nova-2-lite-v1:0';

  const toolUse = (input: typeof VALID_ANSWER): ConverseCommandOutput => ({
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't1', name: 'submit_response', input } }],
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 600, outputTokens: 80, totalTokens: 680 },
    metrics: { latencyMs: 5 },
  });

  /** Production shape while Luna is gated: Nova profiles for both primary and fallback, Converse only. */
  function novaGateway(converse: ConverseFn) {
    const mantleCalls: string[] = [];
    const logger = recordingLogger();
    const gw = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: NOVA_US,
      fallbackModelId: NOVA_GLOBAL,
      embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
      credentials: STATIC_CREDENTIALS,
      logger,
      transports: {
        mantleFetch: (input) => {
          mantleCalls.push(
            input instanceof Request ? input.url : typeof input === 'string' ? input : input.href,
          );
          return Promise.reject(new Error('Mantle must not be called for Nova models'));
        },
        converse,
        invokeModel: () => Promise.reject(new Error('unused')),
      },
    });
    return { gw, mantleCalls, logger };
  }

  it.each([
    ['openai.gpt-6-luna', 'mantle'],
    ['openai.gpt-oss-120b-1:0', 'mantle'],
    ['us.amazon.nova-2-lite-v1:0', 'converse'],
    ['global.amazon.nova-2-lite-v1:0', 'converse'],
    ['amazon.nova-2-lite-v1:0', 'converse'],
    ['eu.amazon.nova-2-lite-v1:0', 'converse'],
  ] as const)('%s → %s', (modelId, adapter) => {
    expect(reasoningAdapterFor(modelId)).toBe(adapter);
  });

  it('sends a Nova inference-profile primary to Converse with the id unchanged (never to Mantle)', async () => {
    const modelIds: (string | undefined)[] = [];
    const { gw, mantleCalls } = novaGateway((input) => {
      modelIds.push(input.modelId);
      return Promise.resolve(toolUse(VALID_ANSWER));
    });
    const result = await gw.generateStructured(request);
    expect(result).toMatchObject({ value: VALID_ANSWER, modelId: NOVA_US, fallbackUsed: false });
    expect(result.attempts.map((a) => [a.provider, a.modelId, a.outcome])).toEqual([['nova', NOVA_US, 'ok']]);
    expect(modelIds).toEqual([NOVA_US]);
    expect(mantleCalls).toEqual([]);
    expect(gw.info).toMatchObject({ primaryModelId: NOVA_US, fallbackModelId: NOVA_GLOBAL });
  });

  it.each([
    ['throttling', 'ThrottlingException', 429, 'throttled'],
    ['5xx', 'InternalServerException', 500, 'server_error'],
    ['service unavailable', 'ServiceUnavailableException', 503, 'server_error'],
    ['model unavailable', 'ModelNotReadyException', 429, 'server_error'],
  ] as const)(
    'falls back from the us. profile to the global. profile on %s',
    async (_label, errorName, status, outcome) => {
      const modelIds: (string | undefined)[] = [];
      const { gw, logger } = novaGateway((input) => {
        modelIds.push(input.modelId);
        return input.modelId === NOVA_US
          ? Promise.reject(awsError(errorName, 'provider message that must not be logged', status))
          : Promise.resolve(toolUse(VALID_ANSWER));
      });
      const result = await gw.generateStructured(request);
      expect(result).toMatchObject({ value: VALID_ANSWER, modelId: NOVA_GLOBAL, fallbackUsed: true });
      expect(modelIds).toEqual([NOVA_US, NOVA_GLOBAL]);
      expect(result.attempts.map((a) => [a.modelId, a.outcome])).toEqual([
        [NOVA_US, outcome],
        [NOVA_GLOBAL, 'ok'],
      ]);
      const fallback = logger.events.find((e) => e.event === 'ai.model.fallback');
      expect(fallback?.fields).toMatchObject({ from: NOVA_US, to: NOVA_GLOBAL, reason: outcome });
      expect(JSON.stringify(logger.events)).not.toContain('provider message');
    },
  );

  it('does not retry a profile id as another profile (us./global. ids pass through as given)', async () => {
    const modelIds: (string | undefined)[] = [];
    const { gw } = novaGateway((input) => {
      modelIds.push(input.modelId);
      return Promise.reject(
        awsError('ValidationException', "Invocation with on-demand throughput isn't supported.", 400),
      );
    });
    const error = (await gw.generateStructured(request).catch((e: unknown) => e)) as ModelUnavailableError;
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error.reason).toBe('client_error');
    expect(modelIds).toEqual([NOVA_US, NOVA_GLOBAL]);
  });

  it('a bare foundation-model fallback still retries once through its us. profile', async () => {
    const modelIds: (string | undefined)[] = [];
    const gw = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: NOVA_US,
      fallbackModelId: 'amazon.nova-2-lite-v1:0',
      embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
      credentials: STATIC_CREDENTIALS,
      transports: {
        converse: (input) => {
          modelIds.push(input.modelId);
          if (modelIds.length === 1) return Promise.reject(awsError('ThrottlingException', 'slow down', 429));
          if (input.modelId === 'amazon.nova-2-lite-v1:0') {
            return Promise.reject(
              awsError('ValidationException', "Invocation with on-demand throughput isn't supported.", 400),
            );
          }
          return Promise.resolve(toolUse(VALID_ANSWER));
        },
        invokeModel: () => Promise.reject(new Error('unused')),
      },
    });
    const result = await gw.generateStructured(request);
    expect(result.fallbackUsed).toBe(true);
    expect(modelIds).toEqual([NOVA_US, 'amazon.nova-2-lite-v1:0', NOVA_US]);
  });
});

describe('modelGatewayConfigFromEnv', () => {
  it('defaults to the mock provider outside production', () => {
    expect(modelGatewayConfigFromEnv({ APP_ENV: 'test' })).toEqual({ provider: 'mock' });
    expect(modelGatewayConfigFromEnv({})).toEqual({ provider: 'mock' });
    expect(createModelGateway(modelGatewayConfigFromEnv({ APP_ENV: 'development' }))).toBeInstanceOf(
      MockModelGateway,
    );
  });

  it('requires MODEL_PROVIDER in production', () => {
    expect(() => modelGatewayConfigFromEnv({ APP_ENV: 'production' })).toThrow(/MODEL_PROVIDER/);
  });

  it('reads Bedrock settings from the runtime contract variables', () => {
    expect(
      modelGatewayConfigFromEnv({
        APP_ENV: 'production',
        MODEL_PROVIDER: 'bedrock',
        MODEL_PRIMARY_ID: 'openai.gpt-6-luna',
        MODEL_FALLBACK_ID: 'us.amazon.nova-2-lite-v1:0',
        MODEL_EMBEDDINGS_ID: 'amazon.titan-embed-text-v2:0',
        BEDROCK_REGION: 'us-east-1',
      }),
    ).toEqual({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: 'openai.gpt-6-luna',
      fallbackModelId: 'us.amazon.nova-2-lite-v1:0',
      embeddingsModelId: 'amazon.titan-embed-text-v2:0',
    });
  });

  it('rejects invalid values without echoing them', () => {
    expect(() =>
      modelGatewayConfigFromEnv({ MODEL_PROVIDER: 'openai', BEDROCK_REGION: 'not a region' }),
    ).toThrow(/Invalid model gateway environment: .*MODEL_PROVIDER/);
  });
});
