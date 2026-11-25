import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';

import { costFor } from '../pricing.js';
import type { ConverseFn, ConverseStreamFn } from './bedrock-runtime.js';
import { Deadline } from './deadline.js';
import { ModelUnavailableError } from './errors.js';
import {
  NovaProvider,
  SUBMIT_TOOL_NAME,
  forcesTool,
  OSS_REASONING_MAX_TOKENS,
  isGptOssModelId,
  isOpenAiModelId,
  usesCachePoints,
  withoutRefusedField,
  type NovaProviderOptions,
  type OpenAiRequestFields,
} from './nova.js';
import { createModelGateway, modelGatewayConfigFromEnv, reasoningAdapterFor } from './router.js';
import { Answer, VALID_ANSWER, awsError, providerRequest } from './test-helpers.js';

const LUNA = 'us.openai.gpt-6-luna';

type Step = (input: ConverseCommandInput) => ConverseCommandOutput;
type StreamStep = (input: ConverseStreamCommandInput) => AsyncIterable<ConverseStreamOutput>;

function scripted(steps: Step[], streamSteps: StreamStep[] = []) {
  const inputs: ConverseCommandInput[] = [];
  const streamInputs: ConverseStreamCommandInput[] = [];
  const converse: ConverseFn = async (input) => {
    inputs.push(structuredClone(input));
    const step = steps.shift();
    if (!step) throw new Error('unexpected converse call');
    return Promise.resolve(step(input));
  };
  const converseStream: ConverseStreamFn = async (input) => {
    streamInputs.push(structuredClone(input));
    const step = streamSteps.shift();
    if (!step) throw new Error('unexpected converseStream call');
    return Promise.resolve(step(input));
  };
  return { converse, converseStream, inputs, streamInputs };
}

function provider(
  fake: { converse: ConverseFn; converseStream: ConverseStreamFn },
  options: Partial<NovaProviderOptions> = {},
): NovaProvider {
  return new NovaProvider({
    modelId: LUNA,
    region: 'us-east-1',
    converse: fake.converse,
    converseStream: fake.converseStream,
    promptCache: true,
    ...options,
  });
}

function toolOutput(input: unknown): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'tooluse-1', name: SUBMIT_TOOL_NAME, input: input as never } }],
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
    metrics: { latencyMs: 10 },
  };
}

