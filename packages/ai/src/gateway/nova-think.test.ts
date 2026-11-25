import type { ConverseStreamCommandInput, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';

import { costFor } from '../pricing.js';
import type { ConverseFn, ConverseStreamFn } from './bedrock-runtime.js';
import { Deadline } from './deadline.js';
import { NovaProvider, THINK_LOW_MAX_TOKENS, thinksOnRequest, type NovaProviderOptions } from './nova.js';
import { createModelGateway } from './router.js';
import { Answer, VALID_ANSWER, awsError, providerRequest } from './test-helpers.js';

const NOVA = 'us.amazon.nova-2-lite-v1:0';
type Step = (input: ConverseStreamCommandInput) => AsyncIterable<ConverseStreamOutput>;

async function* events(items: readonly ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
const USAGE: ConverseStreamOutput = {
  metadata: {
    usage: {
      inputTokens: 500,
      // Reasoning and answer together, as Bedrock bills them.
      outputTokens: 640,
      totalTokens: 5_140,
      cacheReadInputTokens: 3_500,
      cacheWriteInputTokens: 500,
    },
    metrics: { latencyMs: 20 },
  },
};
/** Nova 2's stream with extended thinking: a redacted reasoning block, then the answer's. */
const THOUGHT: ConverseStreamOutput[] = [
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: '[REDACTED]' } } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Not yet: ' } } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'two paid.' } } },
  { messageStop: { stopReason: 'end_turn' } },
  USAGE,
];
const PLAIN: ConverseStreamOutput[] = [
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Not yet.' } } },
  { messageStop: { stopReason: 'end_turn' } },
  USAGE,
];

function scripted(steps: Step[]) {
  const inputs: ConverseStreamCommandInput[] = [];
  const converseStream: ConverseStreamFn = async (input) => {
    inputs.push(structuredClone(input));
    const step = steps.shift();
    if (!step) throw new Error('unexpected converseStream call');
    return Promise.resolve(step(input));
  };
  const converse: ConverseFn = () => Promise.reject(new Error('unexpected converse call'));
  return { converse, converseStream, inputs };
}
function nova(fake: ReturnType<typeof scripted>, options: Partial<NovaProviderOptions> = {}): NovaProvider {
  return new NovaProvider({ modelId: NOVA, region: 'us-east-1', promptCache: true, ...fake, ...options });
}
const refuse = (message: string) => (): never => {
  throw awsError('ValidationException', message);
};
function request(chunks: string[], overrides: object = {}) {
  return {
    system: 'SYSTEM',
    messages: [{ role: 'user' as const, content: 'FOUNDER' }],
    maxOutputTokens: 1_500,
    temperature: 0,
    deadline: new Deadline(5_000),
    requestId: 'req-test',
    promptCache: { systemChars: 6, historyMessages: 0 },
    onText: (t: string) => {
      chunks.push(t);
    },
    ...overrides,
  };
}

