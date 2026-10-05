import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';

import type { ConverseFn } from './bedrock-runtime.js';
import { ModelOutputInvalidError, ModelRefusalError, ModelUnavailableError } from './errors.js';
import { NovaProvider, SUBMIT_TOOL_NAME, inferenceProfilePrefix, toConverseMessages } from './nova.js';
import { Answer, VALID_ANSWER, awsError, providerRequest } from './test-helpers.js';

type Step = (input: ConverseCommandInput) => ConverseCommandOutput | Promise<ConverseCommandOutput>;

function scriptedConverse(steps: Step[]): { converse: ConverseFn; inputs: ConverseCommandInput[] } {
  const inputs: ConverseCommandInput[] = [];
  const converse: ConverseFn = async (input) => {
    inputs.push(structuredClone(input));
    const step = steps.shift();
    if (!step) throw new Error('unexpected converse call');
    return step(input);
  };
  return { converse, inputs };
}

function toolOutput(
  input: unknown,
  stopReason: ConverseCommandOutput['stopReason'] = 'tool_use',
): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'tooluse-1', name: SUBMIT_TOOL_NAME, input: input as never } }],
      },
    },
    stopReason,
    usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
    metrics: { latencyMs: 10 },
  };
}

function textOutput(
  text: string,
  stopReason: ConverseCommandOutput['stopReason'] = 'end_turn',
): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason,
    usage: { inputTokens: 800, outputTokens: 30, totalTokens: 830 },
    metrics: { latencyMs: 10 },
  };
}