async function* events(items: readonly ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
const textDelta = (text: string): ConverseStreamOutput => ({
  contentBlockDelta: { contentBlockIndex: 1, delta: { text } },
});
const END: ConverseStreamOutput[] = [
  { messageStop: { stopReason: 'end_turn' } },
  {
    metadata: {
      usage: {
        inputTokens: 1_000,
        outputTokens: 40,
        totalTokens: 6_040,
        cacheReadInputTokens: 4_000,
        cacheWriteInputTokens: 1_000,
      },
      metrics: { latencyMs: 20 },
    },
  },
];

function streamRequest(onText: (t: string) => void, overrides: { temperature?: number } = {}) {
  return {
    system: 'SYSTEM',
    messages: [{ role: 'user' as const, content: 'FOUNDER' }],
    maxOutputTokens: 400,
    deadline: new Deadline(5_000),
    requestId: 'req-test',
    promptCache: { systemChars: 6, historyMessages: 0 },
    onText,
    ...overrides,
  };
}

const refuse = (message: string) => (): never => {
  throw awsError('ValidationException', message);
};
const TEMPERATURE_REFUSED = "Unsupported parameter: 'temperature' is not supported with this model.";
const EFFORT_REFUSED =
  "The model returned the following errors: Unsupported value: 'none' is not supported with this model.";
const TOOL_CHOICE_REFUSED = "Invalid parameter: 'tool_choice' must be 'auto' for this model.";

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('GPT-6 Luna on Converse: which adapter and request', () => {
  it('is served by Converse behind its profiles and by Mantle as the bare id', () => {
    expect(reasoningAdapterFor('us.openai.gpt-6-luna')).toBe('converse');
    expect(reasoningAdapterFor('global.openai.gpt-6-luna')).toBe('converse');
    expect(reasoningAdapterFor('openai.gpt-6-luna')).toBe('mantle');
    expect([LUNA, 'global.openai.gpt-6-luna', 'us.amazon.nova-2-lite-v1:0'].map(isOpenAiModelId)).toEqual([
      true,
      true,
      false,
    ]);
    expect(forcesTool(LUNA)).toBe(true);
    expect(usesCachePoints(LUNA)).toBe(false);
  });

  it('streams at effort none, with the coaching temperature and no cache checkpoints', async () => {
    const fake = scripted([], [() => events([textDelta('Hi.'), ...END])]);
    const seen: string[] = [];
    const luna = provider(fake);
    const result = await luna.streamText(streamRequest((t) => seen.push(t), { temperature: 0 }));
    expect(fake.streamInputs[0]).toEqual({
      modelId: LUNA,
      system: [{ text: 'SYSTEM' }],
      messages: [{ role: 'user', content: [{ text: 'FOUNDER' }] }],
      inferenceConfig: { maxTokens: 400, temperature: 0 },
      additionalModelRequestFields: { reasoning: { effort: 'none' } },
    });
    expect(seen.join('')).toBe('Hi.');
    // Implicit caching: what Bedrock reports is priced at the cache rates.
    expect(result.rawAttempts[0]).not.toHaveProperty('cachePoints');
    expect(result.rawAttempts[0]?.usage).toEqual({
      inputTokens: 6_000,
      outputTokens: 40,
      cacheReadInputTokens: 4_000,
      cacheWriteInputTokens: 1_000,
    });
  });

  it('never hands on reasoning, whether Bedrock keeps it apart or the model writes it into its text', async () => {
    const fake = scripted(
      [],
      [
        () =>
          events([
            {
              contentBlockDelta: {
                contentBlockIndex: 0,
                delta: { reasoningContent: { text: 'SECRET PLAN' } },
              },
            },
            textDelta('<thinking>SECRET TAG</thinking> Call the '),
            textDelta('theatre society.'),
            ...END,
          ]),
      ],
    );
    const seen: string[] = [];
    const result = await provider(fake, { reasoningEffort: 'low' }).streamText(
      streamRequest((t) => seen.push(t)),
    );
    expect(seen.join('')).toBe('Call the theatre society.');
    expect(result.text).not.toContain('SECRET');
  });

  it('sends a higher effort without a temperature, and meters a cut-off stream as reasoning', async () => {
    const fake = scripted(
      [],
      [
        () =>
          // eslint-disable-next-line require-yield -- the stream dies before its first event
          (async function* () {
            await Promise.resolve();
            throw awsError('ModelStreamErrorException', 'gone', 424);
          })(),
      ],
    );
    const error = await captureError(
      provider(fake, { reasoningEffort: 'medium' }).streamText(
        streamRequest(() => undefined, { temperature: 0 }),
      ),
    );
    expect(fake.streamInputs[0]?.inferenceConfig).toEqual({ maxTokens: 400 });
    expect(fake.streamInputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort: 'medium' } });
    // Hidden reasoning is billed as output: the request's whole output bound.
    expect((error as ModelUnavailableError).rawAttempts[0]?.usage.outputTokens).toBe(400);
  });

  it('forces the submit tool for structured output', async () => {
    const fake = scripted([() => toolOutput(VALID_ANSWER)]);
    const result = await provider(fake).generate(providerRequest(Answer));
    expect(result.value).toEqual(VALID_ANSWER);
    expect(fake.inputs[0]?.toolConfig?.toolChoice).toEqual({ tool: { name: SUBMIT_TOOL_NAME } });
    expect(fake.inputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort: 'none' } });
  });

  it('sends other models no OpenAI field', async () => {
    const fake = scripted([() => toolOutput(VALID_ANSWER), () => toolOutput(VALID_ANSWER)]);
    for (const modelId of [
      'us.amazon.nova-2-lite-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ] as const) {
      const other = provider(fake, { modelId, reasoningEffort: 'low' });
      expect(other.openAiFields).toBeNull();
      await other.generate(providerRequest(Answer));
    }
    for (const input of fake.inputs) expect(input).not.toHaveProperty('additionalModelRequestFields');
    expect(fake.inputs.map((i) => i.inferenceConfig)).toEqual([
      { maxTokens: 512, temperature: 0.2 },
      { maxTokens: 512 },
    ]);
  });
});

