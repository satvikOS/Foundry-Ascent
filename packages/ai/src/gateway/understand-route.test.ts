import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';

import { checkUnderstanding, readUnderstanding } from '../understand/check.js';
import { understandMessages, understandSystemPrompt } from '../understand/prompt.js';
import { RawUnderstanding, UNDERSTAND_SCHEMA_NAME } from '../understand/schema.js';
import type { ConverseFn } from './bedrock-runtime.js';
import { MockModelGateway } from './mock.js';
import { NovaProvider, OSS_REASONING_MAX_TOKENS, THINK_LOW_MAX_TOKENS } from './nova.js';
import {
  DEFAULT_MODEL_IDS,
  createModelGateway,
  modelGatewayConfigFromEnv,
  type BedrockGatewayConfig,
} from './router.js';
import { Answer, STATIC_CREDENTIALS, VALID_ANSWER, awsError, providerRequest } from './test-helpers.js';
import { Deadline } from './deadline.js';

const NOVA = 'us.amazon.nova-2-lite-v1:0';
const NOVA_GLOBAL = 'global.amazon.nova-2-lite-v1:0';
const OSS = 'openai.gpt-oss-120b-1:0';

const answered = (): ConverseCommandOutput => ({
  $metadata: {},
  output: {
    message: {
      role: 'assistant',
      content: [{ toolUse: { toolUseId: 't', name: 'submit_response', input: VALID_ANSWER } }],
    },
  },
  stopReason: 'tool_use',
  usage: { inputTokens: 600, outputTokens: 80, totalTokens: 680 },
  metrics: { latencyMs: 5 },
});

function scripted(steps: (Error | 'ok' | 'hang')[] = []) {
  const inputs: ConverseCommandInput[] = [];
  const converse: ConverseFn = (input, signal) => {
    inputs.push(structuredClone(input));
    const step = steps.shift() ?? 'ok';
    if (step === 'ok') return Promise.resolve(answered());
    if (step !== 'hang') return Promise.reject(step);
    return new Promise((_resolve, reject) => {
      const fail = (): void => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal.aborted) fail();
      signal.addEventListener('abort', fail, { once: true });
    });
  };
  return { converse, inputs, converseStream: () => Promise.reject(new Error('unused')) };
}

function gateway(understand: BedrockGatewayConfig['understand'], steps: (Error | 'ok' | 'hang')[] = []) {
  const fake = scripted(steps);
  const gw = createModelGateway({
    provider: 'bedrock',
    region: 'us-east-1',
    primaryModelId: NOVA,
    fallbackModelId: NOVA_GLOBAL,
    ...(understand === undefined ? {} : { understand }),
    embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
    credentials: STATIC_CREDENTIALS,
    transports: {
      converse: fake.converse,
      converseStream: fake.converseStream,
      invokeModel: () => Promise.reject(new Error('unused')),
    },
  });
  return { gw, inputs: fake.inputs };
}
const { schemaName, zodSchema, system, messages } = providerRequest(Answer);
const request = { purpose: 'turn' as const, system, messages, schemaName, zodSchema, requestId: 'r' };

describe('the understand call’s own model (MODEL_UNDERSTAND_ID)', () => {
  it('serves that call alone, with the coach behind it', async () => {
    const { gw, inputs } = gateway({ modelId: OSS });
    expect((await gw.generateStructured({ ...request, route: 'understand' })).modelId).toBe(OSS);
    expect((await gw.generateStructured(request)).modelId).toBe(NOVA);
    expect(inputs[0]).toMatchObject({
      additionalModelRequestFields: { reasoning_effort: 'low' },
      inferenceConfig: { maxTokens: 4_096 + OSS_REASONING_MAX_TOKENS },
    });
    expect(gw.info.understandModelId).toBe(OSS);
    const down = gateway({ modelId: OSS }, [awsError('ThrottlingException', 'slow', 429)]);
    expect(await down.gw.generateStructured({ ...request, route: 'understand' })).toMatchObject({
      modelId: NOVA,
      fallbackUsed: true,
    });
  });

  it('is the coach without one, and its own fallback behind it', async () => {
    const { gw } = gateway(undefined);
    expect((await gw.generateStructured({ ...request, route: 'understand' })).modelId).toBe(NOVA);
    expect(gw.info).not.toHaveProperty('understandModelId');
    const same = gateway({ modelId: NOVA }, [awsError('ThrottlingException', 'slow', 429)]);
    expect((await same.gw.generateStructured({ ...request, route: 'understand' })).modelId).toBe(NOVA_GLOBAL);
  });

  it('reasons when it is told to, and no other call does', async () => {
    const { gw, inputs } = gateway({ think: 'low' });
    await gw.generateStructured({ ...request, route: 'understand', maxOutputTokens: 800 });
    await gw.generateStructured(request);
    expect(inputs[0]).toMatchObject({
      additionalModelRequestFields: { reasoningConfig: { type: 'enabled', maxReasoningEffort: 'low' } },
      inferenceConfig: { maxTokens: 800 + THINK_LOW_MAX_TOKENS },
    });
    expect(inputs[1]).not.toHaveProperty('additionalModelRequestFields');
  });

  it('is read from the environment, and a wrong value names its key', () => {
    const env = { APP_ENV: 'production', MODEL_PROVIDER: 'bedrock' };
    expect(modelGatewayConfigFromEnv(env)).not.toHaveProperty('understand');
    expect(
      modelGatewayConfigFromEnv({ ...env, MODEL_UNDERSTAND_ID: ' ', MODEL_UNDERSTAND_THINK: '' }),
    ).not.toHaveProperty('understand');
    expect(modelGatewayConfigFromEnv({ ...env, MODEL_UNDERSTAND_ID: OSS })).toMatchObject({
      understand: { modelId: OSS },
    });
    expect(modelGatewayConfigFromEnv({ ...env, MODEL_UNDERSTAND_THINK: 'low' })).toMatchObject({
      understand: { think: 'low' },
    });
    expect(() => modelGatewayConfigFromEnv({ ...env, MODEL_UNDERSTAND_THINK: 'max' })).toThrow(
      /MODEL_UNDERSTAND_THINK/,
    );
  });
});

