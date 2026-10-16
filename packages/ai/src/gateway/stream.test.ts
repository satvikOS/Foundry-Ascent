import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { CoachResponse } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { buildMessages } from '../prompts/messages.js';
import { buildSystemPrompt } from '../prompts/system.js';
import type { ConverseFn, ConverseStreamFn } from './bedrock-runtime.js';
import { COACH_ANNOTATIONS_SCHEMA_NAME, CoachAnnotations } from './coach-annotations.js';
import { Deadline } from './deadline.js';
import { ModelRefusalError, ModelUnavailableError, isModelGatewayError } from './errors.js';
import { LunaProvider } from './luna.js';
import { MOCK_MODEL_ID, MockModelGateway, mockStreamChunks } from './mock.js';
import { NovaProvider, SUBMIT_TOOL_NAME, isClaudeModelId } from './nova.js';
import type { ProviderStreamRequest, ProviderStreamResult, StructuredProvider } from './provider.js';
import { DEFAULT_MODEL_IDS, createModelGateway } from './router.js';
import {
  Answer,
  STATIC_CREDENTIALS,
  VALID_ANSWER,
  awsError,
  providerRequest,
  scriptedFetch,
} from './test-helpers.js';
import type { RawModelAttempt } from './types.js';

function streamRequest(onText: (t: string) => void, overrides: Partial<ProviderStreamRequest> = {}) {
  return {
    system: 'SYSTEM PROMPT SECRET',
    messages: [{ role: 'user' as const, content: 'FOUNDER TEXT SECRET' }],
    maxOutputTokens: 400,
    deadline: new Deadline(5_000),
    requestId: 'req-test',
    onText,
    ...overrides,
  };
}

async function* events(items: readonly ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

const textDelta = (text: string): ConverseStreamOutput => ({
  contentBlockDelta: { contentBlockIndex: 0, delta: { text } },
});
const stop = (stopReason: 'end_turn' | 'max_tokens' | 'content_filtered'): ConverseStreamOutput => ({
  messageStop: { stopReason },
});
const metadata: ConverseStreamOutput = {
  metadata: {
    usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
    metrics: { latencyMs: 20 },
  },
};

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('NovaProvider.streamText (ConverseStream)', () => {
  function nova(steps: ((input: ConverseStreamCommandInput) => AsyncIterable<ConverseStreamOutput>)[]) {
    const inputs: ConverseStreamCommandInput[] = [];
    const converseStream: ConverseStreamFn = (input) => {
      inputs.push(structuredClone(input));
      const step = steps.shift();
      if (!step) return Promise.reject(new Error('unexpected converseStream call'));
      return Promise.resolve(step(input));
    };
    const converse: ConverseFn = () => Promise.reject(new Error('unused'));
    const provider = new NovaProvider({
      modelId: 'amazon.nova-2-lite-v1:0',
      region: 'us-east-1',
      converse,
      converseStream,
    });
    return { provider, inputs };
  }

  it('delivers text deltas in order and reports the usage of the stream', async () => {
    const { provider, inputs } = nova([
      () =>
        events([
          { messageStart: { role: 'assistant' } },
          textDelta('Start with '),
          textDelta('five users.'),
          stop('end_turn'),
          metadata,
        ]),
    ]);
    const chunks: string[] = [];
    const result = await provider.streamText(streamRequest((t) => chunks.push(t)));
    expect(chunks).toEqual(['Start with ', 'five users.']);
    expect(result).toMatchObject({ text: 'Start with five users.', stopReason: 'end_turn' });
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({
        provider: 'nova',
        outcome: 'ok',
        usage: { inputTokens: 900, outputTokens: 40 },
      }),
    ]);
    expect(inputs[0]).toMatchObject({
      modelId: 'amazon.nova-2-lite-v1:0',
      system: [{ text: 'SYSTEM PROMPT SECRET' }],
      inferenceConfig: { maxTokens: 400, temperature: 0.2 },
    });
    expect(inputs[0]).not.toHaveProperty('toolConfig');
  });

  it('marks a failure after text as delivered, estimates its usage and never retries', async () => {
    const { provider } = nova([
      () =>
        events([
          textDelta('Start with five users. '),
          { modelStreamErrorException: { message: 'boom' } } as unknown as ConverseStreamOutput,
        ]),
    ]);
    const error = await captureError(provider.streamText(streamRequest(() => undefined)));
    expect(error).toBeInstanceOf(ModelUnavailableError);
    if (!(error instanceof ModelUnavailableError)) return;
    expect(error.reason).toBe('server_error');
    expect(error.textDelivered).toBe(true);
    expect(error.rawAttempts).toHaveLength(1);
    expect(error.rawAttempts[0]?.usage.outputTokens).toBeGreaterThan(0);
    expect(error.message).not.toContain('boom');
  });

  it('retries once with the inference profile when the base id needs one, before any text', async () => {
    const profileError = awsError(
      'ValidationException',
      'on-demand throughput is not supported; use an inference profile',
    );
    const { provider, inputs } = nova([
      () => {
        throw profileError;
      },
      () => events([textDelta('Hello.'), stop('end_turn'), metadata]),
    ]);
    const result = await provider.streamText(streamRequest(() => undefined));
    expect(result.modelId).toBe('us.amazon.nova-2-lite-v1:0');
    expect(inputs.map((i) => i.modelId)).toEqual(['amazon.nova-2-lite-v1:0', 'us.amazon.nova-2-lite-v1:0']);
    expect(result.rawAttempts.map((a) => a.kind)).toEqual(['initial', 'profile_retry']);
  });

  it('turns a content filter into a refusal', async () => {
    const { provider } = nova([() => events([textDelta('Partial'), stop('content_filtered'), metadata])]);
    const error = await captureError(provider.streamText(streamRequest(() => undefined)));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).textDelivered).toBe(true);
  });

  it('cancels when the deadline is aborted mid-stream', async () => {
    const deadline = new Deadline(5_000, AbortSignal.abort());
    const aborted: AsyncIterable<ConverseStreamOutput> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      }),
    };
    const { provider } = nova([() => aborted]);
    const error = await captureError(provider.streamText(streamRequest(() => undefined, { deadline })));
    expect(error).toMatchObject({ reason: 'aborted' });
  });
});