describe('GPT-6 Luna on Converse: a refused request field', () => {
  it('is dropped for one retry and not sent again by this instance', async () => {
    const fake = scripted(
      [() => toolOutput(VALID_ANSWER)],
      [refuse(TEMPERATURE_REFUSED), () => events([textDelta('A.'), ...END])],
    );
    const luna = provider(fake);
    const first = await luna.streamText(streamRequest(() => undefined, { temperature: 0 }));
    expect(first.rawAttempts.map((a) => [a.kind, a.outcome, a.errorName, a.issues])).toEqual([
      ['initial', 'client_error', 'ValidationException', undefined],
      ['field_retry', 'ok', null, ['dropped:temperature']],
    ]);
    expect(fake.streamInputs[1]?.inferenceConfig).toEqual({ maxTokens: 400 });
    // The effort Bedrock took is kept, on every later call (structured ones too).
    const second = await luna.generate(providerRequest(Answer));
    expect(second.rawAttempts.map((a) => a.kind)).toEqual(['initial']);
    expect(fake.inputs[0]?.inferenceConfig).toEqual({ maxTokens: 512 });
    expect(fake.inputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort: 'none' } });
  });

  it('falls back from effort none to low, then leaves the effort out, and from a forced tool to auto', async () => {
    const fake = scripted([
      refuse(EFFORT_REFUSED),
      refuse('Unsupported parameter: reasoning.effort'),
      refuse(TOOL_CHOICE_REFUSED),
      () => toolOutput(VALID_ANSWER),
      () => toolOutput(VALID_ANSWER),
    ]);
    const luna = provider(fake);
    const result = await luna.generate(providerRequest(Answer));
    expect(result.value).toEqual(VALID_ANSWER);
    expect(fake.inputs.map((i) => [i.additionalModelRequestFields, i.toolConfig?.toolChoice])).toEqual([
      [{ reasoning: { effort: 'none' } }, { tool: { name: SUBMIT_TOOL_NAME } }],
      [{ reasoning: { effort: 'low' } }, { tool: { name: SUBMIT_TOOL_NAME } }],
      [undefined, { tool: { name: SUBMIT_TOOL_NAME } }],
      [undefined, { auto: {} }],
    ]);
    expect(result.rawAttempts.at(-1)?.issues).toEqual([
      'reasoning_effort:low',
      'dropped:reasoning_effort',
      'dropped:tool_choice',
    ]);
    await luna.generate(providerRequest(Answer));
    expect(fake.inputs.at(-1)?.toolConfig?.toolChoice).toEqual({ auto: {} });
    expect(luna.openAiFields).toEqual({ temperature: true, effort: null, forcedTool: false });
  });

  it('reads a reply written as text once tool choice is auto', async () => {
    const fake = scripted([
      refuse(TOOL_CHOICE_REFUSED),
      () => ({
        ...toolOutput(null),
        output: {
          message: {
            role: 'assistant',
            content: [{ text: `Here it is:\n\`\`\`json\n${JSON.stringify(VALID_ANSWER)}\n\`\`\`` }],
          },
        },
        stopReason: 'end_turn',
      }),
    ]);
    const result = await provider(fake).generate(providerRequest(Answer));
    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.rawAttempts.at(-1)?.issues).toEqual(['dropped:tool_choice', 'text_output:(root)']);
  });

  it('remembers nothing when the retry fails too, and never retries an unrelated refusal', async () => {
    const fake = scripted(
      [refuse(TEMPERATURE_REFUSED), refuse('Input is too long for requested model.')],
      [refuse('Malformed input request: schema too deep')],
    );
    const luna = provider(fake);
    const failed = (await captureError(luna.generate(providerRequest(Answer)))) as ModelUnavailableError;
    expect(failed).toBeInstanceOf(ModelUnavailableError);
    expect(failed.rawAttempts.map((a) => a.kind)).toEqual(['initial', 'field_retry']);
    expect(luna.openAiFields).toEqual({ temperature: true, effort: 'none', forcedTool: true });
    await captureError(luna.streamText(streamRequest(() => undefined)));
    expect(fake.streamInputs).toHaveLength(1);
  });

  it('never retries AccessDenied (the router then falls back)', async () => {
    const fake = scripted([
      () => {
        throw awsError('AccessDeniedException', 'temperature reasoning tool_choice', 403);
      },
    ]);
    const error = (await captureError(
      provider(fake).generate(providerRequest(Answer)),
    )) as ModelUnavailableError;
    expect(error.reason).toBe('client_error');
    expect(fake.inputs).toHaveLength(1);
  });

  it.each<[Partial<OpenAiRequestFields>, string, Partial<OpenAiRequestFields> | null]>([
    [{}, 'temperature is only supported when reasoning effort is none', { temperature: false }],
    [{}, "Unknown parameter: 'foo'", { temperature: false, effort: null }],
    [{ temperature: false, effort: null }, "Unknown parameter: 'foo'", null],
    [{ effort: 'medium' }, 'temperature is out of range', null],
    [{ effort: 'medium' }, 'reasoning.effort must be one of low', { effort: null }],
    [{}, 'The provided model identifier is invalid.', null],
    [{}, 'Expected toolResult blocks', null],
  ])('%o refused with "%s" retries with %o', (from, message, to) => {
    const base: OpenAiRequestFields = { temperature: true, effort: 'none', forcedTool: true, ...from };
    expect(withoutRefusedField(base, message)).toEqual(to === null ? null : { ...base, ...to });
  });
});