const PROFILE_ERROR = awsError(
  'ValidationException',
  "Invocation of model ID amazon.nova-2-lite-v1:0 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.",
);

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('NovaProvider', () => {
  it('forces the submit_response tool with the strict schema and validates the tool input', async () => {
    const { converse, inputs } = scriptedConverse([() => toolOutput(VALID_ANSWER)]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });
    const request = providerRequest(Answer);
    const result = await provider.generate(request);

    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.modelId).toBe('amazon.nova-2-lite-v1:0');
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({
        provider: 'nova',
        kind: 'initial',
        outcome: 'ok',
        usage: { inputTokens: 800, outputTokens: 120 },
      }),
    ]);
    const input = inputs[0];
    expect(input?.modelId).toBe('amazon.nova-2-lite-v1:0');
    expect(input?.system).toEqual([{ text: 'SYSTEM PROMPT SECRET' }]);
    expect(input?.messages).toEqual([{ role: 'user', content: [{ text: 'FOUNDER TEXT SECRET' }] }]);
    expect(input?.inferenceConfig).toEqual({ maxTokens: 512, temperature: 0.2 });
    expect(input?.toolConfig?.toolChoice).toEqual({ tool: { name: SUBMIT_TOOL_NAME } });
    expect(input?.toolConfig?.tools).toHaveLength(1);
    expect(input?.toolConfig?.tools?.[0]?.toolSpec?.name).toBe(SUBMIT_TOOL_NAME);
    expect(input?.toolConfig?.tools?.[0]?.toolSpec?.inputSchema).toEqual({ json: request.strict.schema });
  });

  it('retries once with the "us." inference profile and caches that choice', async () => {
    const { converse, inputs } = scriptedConverse([
      () => {
        throw PROFILE_ERROR;
      },
      () => toolOutput(VALID_ANSWER),
      () => toolOutput(VALID_ANSWER),
    ]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });

    const first = await provider.generate(providerRequest(Answer));
    expect(first.modelId).toBe('us.amazon.nova-2-lite-v1:0');
    expect(first.rawAttempts.map((a) => [a.modelId, a.kind, a.outcome, a.errorName])).toEqual([
      ['amazon.nova-2-lite-v1:0', 'initial', 'client_error', 'ValidationException'],
      ['us.amazon.nova-2-lite-v1:0', 'profile_retry', 'ok', null],
    ]);
    expect(provider.effectiveModelId).toBe('us.amazon.nova-2-lite-v1:0');

    const second = await provider.generate(providerRequest(Answer));
    expect(second.rawAttempts).toHaveLength(1);
    expect(inputs.map((i) => i.modelId)).toEqual([
      'amazon.nova-2-lite-v1:0',
      'us.amazon.nova-2-lite-v1:0',
      'us.amazon.nova-2-lite-v1:0',
    ]);
  });

  it('does not retry other validation errors', async () => {
    const { converse, inputs } = scriptedConverse([
      () => {
        throw awsError('ValidationException', 'Malformed input request: schema too deep');
      },
    ]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });
    const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelUnavailableError;
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error.reason).toBe('client_error');
    expect(inputs).toHaveLength(1);
  });

  it('does not add a profile prefix to ids that already have one', async () => {
    const { converse } = scriptedConverse([
      () => {
        throw PROFILE_ERROR;
      },
    ]);
    const provider = new NovaProvider({
      modelId: 'us.amazon.nova-2-lite-v1:0',
      region: 'us-east-1',
      converse,
    });
    const error = await captureError(provider.generate(providerRequest(Answer)));
    expect(error).toBeInstanceOf(ModelUnavailableError);
  });

  it('repairs invalid tool input through a toolResult error', async () => {
    const { converse, inputs } = scriptedConverse([
      () => toolOutput({ answer: 'x', score: 9, tags: [], note: null }),
      () => toolOutput(VALID_ANSWER),
    ]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });
    const result = await provider.generate(providerRequest(Answer));
    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.rawAttempts.map((a) => [a.kind, a.outcome])).toEqual([
      ['initial', 'invalid_output'],
      ['repair', 'ok'],
    ]);
    const repair = inputs[1]?.messages ?? [];
    expect(repair).toHaveLength(3);
    expect(repair[1]?.role).toBe('assistant');
    expect(repair[2]?.content?.[0]?.toolResult?.status).toBe('error');
    expect(repair[2]?.content?.[0]?.toolResult?.toolUseId).toBe('tooluse-1');
  });

  it('throws ModelOutputInvalidError when the model never calls the tool', async () => {
    const { converse, inputs } = scriptedConverse([
      () => textOutput('Here you go'),
      () => textOutput('Still text'),
    ]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });
    const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelOutputInvalidError;
    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect(error.issues).toEqual(['(root): no_tool_use:end_turn']);
    expect(error.rawAttempts).toHaveLength(2);
    // The repair appends the instruction to the last user turn (no tool use to answer).
    expect(inputs[1]?.messages).toHaveLength(1);
    expect(inputs[1]?.messages?.[0]?.content).toHaveLength(2);
  });

  it('maps content filtering to ModelRefusalError', async () => {
    const { converse } = scriptedConverse([() => textOutput('', 'content_filtered')]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });
    const error = await captureError(provider.generate(providerRequest(Answer)));
    expect(error).toBeInstanceOf(ModelRefusalError);
  });

  it.each([
    ['ThrottlingException', 429, 'throttled'],
    ['ServiceUnavailableException', 503, 'server_error'],
    ['InternalServerException', 500, 'server_error'],
    ['ModelTimeoutException', 408, 'timeout'],
    ['AccessDeniedException', 403, 'client_error'],
  ] as const)('maps %s to %s', async (name, status, reason) => {
    const { converse } = scriptedConverse([
      () => {
        throw awsError(name, 'details with FOUNDER TEXT SECRET', status);
      },
    ]);
    const provider = new NovaProvider({ modelId: 'amazon.nova-2-lite-v1:0', region: 'us-east-1', converse });
    const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelUnavailableError;
    expect(error.reason).toBe(reason);
    expect(error.errorName).toBe(name);
    expect(error.message).not.toContain('SECRET');
  });
});

describe('toConverseMessages', () => {
  it('merges consecutive roles, drops leading assistant turns and empty messages', () => {
    expect(
      toConverseMessages([
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
      ]),
    ).toEqual([
      { role: 'user', content: [{ text: 'a\n\nb' }] },
      { role: 'assistant', content: [{ text: 'c' }] },
      { role: 'user', content: [{ text: 'd' }] },
    ]);
  });

  it('requires the conversation to end with a user message', () => {
    expect(() =>
      toConverseMessages([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]),
    ).toThrow(TypeError);
    expect(() => toConverseMessages([])).toThrow(TypeError);
  });
});

describe('inferenceProfilePrefix', () => {
  it.each([
    ['us-east-1', 'us.'],
    ['us-west-2', 'us.'],
    ['eu-west-1', 'eu.'],
    ['ap-southeast-2', 'apac.'],
    ['us-gov-west-1', 'us-gov.'],
  ])('%s → %s', (region, prefix) => {
    expect(inferenceProfilePrefix(region)).toBe(prefix);
  });
});