describe('Claude on Converse', () => {
  it('recognises Claude ids, bare or behind an inference profile', () => {
    expect(isClaudeModelId('anthropic.claude-opus-5-5')).toBe(true);
    expect(isClaudeModelId('us.anthropic.claude-sonnet-5-5')).toBe(true);
    expect(isClaudeModelId('global.anthropic.claude-haiku-5-5')).toBe(true);
    expect(isClaudeModelId('us.amazon.nova-2-lite-v1:0')).toBe(false);
  });

  it('sends no sampling parameters and asks for the tool instead of forcing it', async () => {
    const inputs: ConverseCommandInput[] = [];
    const converse: ConverseFn = (input) => {
      inputs.push(structuredClone(input));
      const output: ConverseCommandOutput = {
        $metadata: {},
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 't1', name: SUBMIT_TOOL_NAME, input: { ...VALID_ANSWER } } }],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        metrics: { latencyMs: 1 },
      };
      return Promise.resolve(output);
    };
    const streamInputs: ConverseStreamCommandInput[] = [];
    const converseStream: ConverseStreamFn = (input) => {
      streamInputs.push(structuredClone(input));
      return Promise.resolve(events([textDelta('Hi.'), stop('end_turn'), metadata]));
    };
    const provider = new NovaProvider({
      modelId: 'us.anthropic.claude-sonnet-5-5',
      region: 'us-east-1',
      converse,
      converseStream,
    });
    await provider.generate(providerRequest(Answer));
    await provider.streamText(streamRequest(() => undefined));
    expect(inputs[0]?.inferenceConfig).toEqual({ maxTokens: 512 });
    expect(inputs[0]?.toolConfig?.toolChoice).toEqual({ auto: {} });
    expect(streamInputs[0]?.inferenceConfig).toEqual({ maxTokens: 400 });
  });
});