describe('GPT-6 Luna through the gateway', () => {
  const config = (fake: ReturnType<typeof scripted>) =>
    ({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: LUNA,
      fallbackModelId: 'us.amazon.nova-2-lite-v1:0',
      embeddingsModelId: 'amazon.titan-embed-text-v2:0',
      transports: {
        converse: fake.converse,
        converseStream: fake.converseStream,
        invokeModel: () => Promise.reject(new Error('unused')),
      },
    }) as const;

  it('coaches at temperature 0 and keeps 0.2 for every other purpose', async () => {
    const fake = scripted(
      [() => toolOutput(VALID_ANSWER), () => toolOutput(VALID_ANSWER)],
      [() => events([textDelta('Yes.'), ...END])],
    );
    const gateway = createModelGateway(config(fake));
    const request = {
      system: 'S',
      messages: [{ role: 'user' as const, content: 'U' }],
      requestId: 'r',
    };
    const streamed = await gateway.streamText({ ...request, purpose: 'turn' }, () => undefined);
    for (const purpose of ['test_bench', 'distill'] as const) {
      await gateway.generateStructured({ ...request, purpose, schemaName: 'Answer', zodSchema: Answer });
    }
    expect(fake.streamInputs[0]?.inferenceConfig?.temperature).toBe(0);
    expect(fake.inputs.map((i) => i.inferenceConfig?.temperature)).toEqual([0, 0.2]);
    // 1,000 plain, 4,000 read and 1,000 written input tokens and 40 output at the US profile's rates:
    // 110 + 44 + 137.5 + 22 micro-dollars, rounded up.
    expect(streamed.costUsd).toBe(0.000314);
  });

  it('falls back to Nova when the account has no access', async () => {
    const fake = scripted([
      () => {
        throw awsError('AccessDeniedException', 'no access', 403);
      },
      () => toolOutput(VALID_ANSWER),
    ]);
    const result = await createModelGateway(config(fake)).generateStructured({
      purpose: 'turn',
      system: 'S',
      messages: [{ role: 'user', content: 'U' }],
      requestId: 'r',
      schemaName: 'Answer',
      zodSchema: Answer,
    });
    expect([result.modelId, result.fallbackUsed]).toEqual(['us.amazon.nova-2-lite-v1:0', true]);
  });

  it('takes the effort and the coaching temperature from the environment, and refuses others', () => {
    const base = { MODEL_PROVIDER: 'bedrock', BEDROCK_REGION: 'us-east-1' };
    expect(modelGatewayConfigFromEnv(base)).not.toHaveProperty('reasoningEffort');
    expect(
      modelGatewayConfigFromEnv({ ...base, MODEL_REASONING_EFFORT: '', MODEL_COACH_TEMPERATURE: '' }),
    ).not.toHaveProperty('coachTemperature');
    expect(
      modelGatewayConfigFromEnv({ ...base, MODEL_REASONING_EFFORT: 'low', MODEL_COACH_TEMPERATURE: '0.2' }),
    ).toMatchObject({ reasoningEffort: 'low', coachTemperature: 0.2 });
    for (const bad of [
      { MODEL_REASONING_EFFORT: 'minimal' },
      { MODEL_COACH_TEMPERATURE: '2' },
      { MODEL_COACH_TEMPERATURE: 'hot' },
    ]) {
      expect(() => modelGatewayConfigFromEnv({ ...base, ...bad })).toThrow(
        /Invalid model gateway environment/,
      );
    }
  });

  it('prices both profiles and the bare id', () => {
    const usage = { inputTokens: 1e6, outputTokens: 1e6 };
    expect(costFor('global.openai.gpt-6-luna', usage)).toBeCloseTo(0.6, 9);
    expect(costFor('us.openai.gpt-6-luna', usage)).toBeCloseTo(0.66, 9);
    expect(costFor('openai.gpt-6-luna', usage)).toBeCloseTo(0.66, 9);
    const cached = {
      inputTokens: 2e6,
      outputTokens: 0,
      cacheReadInputTokens: 1e6,
      cacheWriteInputTokens: 1e6,
    };
    expect(costFor('us.openai.gpt-6-luna', cached)).toBeCloseTo(0.011 + 0.1375, 9);
  });
});

