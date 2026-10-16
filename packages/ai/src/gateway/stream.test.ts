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
  hangUntilAborted,
  jsonResponse,
  providerRequest,
  scriptedFetch,
  type FetchStep,
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

/** Rejects like the SDKs do once `signal` aborts (a request or a stream the provider is still working on). */
function untilAborted<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const fail = (): void => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/** The prompt of `streamRequest` as the estimate counts it (about 4 characters a token). */
const PROMPT_TOKENS =
  Math.ceil('SYSTEM PROMPT SECRET'.length / 4) + Math.ceil('FOUNDER TEXT SECRET'.length / 4);

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

  it('bills the input the stream read from the prompt cache', async () => {
    const { provider } = nova([
      () =>
        events([
          textDelta('Hi.'),
          stop('end_turn'),
          {
            metadata: {
              usage: { inputTokens: 100, outputTokens: 5, totalTokens: 2_105, cacheReadInputTokens: 2_000 },
              metrics: { latencyMs: 20 },
            },
          },
        ]),
    ]);
    const result = await provider.streamText(streamRequest(() => undefined));
    expect(result.rawAttempts[0]?.usage).toEqual({ inputTokens: 2_100, outputTokens: 5 });
    // How much of the prompt the cache served, for the logs.
    expect(result.rawAttempts[0]?.cachedInputTokens).toBe(2_000);
  });

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

  it('bills the prompt of a stream cancelled or timed out before its first text: the provider processed it', async () => {
    // The stream opened, then the caller hung up (a barge-in) before any text.
    const caller = new AbortController();
    const opened = nova([
      () => ({ [Symbol.asyncIterator]: () => ({ next: () => untilAborted(caller.signal) }) }),
    ]);
    const pending = opened.provider.streamText(
      streamRequest(() => undefined, { deadline: new Deadline(5_000, caller.signal) }),
    );
    setTimeout(() => {
      caller.abort();
    }, 5);
    const cancelled = await captureError(pending);
    expect(cancelled).toMatchObject({ reason: 'aborted' });
    if (!(cancelled instanceof ModelUnavailableError)) return;
    // No reasoning on Converse here: the output is the visible text, none.
    expect(cancelled.rawAttempts.map((a) => a.usage)).toEqual([
      { inputTokens: PROMPT_TOKENS, outputTokens: 0 },
    ]);

    // The deadline expired while the request was out, before any response.
    const slow = new NovaProvider({
      modelId: 'amazon.nova-2-lite-v1:0',
      region: 'us-east-1',
      converse: () => Promise.reject(new Error('unused')),
      converseStream: (_input, signal) => untilAborted(signal),
    });
    const timedOut = await captureError(
      slow.streamText(streamRequest(() => undefined, { deadline: new Deadline(20) })),
    );
    expect(timedOut).toMatchObject({ reason: 'timeout' });
    if (!(timedOut instanceof ModelUnavailableError)) return;
    expect(timedOut.rawAttempts.map((a) => a.usage)).toEqual([
      { inputTokens: PROMPT_TOKENS, outputTokens: 0 },
    ]);
  });

  it('bills nothing for a request refused or never received: throttled, a network failure, cancelled before it was sent', async () => {
    const refused = async (
      step: (input: ConverseStreamCommandInput) => AsyncIterable<ConverseStreamOutput>,
      deadline = new Deadline(5_000),
    ) => {
      const { provider } = nova([step]);
      const error = await captureError(provider.streamText(streamRequest(() => undefined, { deadline })));
      expect(error).toBeInstanceOf(ModelUnavailableError);
      return error as ModelUnavailableError;
    };
    const throttled = await refused(() => {
      throw awsError('ThrottlingException', 'Rate exceeded', 429);
    });
    expect(throttled.reason).toBe('throttled');
    expect(throttled.rawAttempts.map((a) => a.usage)).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
    const network = await refused(() => {
      throw new TypeError('fetch failed');
    });
    expect(network.reason).toBe('network');
    expect(network.rawAttempts.map((a) => a.usage)).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
    const neverSent = await refused(
      () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      },
      new Deadline(5_000, AbortSignal.abort()),
    );
    expect(neverSent.reason).toBe('aborted');
    expect(neverSent.rawAttempts.map((a) => a.usage)).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
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

  /** An SSE response that sends `chunks`, then stays open until the request is aborted. */
  const openStream =
    (chunks: readonly unknown[]): FetchStep =>
    (_request, signal) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks)
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(c)}\n\n`));
            const fail = (): void => {
              controller.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            };
            if (signal?.aborted) fail();
            signal?.addEventListener('abort', fail, { once: true });
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
  const lunaWith = (steps: FetchStep[]) =>
    new LunaProvider({
      modelId: 'openai.gpt-6-luna',
      region: 'us-east-1',
      credentials: STATIC_CREDENTIALS,
      fetch: scriptedFetch(steps).fetch,
    });
  /** Runs a stream the caller cancels after `ms`. */
  async function cancelledAfter(provider: LunaProvider, ms: number): Promise<ModelUnavailableError> {
    const caller = new AbortController();
    const pending = provider.streamText(
      streamRequest(() => undefined, { deadline: new Deadline(5_000, caller.signal) }),
    );
    setTimeout(() => {
      caller.abort();
    }, ms);
    const error = await captureError(pending);
    expect(error).toBeInstanceOf(ModelUnavailableError);
    return error as ModelUnavailableError;
  }

  it('bills a stream cancelled before its first text: the prompt, and the reasoning at the output bound', async () => {
    // Luna is still reasoning (nothing visible yet) when the founder speaks over the vEIR.
    const error = await cancelledAfter(lunaWith([openStream([])]), 10);
    expect(error.reason).toBe('aborted');
    expect(error.rawAttempts.map((a) => a.usage)).toEqual([
      { inputTokens: PROMPT_TOKENS, outputTokens: 400 },
    ]);
  });

  it('bills a stream that timed out before any response the same way', async () => {
    const error = await captureError(
      lunaWith([hangUntilAborted]).streamText(streamRequest(() => undefined, { deadline: new Deadline(20) })),
    );
    expect(error).toMatchObject({ reason: 'timeout' });
    if (!(error instanceof ModelUnavailableError)) return;
    expect(error.rawAttempts.map((a) => a.usage)).toEqual([
      { inputTokens: PROMPT_TOKENS, outputTokens: 400 },
    ]);
  });

  it('bills a stream cut off after text at the output bound too, never below the visible text', async () => {
    const error = await cancelledAfter(lunaWith([openStream([chunk('Start small.')])]), 10);
    expect(error.textDelivered).toBe(true);
    expect(error.rawAttempts[0]?.usage).toEqual({ inputTokens: PROMPT_TOKENS, outputTokens: 400 });
    const long = 'word '.repeat(600);
    const longer = await cancelledAfter(lunaWith([openStream([chunk(long)])]), 10);
    expect(longer.rawAttempts[0]?.usage.outputTokens).toBe(Math.ceil(long.length / 4));
    // The SDK ends an aborted stream quietly; the deadline cutting one off is still a timeout, not an answer.
    const timedOut = await captureError(
      lunaWith([openStream([chunk('Start small.')])]).streamText(
        streamRequest(() => undefined, { deadline: new Deadline(20) }),
      ),
    );
    expect(timedOut).toMatchObject({ reason: 'timeout', textDelivered: true });
  });

  it('keeps the usage the stream reported, and bills nothing for a request refused before it opened', async () => {
    const reported = await lunaWith([
      () =>
        sse([
          chunk('Start small.', 'stop'),
          {
            ...chunk(null),
            choices: [],
            usage: { prompt_tokens: 700, completion_tokens: 12, total_tokens: 712 },
          },
        ]),
    ]).streamText(streamRequest(() => undefined));
    expect(reported.rawAttempts[0]?.usage).toEqual({ inputTokens: 700, outputTokens: 12 });
    for (const [step, reason] of [
      [() => jsonResponse({ error: { message: 'slow down', type: 'x' } }, 429), 'throttled'],
      [() => jsonResponse({ error: { message: 'bad', type: 'x' } }, 400), 'client_error'],
      [
        () => {
          throw new TypeError('fetch failed');
        },
        'network',
      ],
    ] as const) {
      const error = await captureError(lunaWith([step]).streamText(streamRequest(() => undefined)));
      expect(error).toMatchObject({ reason });
      if (!(error instanceof ModelUnavailableError)) return;
      expect(error.rawAttempts.map((a) => a.usage)).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
    }
    // Cancelled before it was sent: never reached the provider.
    const neverSent = await captureError(
      lunaWith([hangUntilAborted]).streamText(
        streamRequest(() => undefined, { deadline: new Deadline(5_000, AbortSignal.abort()) }),
      ),
    );
    expect(neverSent).toMatchObject({ reason: 'aborted' });
    if (!(neverSent instanceof ModelUnavailableError)) return;
    expect(neverSent.rawAttempts.map((a) => a.usage)).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
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

  it('prices a stream cancelled or timed out before any text once per network call, never falling back on a cancel', async () => {
    const lunaStreaming = (step: FetchStep) =>
      new LunaProvider({
        modelId: DEFAULT_MODEL_IDS.primary,
        region: 'us-east-1',
        credentials: STATIC_CREDENTIALS,
        fetch: scriptedFetch([step]).fetch,
      });
    const withPrimary = (primary: StructuredProvider, fallback: Behaviour) => {
      const f = new FakeStreamer(FALLBACK, fallback);
      const gateway = createModelGateway({
        provider: 'bedrock',
        region: 'us-east-1',
        primaryModelId: DEFAULT_MODEL_IDS.primary,
        fallbackModelId: FALLBACK,
        embeddingsModelId: DEFAULT_MODEL_IDS.embeddings,
        credentials: STATIC_CREDENTIALS,
        providers: { primary, fallback: f },
        transports: { invokeModel: () => Promise.reject(new Error('unused')) },
      });
      return { gateway, f };
    };

    // The caller cancels while Luna is still reasoning: one billed attempt, no fallback.
    const caller = new AbortController();
    const cancelled = withPrimary(lunaStreaming(hangUntilAborted), ok(FALLBACK, ['Other.']));
    const pending = cancelled.gateway.streamText(
      { ...request, maxOutputTokens: 400, signal: caller.signal },
      () => undefined,
    );
    setTimeout(() => {
      caller.abort();
    }, 5);
    const error = await captureError(pending);
    expect(error).toMatchObject({ reason: 'aborted' });
    if (!isModelGatewayError(error)) return;
    expect(cancelled.f.calls).toBe(0);
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({
      outcome: 'aborted',
      usage: { inputTokens: 2, outputTokens: 400 },
    });
    expect(error.attempts[0]?.costUsd).toBeGreaterThan(0);

    // The primary times out before any text: it is billed once, and the fallback's own attempt once.
    const slow = withPrimary(lunaStreaming(hangUntilAborted), ok(FALLBACK, ['From the fallback.']));
    const result = await slow.gateway.streamText(
      { ...request, maxOutputTokens: 400, timeoutMs: 20 },
      () => undefined,
    );
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.map((a) => [a.modelId, a.outcome])).toEqual([
      [DEFAULT_MODEL_IDS.primary, 'timeout'],
      [FALLBACK, 'ok'],
    ]);
    // 'S' and 'U': a token each.
    expect(result.attempts[0]?.usage).toEqual({ inputTokens: 2, outputTokens: 400 });
    expect(result.usage).toEqual({ inputTokens: 2 + 100, outputTokens: 400 + 10 });
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
    // The topic's open fact, never the founder's words quoted back.
    expect(annotations.value.memory_candidates).toHaveLength(1);
    expect(JSON.stringify(annotations.value.memory_candidates)).not.toContain('size the pilot');
  });

  it('follows the scripts: unavailable before text, failure midway after the first sentence', async () => {
    const mock = new MockModelGateway({ streamDelayMs: 0 });
    mock.scriptNext('unavailable');
    const before = await captureError(
      mock.streamText({ purpose: 'turn', system, messages, requestId: 'r' }, () => undefined),
    );
    expect(before).toMatchObject({ reason: 'server_error', textDelivered: false });
    const whole = await mock.streamText(
      { purpose: 'turn', system, messages, requestId: 'r' },
      () => undefined,
    );
    mock.scriptStream('fail_midway');
    const seen: string[] = [];
    const midway = await captureError(
      mock.streamText({ purpose: 'turn', system, messages, requestId: 'r' }, (t) => {
        seen.push(t);
      }),
    );
    expect(midway).toMatchObject({ reason: 'server_error', textDelivered: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(mockStreamChunks(whole.text).length);
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