describe('LunaProvider.streamText (Chat Completions stream)', () => {
  const sse = (chunks: readonly unknown[]): Response =>
    new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const chunk = (content: string | null, finish: string | null = null, usage?: unknown) => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'openai.gpt-6-luna',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  it('streams content deltas with usage from the last chunk', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        sse([
          chunk('Start '),
          chunk('small.'),
          chunk(null, 'stop'),
          {
            ...chunk(null),
            choices: [],
            usage: { prompt_tokens: 700, completion_tokens: 12, total_tokens: 712 },
          },
        ]),
    ]);
    const provider = new LunaProvider({
      modelId: 'openai.gpt-6-luna',
      region: 'us-east-1',
      credentials: STATIC_CREDENTIALS,
      fetch,
    });
    const chunks: string[] = [];
    const result = await provider.streamText(streamRequest((t) => chunks.push(t)));
    expect(chunks).toEqual(['Start ', 'small.']);
    expect(result).toMatchObject({
      text: 'Start small.',
      stopReason: 'end_turn',
      modelId: 'openai.gpt-6-luna',
    });
    expect(result.rawAttempts[0]).toMatchObject({
      outcome: 'ok',
      usage: { inputTokens: 700, outputTokens: 12 },
    });
    expect(requests[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('turns a refusal delta into a refusal error', async () => {
    const { fetch } = scriptedFetch([
      () =>
        sse([
          { ...chunk(null), choices: [{ index: 0, delta: { refusal: 'No.' }, finish_reason: null }] },
          chunk(null, 'stop'),
        ]),
    ]);
    const provider = new LunaProvider({
      modelId: 'openai.gpt-6-luna',
      region: 'us-east-1',
      credentials: STATIC_CREDENTIALS,
      fetch,
    });
    const error = await captureError(provider.streamText(streamRequest(() => undefined)));
    expect(error).toBeInstanceOf(ModelRefusalError);
  });
});

describe('gateway streamText (router)', () => {
  type Behaviour = (request: ProviderStreamRequest) => Promise<ProviderStreamResult>;
  const attempt = (modelId: string, outcome: RawModelAttempt['outcome']): RawModelAttempt => ({
    provider: 'nova',
    modelId,
    kind: 'initial',
    outcome,
    latencyMs: 3,
    usage: { inputTokens: 100, outputTokens: 10 },
    errorName: null,
  });
  class FakeStreamer implements StructuredProvider {
    readonly name = 'nova' as const;
    calls = 0;
    constructor(
      readonly modelId: string,
      private readonly behaviour: Behaviour | null,
    ) {}
    generate(): never {
      throw new Error('unused');
    }
    get streamText(): ((request: ProviderStreamRequest) => Promise<ProviderStreamResult>) | undefined {
      const behaviour = this.behaviour;
      if (behaviour === null) return undefined;
      return (request) => {
        this.calls += 1;
        return behaviour(request);
      };
    }
  }
  const PRIMARY = DEFAULT_MODEL_IDS.fallback;
  const FALLBACK = 'global.amazon.nova-2-lite-v1:0';
  const ok =
    (modelId: string, chunks: readonly string[]): Behaviour =>
    async (request) => {
      for (const c of chunks) await request.onText(c);
      return {
        text: chunks.join(''),
        modelId,
        stopReason: 'end_turn',
        rawAttempts: [attempt(modelId, 'ok')],
      };
    };
  const failAfter =
    (modelId: string, chunks: readonly string[]): Behaviour =>
    async (request) => {
      for (const c of chunks) await request.onText(c);
      const error = new ModelUnavailableError('server_error', modelId);
      error.rawAttempts = [attempt(modelId, 'server_error')];
      error.textDelivered = chunks.length > 0;
      throw error;
    };
  function gw(primary: Behaviour | null, fallback: Behaviour | null) {
    const p = new FakeStreamer(PRIMARY, primary);
    const f = new FakeStreamer(FALLBACK, fallback);
    const gateway = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: PRIMARY,
      fallbackModelId: FALLBACK,
      embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
      credentials: STATIC_CREDENTIALS,
      providers: { primary: p, fallback: f },
      transports: { invokeModel: () => Promise.reject(new Error('unused')) },
    });
    return { gateway, p, f };
  }
  const request = {
    purpose: 'turn' as const,
    system: 'S',
    messages: [{ role: 'user' as const, content: 'U' }],
    requestId: 'r',
  };

  it('streams from the primary and reports time to first token and priced attempts', async () => {
    const { gateway } = gw(ok(PRIMARY, ['A. ', 'B.']), null);
    const chunks: string[] = [];
    const result = await gateway.streamText(request, (t) => {
      chunks.push(t);
    });
    expect(chunks).toEqual(['A. ', 'B.']);
    expect(result).toMatchObject({
      text: 'A. B.',
      modelId: PRIMARY,
      fallbackUsed: false,
      stopReason: 'end_turn',
    });
    expect(result.firstTokenMs).toEqual(expect.any(Number));
    expect(result.attempts).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  it('falls back while no text was delivered', async () => {
    const { gateway, f } = gw(failAfter(PRIMARY, []), ok(FALLBACK, ['From the fallback.']));
    const result = await gateway.streamText(request, () => undefined);
    expect(result).toMatchObject({ fallbackUsed: true, modelId: FALLBACK, text: 'From the fallback.' });
    expect(f.calls).toBe(1);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['server_error', 'ok']);
  });

  it('never falls back once text was delivered', async () => {
    const { gateway, f } = gw(failAfter(PRIMARY, ['Shown already. ']), ok(FALLBACK, ['Other.']));
    const error = await captureError(gateway.streamText(request, () => undefined));
    expect(isModelGatewayError(error)).toBe(true);
    if (!isModelGatewayError(error)) return;
    expect(error.textDelivered).toBe(true);
    expect(error.attempts).toHaveLength(1);
    expect(f.calls).toBe(0);
  });

  it('uses the fallback when the primary cannot stream', async () => {
    const { gateway } = gw(null, ok(FALLBACK, ['Fine.']));
    expect((await gateway.streamText(request, () => undefined)).fallbackUsed).toBe(true);
  });
});