describe('the open-weight lab candidates (gpt-oss, Qwen, DeepSeek, Mistral)', () => {
  const OSS = 'openai.gpt-oss-120b-1:0';

  it('gpt-oss runs on Converse under its runtime id; the id without a version is Mantle’s', () => {
    expect([OSS, 'openai.gpt-oss-20b-1:0'].map(reasoningAdapterFor)).toEqual(['converse', 'converse']);
    expect(['openai.gpt-oss-120b', 'openai.gpt-6-luna'].map(reasoningAdapterFor)).toEqual([
      'mantle',
      'mantle',
    ]);
    expect(
      [OSS, LUNA, 'openai.gpt-oss-120b', 'openai.gpt-oss-safeguard-20b-1:0'].map(isGptOssModelId),
    ).toEqual([true, false, false, false]);
  });

  it('gpt-oss always reasons: the flat field at low by default, a temperature, room for the reasoning, no checkpoints', async () => {
    const fake = scripted(
      [],
      [() => events([textDelta('Hi.'), ...END]), () => events([textDelta('Hi.'), ...END])],
    );
    await provider(fake, { modelId: OSS }).streamText(streamRequest(() => undefined, { temperature: 0 }));
    expect(fake.streamInputs[0]).toMatchObject({
      modelId: OSS,
      system: [{ text: 'SYSTEM' }],
      inferenceConfig: { maxTokens: 400 + OSS_REASONING_MAX_TOKENS, temperature: 0 },
      additionalModelRequestFields: { reasoning_effort: 'low' },
    });
    await provider(fake, { modelId: OSS, reasoningEffort: 'high' }).streamText(
      streamRequest(() => undefined),
    );
    expect(fake.streamInputs[1]?.additionalModelRequestFields).toEqual({ reasoning_effort: 'high' });
  });

  it('a candidate that takes tools and no forced one is asked in words, once and for all', async () => {
    for (const modelId of [
      'qwen.qwen3-next-80b-a3b',
      'deepseek.v3.2',
      'mistral.mistral-large-3-675b-instruct',
    ]) {
      const fake = scripted([
        refuse("This model doesn't support the toolConfig.toolChoice.tool field."),
        () => toolOutput(VALID_ANSWER),
        () => toolOutput(VALID_ANSWER),
      ]);
      const candidate = provider(fake, { modelId });
      const result = await candidate.generate(providerRequest(Answer));
      expect(result.rawAttempts.map((a) => [a.kind, a.outcome, a.issues ?? []])).toEqual([
        ['initial', 'client_error', []],
        ['field_retry', 'ok', ['dropped:tool_choice']],
      ]);
      await candidate.generate(providerRequest(Answer));
      expect(fake.inputs.map((i) => i.toolConfig?.toolChoice)).toEqual([
        { tool: { name: SUBMIT_TOOL_NAME } },
        { auto: {} },
        { auto: {} },
      ]);
      expect(fake.inputs[0]).not.toHaveProperty('additionalModelRequestFields');
    }
  });

  it('are priced, and never at an unknown model’s rate', () => {
    for (const [id, usd] of [
      [OSS, 0.75],
      ['openai.gpt-oss-20b-1:0', 0.37],
      ['qwen.qwen3-next-80b-a3b', 1.35],
      ['deepseek.v3.2', 2.47],
      ['mistral.mistral-large-3-675b-instruct', 2],
    ] as const)
      expect(costFor(id, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(usd, 9);
  });
});