describe('Nova 2 extended thinking (StreamTextRequest.think)', () => {
  it('asks for it as Nova 2 documents it, with its own output allowance, the cache checkpoints and the sampling kept', async () => {
    const fake = scripted([() => events(THOUGHT)]);
    const shown: string[] = [];
    const result = await nova(fake).streamText(request(shown, { think: 'low' }));
    expect(fake.inputs[0]).toMatchObject({
      inferenceConfig: { maxTokens: 1_500 + THINK_LOW_MAX_TOKENS, temperature: 0 },
      additionalModelRequestFields: { reasoningConfig: { type: 'enabled', maxReasoningEffort: 'low' } },
      system: [{ text: 'SYSTEM' }, { cachePoint: { type: 'default' } }],
    });
    // The reasoning block reaches nobody; what it cost is metered with the answer.
    expect(shown.join('')).toBe('Not yet: two paid.');
    expect(result.text).toBe('Not yet: two paid.');
    const [attempt] = result.rawAttempts;
    expect(attempt).toMatchObject({ kind: 'initial', outcome: 'ok', cachePoints: 1 });
    expect(attempt?.usage.outputTokens).toBe(640);
    expect(costFor(NOVA, attempt?.usage ?? { inputTokens: 0, outputTokens: 0 })).toBeGreaterThan(
      (640 * 2.75) / 1_000_000,
    );
  });

  it('is off by default: the request is byte for byte what it was', async () => {
    const fake = scripted([() => events(PLAIN)]);
    await nova(fake).streamText(request([]));
    expect(fake.inputs[0]).not.toHaveProperty('additionalModelRequestFields');
    expect(fake.inputs[0]?.inferenceConfig).toEqual({ maxTokens: 1_500, temperature: 0 });
  });

  it('answers without it when Bedrock refuses it, remembers that, and never blames the cache checkpoints', async () => {
    const fake = scripted([
      refuse('Malformed input request: extraneous key [reasoningConfig] is not permitted'),
      () => events(PLAIN),
      () => events(PLAIN),
    ]);
    const provider = nova(fake);
    const result = await provider.streamText(request([], { think: 'low' }));
    expect(result.rawAttempts.map((a) => [a.kind, a.outcome, a.issues ?? []])).toEqual([
      ['initial', 'client_error', []],
      ['field_retry', 'ok', ['dropped:reasoning_config']],
    ]);
    expect(fake.inputs[1]).not.toHaveProperty('additionalModelRequestFields');
    expect(fake.inputs[1]?.inferenceConfig).toEqual({ maxTokens: 1_500, temperature: 0 });
    // The checkpoints stay, on this call and the next; reasoning is not asked for again.
    await provider.streamText(request([], { think: 'low' }));
    for (const input of fake.inputs) expect(input.system).toHaveLength(2);
    expect(fake.inputs[2]).not.toHaveProperty('additionalModelRequestFields');
  });

  it('a request that fails without it too is not remembered as a refusal of it', async () => {
    const fake = scripted([
      refuse('The input is too long.'),
      refuse('The input is too long.'),
      refuse('The input is too long.'),
      () => events(THOUGHT),
    ]);
    const provider = nova(fake);
    await expect(provider.streamText(request([], { think: 'low' }))).rejects.toThrow();
    await provider.streamText(request([], { think: 'low' }));
    expect(fake.inputs.at(-1)).toHaveProperty('additionalModelRequestFields');
  });

  it('meters a stream cut off before it reported its usage at everything it may have reasoned', async () => {
    const abort = new AbortController();
    const fake = scripted([
      async function* () {
        yield THOUGHT[0] ?? USAGE;
        await Promise.resolve();
        abort.abort();
        throw awsError('AbortError', 'aborted');
      },
    ]);
    const error = (await nova(fake)
      .streamText(request([], { think: 'low', deadline: new Deadline(5_000, abort.signal) }))
      .catch((e: unknown) => e)) as { rawAttempts: { usage: { outputTokens: number } }[] };
    expect(error.rawAttempts[0]?.usage.outputTokens).toBe(1_500 + THINK_LOW_MAX_TOKENS);
  });

  it('is ignored by every other model', async () => {
    expect(
      ['us.amazon.nova-2-lite-v1:0', 'amazon.nova-2-lite-v1:0', 'global.amazon.nova-2-lite-v1:0'].every(
        thinksOnRequest,
      ),
    ).toBe(true);
    for (const modelId of [
      'us.amazon.nova-pro-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'qwen.qwen3-next-80b-a3b',
      'amazon.nova-2-multimodal-embeddings-v1:0',
    ]) {
      expect(thinksOnRequest(modelId)).toBe(false);
      const fake = scripted([() => events(PLAIN)]);
      await nova(fake, { modelId }).streamText(request([], { think: 'low' }));
      expect(fake.inputs[0]).not.toHaveProperty('additionalModelRequestFields');
    }
  });

  it('through the gateway: the primary reasons, the model behind it answers at once, structured calls never', async () => {
    const fake = scripted([
      () => {
        throw awsError('ThrottlingException', 'slow down', 429);
      },
      () => events(PLAIN),
    ]);
    const gateway = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: NOVA,
      fallbackModelId: 'global.amazon.nova-2-lite-v1:0',
      embeddingsModelId: 'amazon.titan-embed-text-v2:0',
      transports: {
        ...fake,
        converse: (input) => {
          expect(input).not.toHaveProperty('additionalModelRequestFields');
          return Promise.resolve({
            $metadata: {},
            output: {
              message: {
                role: 'assistant',
                content: [
                  { toolUse: { toolUseId: 't', name: 'submit_response', input: VALID_ANSWER as never } },
                ],
              },
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metrics: { latencyMs: 1 },
          });
        },
        invokeModel: () => Promise.reject(new Error('unused')),
      },
    });
    const result = await gateway.streamText(
      {
        purpose: 'turn',
        system: 'S',
        messages: [{ role: 'user', content: 'F' }],
        requestId: 'r',
        think: 'low',
      },
      () => undefined,
    );
    expect(result.fallbackUsed).toBe(true);
    expect(fake.inputs[0]).toHaveProperty('additionalModelRequestFields.reasoningConfig');
    expect(fake.inputs[1]).not.toHaveProperty('additionalModelRequestFields');
    const { schemaName, zodSchema, system, messages } = providerRequest(Answer);
    await gateway.generateStructured({
      purpose: 'turn',
      system,
      messages,
      schemaName,
      zodSchema,
      requestId: 'r',
    });
  });
});