describe('MockModelGateway.streamText', () => {
  const system = buildSystemPrompt({
    release: {
      version: 1,
      doctrine: {
        summary: 'Talk to customers before building anything.',
        frameworks: [],
        typicalQuestions: [],
        evidenceStandard: 'Behaviour beats opinions.',
        redLines: [],
        escalationTopics: [],
        referralDestinations: [],
        teachingPrinciples: [],
      },
      style: {
        directness: 'direct',
        warmth: 'warm',
        pace: 'brisk',
        vocabulary: [],
        feedbackStructure: 'Name the gap, then the next step.',
        avoid: [],
      },
      disclosureText: "Corin's vEIR is an AI.",
      personaName: "Corin's vEIR",
    },
    mode: 'coach',
    policy: { riskCategories: [], groundingThreshold: 0.6 },
    ventureContext: { name: 'QuietQuad', stage: 'validation', domain: 'edtech', currentGoal: null },
    continuity: { founderFirstName: 'Maya' },
    today: '2026-10-16',
  });
  const messages = buildMessages([], 'How should we size the pilot?');

  it('streams the coaching answer sentence by sentence, exactly as the structured answer', async () => {
    const mock = new MockModelGateway({ streamDelayMs: 0 });
    const chunks: string[] = [];
    const result = await mock.streamText({ purpose: 'turn', system, messages, requestId: 'r1' }, (t) => {
      chunks.push(t);
    });
    const structured = await mock.generateStructured({
      purpose: 'turn',
      system,
      messages,
      schemaName: 'CoachResponse',
      zodSchema: CoachResponse,
      requestId: 'r2',
    });
    expect(chunks.join('')).toBe(structured.value.answer);
    expect(result.text).toBe(structured.value.answer);
    expect(chunks.length).toBeGreaterThan(2);
    expect(result).toMatchObject({ modelId: MOCK_MODEL_ID, stopReason: 'end_turn' });
    expect(mock.calls.map((c) => c.kind)).toEqual(['stream', 'generate']);
  });

  it('produces annotations for the answer it streamed, without the answer', async () => {
    const mock = new MockModelGateway({ streamDelayMs: 0 });
    const { text } = await mock.streamText(
      { purpose: 'turn', system, messages, requestId: 'r1' },
      () => undefined,
    );
    const annotations = await mock.generateStructured({
      purpose: 'turn',
      system,
      messages: [
        ...messages,
        { role: 'assistant', content: text },
        { role: 'user', content: 'Annotate it.' },
      ],
      schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
      zodSchema: CoachAnnotations,
      requestId: 'r2',
    });
    expect(annotations.value).not.toHaveProperty('answer');
    expect(annotations.value.mode).toBe('coach');
    expect(annotations.value.claims.length).toBeGreaterThan(0);
    expect(JSON.stringify(annotations.value.memory_candidates)).toContain('size the pilot');
  });

  it('follows the scripts: unavailable before text, failure midway after the first sentence', async () => {
    const mock = new MockModelGateway({ streamDelayMs: 0 });
    mock.scriptNext('unavailable');
    const before = await captureError(
      mock.streamText({ purpose: 'turn', system, messages, requestId: 'r' }, () => undefined),
    );
    expect(before).toMatchObject({ reason: 'server_error', textDelivered: false });
    mock.scriptStream('fail_midway');
    const seen: string[] = [];
    const midway = await captureError(
      mock.streamText({ purpose: 'turn', system, messages, requestId: 'r' }, (t) => {
        seen.push(t);
      }),
    );
    expect(midway).toMatchObject({ reason: 'server_error', textDelivered: true });
    expect(seen).toHaveLength(1);
  });

  it('stops when the caller aborts', async () => {
    const mock = new MockModelGateway({ streamDelayMs: 0 });
    const controller = new AbortController();
    const error = await captureError(
      mock.streamText(
        { purpose: 'turn', system, messages, requestId: 'r', signal: controller.signal },
        () => {
          controller.abort();
        },
      ),
    );
    expect(error).toMatchObject({ reason: 'aborted', textDelivered: true });
  });

  it('splits text into sentence chunks that concatenate back to the text', () => {
    const text = 'First one. Second one?\n\n- item one\n- item two\n\nLast "quoted." End';
    const chunks = mockStreamChunks(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toBe('First one. ');
  });
});