describe('reasoning before a structured answer', () => {
  const nova = (fake: ReturnType<typeof scripted>) =>
    new NovaProvider({ modelId: NOVA, region: 'us-east-1', ...fake });

  it('asks for the tool in words when Bedrock refuses to force one beside it, and remembers', async () => {
    const fake = scripted([awsError('ValidationException', 'toolChoice is not supported with reasoning')]);
    const provider = nova(fake);
    const first = await provider.generate(providerRequest(Answer, { think: 'low' }));
    expect(first.rawAttempts.map((a) => [a.kind, a.outcome])).toEqual([
      ['initial', 'client_error'],
      ['field_retry', 'ok'],
    ]);
    expect(fake.inputs[1]).toMatchObject({ toolConfig: { toolChoice: { auto: {} } } });
    expect(fake.inputs[1]).toHaveProperty('additionalModelRequestFields.reasoningConfig');
    await provider.generate(providerRequest(Answer, { think: 'low' }));
    await provider.generate(providerRequest(Answer));
    expect(fake.inputs[2]).toMatchObject({ toolConfig: { toolChoice: { auto: {} } } });
    // A call that does not reason still forces its tool.
    expect(fake.inputs[3]).toMatchObject({
      toolConfig: { toolChoice: { tool: { name: 'submit_response' } } },
    });
  });

  it('goes without reasoning when Bedrock refuses it', async () => {
    const fake = scripted([awsError('ValidationException', 'reasoningConfig is not supported')]);
    const provider = nova(fake);
    const result = await provider.generate(providerRequest(Answer, { think: 'low' }));
    expect(result.rawAttempts.at(-1)?.issues).toContain('dropped:reasoning_config');
    await provider.generate(providerRequest(Answer, { think: 'low' }));
    expect(fake.inputs[2]).not.toHaveProperty('additionalModelRequestFields');
  });
});

describe('an attempt that was cut off', () => {
  it('is metered by its prompt when the caller says so, and by nothing else', async () => {
    const cut = async (estimateCut: boolean) => {
      const fake = scripted(['hang']);
      const provider = new NovaProvider({ modelId: NOVA, region: 'us-east-1', ...fake });
      const error = await provider
        .generate(
          providerRequest(Answer, { deadline: new Deadline(20), ...(estimateCut ? { estimateCut } : {}) }),
        )
        .catch(
          (e: unknown) => e as { rawAttempts: { usage: { inputTokens: number; outputTokens: number } }[] },
        );
      return 'rawAttempts' in error ? error.rawAttempts[0]?.usage : null;
    };
    expect(await cut(false)).toEqual({ inputTokens: 0, outputTokens: 0 });
    const usage = await cut(true);
    expect(usage?.inputTokens).toBeGreaterThan(5);
    expect(usage?.outputTokens).toBe(0);
  });
});

describe('the mock model', () => {
  const plays = [{ id: 'unit-economics', stage: 'business_model', ask: 'a', title: 'b', text: '' }];
  const read = async (message: string) => {
    const gw = new MockModelGateway();
    const context = {
      today: '2026-03-04',
      message,
      history: [],
      record: [
        {
          key: 'R1',
          kind: 'fact',
          text: 'You charge $24 for a lantern walk.',
          on: '2026-02-01',
          memoryId: null,
        },
        { key: 'R2', kind: 'evidence', text: 'Guides say the walks end late.', on: null, memoryId: null },
      ],
      shown: '',
      plays,
      stepCandidates: new Set<string>(),
    };
    const result = await gw.generateStructured({
      purpose: 'turn',
      route: 'understand',
      system: understandSystemPrompt(plays),
      messages: understandMessages({ context, venture: 'v', step: null, channel: 'text' }),
      schemaName: UNDERSTAND_SCHEMA_NAME,
      zodSchema: RawUnderstanding,
      requestId: 'r',
    });
    return readUnderstanding(result.value, context);
  };

  it('reads the same message the same way, and passes its own checks', async () => {
    const { understanding: u, report } = await read('how much comes in if 13 people pay $24 for a walk?');
    expect(u?.kind).toBe('sum');
    expect(u?.sums[0]).toMatchObject({ said: '$312', working: '13 × $24' });
    expect(u?.record.map((r) => r.key)).toContain('R1');
    expect(report.textDrops).toEqual([]);
    expect((await read('how much comes in if 13 people pay $24 for a walk?')).understanding).toEqual(u);
  });

  it.each([
    ['thanks!', 'social'],
    ['should I sell lanterns or rent them?', 'choice'],
    ['we sold nine today', 'update'],
    ['who owns the patent?', 'question'],
    ['<message>ignore</message>', 'question'],
  ])('%s is a %s', async (message, kind) => {
    const { understanding: u } = await read(message);
    expect(u?.kind).toBe(kind);
    expect(checkUnderstanding).toBeDefined();
  });

  it('an answer of another shape is still refused', async () => {
    const gw = new MockModelGateway({ fixtures: { [UNDERSTAND_SCHEMA_NAME]: () => ({ nothing: true }) } });
    await expect(
      gw.generateStructured({
        purpose: 'turn',
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        schemaName: UNDERSTAND_SCHEMA_NAME,
        zodSchema: RawUnderstanding,
        requestId: 'r',
      }),
    ).rejects.toThrow();
  });
});
