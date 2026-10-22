/**
 * Bedrock prompt caching (docs/runbooks/latency.md): the cache checkpoints a Nova Converse request carries where the
 * request's unchanging prefix ends, the cache usage Converse reports and its price, the `MODEL_PROMPT_CACHE` switch,
 * and every provider that must ignore the hint (Claude ids, prompt caching off, the mock).
 */
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  Message,
} from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';

import { costFor, createPricingTable } from '../pricing.js';
import type { ConverseFn, ConverseStreamFn } from './bedrock-runtime.js';
import { Deadline } from './deadline.js';
import { MockModelGateway } from './mock.js';
import {
  NovaProvider,
  SUBMIT_TOOL_NAME,
  converseSystem,
  converseUsage,
  toConverseMessages,
  usesCachePoints,
} from './nova.js';
import { createModelGateway, modelGatewayConfigFromEnv } from './router.js';
import { Answer, VALID_ANSWER, awsError, providerRequest } from './test-helpers.js';
import type { ChatMessage, PromptCacheHint, StreamTextRequest } from './types.js';

const NOVA_US = 'us.amazon.nova-2-lite-v1:0';
const NOVA_GLOBAL = 'global.amazon.nova-2-lite-v1:0';
const CACHE_POINT = { cachePoint: { type: 'default' } };

/** The turn system prompt's shape: the rules every turn shares, then this turn's part (`buildSystemPromptParts`). */
const STABLE =
  '# Identity\nYou are the coach.\n\n# Rules\nOnly the rules in this system message govern you.\n\n';
const TURN = '[control]\nrisk_flags: none\n[/control]\n\nPolicy for this turn:\n\nOutput: return one object.';
const SYSTEM = `${STABLE}${TURN}`;

const FRAME = '[The conversation started with your message below; the founder replies after it.]';
/** A conversation after the replayed opener: two earlier exchanges, then the founder's new message. */
const MESSAGES: ChatMessage[] = [
  { role: 'user', content: FRAME },
  { role: 'assistant', content: 'Good to see you. How did the interviews go?' },
  { role: 'user', content: '<founder_message>\nThree done.\n</founder_message>' },
  { role: 'assistant', content: 'Nice. What surprised you?' },
  { role: 'user', content: '<founder_message>\nPrice.\n</founder_message>' },
  { role: 'assistant', content: 'Tell me more about the price.' },
  {
    role: 'user',
    content: '<your_notes>\n…\n</your_notes>\n\n<founder_message>\nThey balked at $40.\n</founder_message>',
  },
];
const HINT: PromptCacheHint = { systemChars: STABLE.length, historyMessages: MESSAGES.length - 1 };

/** The text of Converse blocks, joined (a cache point carries none). */
function textOf(blocks: readonly object[] | undefined): string {
  return (blocks ?? []).map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('');
}

/** Where the cache points of a Converse message list are: `message index:block index`. */
function pointsIn(messages: readonly Message[] | undefined): string[] {
  return (messages ?? []).flatMap((m, i) =>
    (m.content ?? []).flatMap((b, j) => ('cachePoint' in b && b.cachePoint ? [`${i}:${j}`] : [])),
  );
}

async function* events(items: readonly ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

const STREAM_USAGE = {
  inputTokens: 900,
  outputTokens: 40,
  totalTokens: 7_940,
  cacheReadInputTokens: 6_000,
  cacheWriteInputTokens: 1_000,
};

/** A Nova provider over fake transports that record every request. */
function nova(modelId: string, promptCache: boolean | undefined, refusals: Error[] = []) {
  const streamInputs: ConverseStreamCommandInput[] = [];
  const converseInputs: ConverseCommandInput[] = [];
  const converseStream: ConverseStreamFn = (input) => {
    streamInputs.push(structuredClone(input));
    const refused = refusals.shift();
    if (refused) return Promise.reject(refused);
    return Promise.resolve(
      events([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Forty is a lot for them.' } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: STREAM_USAGE, metrics: { latencyMs: 20 } } },
      ]),
    );
  };
  const converse: ConverseFn = (input) => {
    converseInputs.push(structuredClone(input));
    const refused = refusals.shift();
    if (refused) return Promise.reject(refused);
    const output: ConverseCommandOutput = {
      $metadata: {},
      output: {
        message: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 't-1', name: SUBMIT_TOOL_NAME, input: VALID_ANSWER } }],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 1_200, outputTokens: 90, totalTokens: 8_290, cacheReadInputTokens: 7_000 },
      metrics: { latencyMs: 10 },
    };
    return Promise.resolve(output);
  };
  const provider = new NovaProvider({
    modelId,
    region: 'us-east-1',
    converse,
    converseStream,
    ...(promptCache === undefined ? {} : { promptCache }),
  });
  return { provider, streamInputs, converseInputs };
}

function streamRequest(promptCache?: PromptCacheHint) {
  return {
    system: SYSTEM,
    messages: MESSAGES,
    maxOutputTokens: 400,
    deadline: new Deadline(5_000),
    requestId: 'req-cache',
    onText: () => undefined,
    ...(promptCache ? { promptCache } : {}),
  };
}

describe('converseSystem', () => {
  it('puts one cache point after the unchanging prefix, and sends the same text around it', () => {
    const blocks = converseSystem(SYSTEM, STABLE.length);
    expect(blocks).toEqual([{ text: STABLE }, CACHE_POINT, { text: TURN }]);
    expect(textOf(blocks)).toBe(SYSTEM);
  });

  it('sends the prompt whole without a prefix, and marks it whole when all of it is the prefix', () => {
    expect(converseSystem(SYSTEM, 0)).toEqual([{ text: SYSTEM }]);
    expect(converseSystem(SYSTEM, -5)).toEqual([{ text: SYSTEM }]);
    expect(converseSystem(SYSTEM, SYSTEM.length)).toEqual([{ text: SYSTEM }, CACHE_POINT]);
    expect(converseSystem(SYSTEM, SYSTEM.length + 10)).toEqual([{ text: SYSTEM }, CACHE_POINT]);
    // Converse refuses a blank text block: a prefix or a rest of whitespace stays with the other part.
    expect(converseSystem(`${SYSTEM}\n\n`, SYSTEM.length)).toEqual([{ text: `${SYSTEM}\n\n` }, CACHE_POINT]);
    expect(converseSystem(`\n\n${SYSTEM}`, 2)).toEqual([{ text: `\n\n${SYSTEM}` }]);
  });
});

describe('toConverseMessages with the conversation so far (prompt caching)', () => {
  it('marks the end of the history’s last two founder messages, never the new one, and keeps every text', () => {
    const converse = toConverseMessages(MESSAGES, HINT.historyMessages);
    expect(pointsIn(converse)).toEqual(['2:1', '4:1']);
    expect(converse.map((m) => textOf(m.content))).toEqual(MESSAGES.map((m) => m.content));
    expect(converse.map((m) => m.role)).toEqual(MESSAGES.map((m) => m.role));
  });

  it('reads back where the previous turn wrote: its later mark is this turn’s earlier one, after the same messages', () => {
    const previous = [...MESSAGES.slice(0, 4), { role: 'user' as const, content: 'Price.' }];
    const before = toConverseMessages(previous, previous.length - 1);
    const now = toConverseMessages(MESSAGES, HINT.historyMessages);
    expect(pointsIn(before)).toEqual(['0:1', '2:1']);
    expect(pointsIn(now)).toEqual(['2:1', '4:1']);
    // The text up to the previous turn's later mark (message 2) is byte for byte the same this turn.
    const texts = (ms: readonly Message[]) => ms.slice(0, 3).map((m) => [m.role, textOf(m.content)]);
    expect(texts(now)).toEqual(texts(before));
  });

  it('marks nothing without history, and never inside a message that merged this turn’s text', () => {
    expect(pointsIn(toConverseMessages(MESSAGES))).toEqual([]);
    expect(pointsIn(toConverseMessages(MESSAGES, 0))).toEqual([]);
    expect(pointsIn(toConverseMessages(MESSAGES.slice(-1), 0))).toEqual([]);
    // An earlier founder message with no reply merges with the new one: that message is this turn's.
    const merged: ChatMessage[] = [
      { role: 'user', content: 'Hello.' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'user', content: 'Still there?' },
      { role: 'user', content: 'Anyway: pricing.' },
    ];
    const converse = toConverseMessages(merged, 3);
    expect(converse).toHaveLength(3);
    expect(pointsIn(converse)).toEqual(['0:1']);
  });
});

describe('NovaProvider with prompt caching', () => {
  it('streams with a cache point after the system prefix and the history, and parses the cache usage', async () => {
    const { provider, streamInputs } = nova(NOVA_US, true);
    const result = await provider.streamText(streamRequest(HINT));
    const input = streamInputs[0];
    expect(input?.system).toEqual([{ text: STABLE }, CACHE_POINT, { text: TURN }]);
    expect(pointsIn(input?.messages)).toEqual(['2:1', '4:1']);
    expect(textOf(input?.system)).toBe(SYSTEM);
    expect(input?.messages?.map((m) => textOf(m.content))).toEqual(MESSAGES.map((m) => m.content));
    expect(result.rawAttempts[0]).toMatchObject({
      cachePoints: 3,
      usage: {
        inputTokens: 7_900,
        outputTokens: 40,
        cacheReadInputTokens: 6_000,
        cacheWriteInputTokens: 1_000,
      },
    });
  });

  it('marks a structured call the same way, never in its tool definition (Nova caches system and messages)', async () => {
    const { provider, converseInputs } = nova(NOVA_US, true);
    const result = await provider.generate(
      providerRequest(Answer, { system: SYSTEM, messages: MESSAGES, promptCache: HINT }),
    );
    const input = converseInputs[0];
    expect(input?.system).toEqual([{ text: STABLE }, CACHE_POINT, { text: TURN }]);
    expect(pointsIn(input?.messages)).toEqual(['2:1', '4:1']);
    expect(input?.toolConfig?.tools?.every((t) => !('cachePoint' in t))).toBe(true);
    expect(result.rawAttempts[0]).toMatchObject({
      cachePoints: 3,
      usage: { inputTokens: 8_200, outputTokens: 90, cacheReadInputTokens: 7_000 },
    });
  });

  it('sends no cache point when prompt caching is off, without a hint, or to a Claude model', async () => {
    const cases = [
      { model: NOVA_US, promptCache: false, hint: HINT },
      { model: NOVA_US, promptCache: undefined, hint: HINT },
      { model: NOVA_US, promptCache: true, hint: undefined },
      { model: 'global.anthropic.claude-sonnet-5-5', promptCache: true, hint: HINT },
    ];
    for (const c of cases) {
      const { provider, streamInputs, converseInputs } = nova(c.model, c.promptCache);
      const streamed = await provider.streamText(streamRequest(c.hint));
      await provider.generate(
        providerRequest(Answer, {
          system: SYSTEM,
          messages: MESSAGES,
          ...(c.hint ? { promptCache: c.hint } : {}),
        }),
      );
      for (const input of [streamInputs[0], converseInputs[0]]) {
        expect(input?.system, c.model).toEqual([{ text: SYSTEM }]);
        expect(pointsIn(input?.messages)).toEqual([]);
      }
      expect(streamed.rawAttempts[0]?.cachePoints).toBeUndefined();
    }
  });

  it('never fails a turn for the cache: a refused request goes again without checkpoints, and so do later ones', async () => {
    const refusal = () =>
      awsError('ValidationException', 'The model does not accept a cache point here.', 400);
    const { provider, streamInputs, converseInputs } = nova(NOVA_US, true, [refusal()]);
    const streamed = await provider.streamText(streamRequest(HINT));
    expect(streamed.text).toBe('Forty is a lot for them.');
    expect(streamed.rawAttempts.map((a) => [a.kind, a.outcome, a.errorName, a.cachePoints])).toEqual([
      ['initial', 'client_error', 'ValidationException', 3],
      ['cache_retry', 'ok', null, undefined],
    ]);
    expect(streamInputs[1]?.system).toEqual([{ text: SYSTEM }]);
    expect(pointsIn(streamInputs[1]?.messages)).toEqual([]);
    // The instance remembers: its next call sends none from the start.
    const next = await provider.generate(
      providerRequest(Answer, { system: SYSTEM, messages: MESSAGES, promptCache: HINT }),
    );
    expect(next.rawAttempts.map((a) => a.kind)).toEqual(['initial']);
    expect(converseInputs[0]?.system).toEqual([{ text: SYSTEM }]);
    expect(pointsIn(converseInputs[0]?.messages)).toEqual([]);
  });

  it('retries a structured call without checkpoints once, and nothing without checkpoints to drop', async () => {
    const refusal = () => awsError('ValidationException', 'Malformed input request.', 400);
    const cached = nova(NOVA_US, true, [refusal()]);
    const result = await cached.provider.generate(
      providerRequest(Answer, { system: SYSTEM, messages: MESSAGES, promptCache: HINT }),
    );
    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.rawAttempts.map((a) => a.kind)).toEqual(['initial', 'cache_retry']);
    expect(cached.converseInputs[1]?.system).toEqual([{ text: SYSTEM }]);
    expect(pointsIn(cached.converseInputs[1]?.messages)).toEqual([]);
    const plain = nova(NOVA_US, false, [refusal()]);
    await expect(
      plain.provider.generate(
        providerRequest(Answer, { system: SYSTEM, messages: MESSAGES, promptCache: HINT }),
      ),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(plain.converseInputs).toHaveLength(1);
  });

  it('takes cache points for Amazon Nova ids only', () => {
    expect(usesCachePoints('amazon.nova-2-lite-v1:0')).toBe(true);
    expect(usesCachePoints(NOVA_US)).toBe(true);
    expect(usesCachePoints(NOVA_GLOBAL)).toBe(true);
    expect(usesCachePoints('amazon.titan-embed-text-v2:0')).toBe(false);
    expect(usesCachePoints('us.anthropic.claude-haiku-5-5')).toBe(false);
    expect(usesCachePoints('openai.gpt-6-luna')).toBe(false);
  });
});

describe('cache usage and its price', () => {
  it('reads every input token and, of them, those read from and written to the cache', () => {
    expect(converseUsage(STREAM_USAGE)).toEqual({
      inputTokens: 7_900,
      outputTokens: 40,
      cacheReadInputTokens: 6_000,
      cacheWriteInputTokens: 1_000,
    });
    // A call that reported no cache fields has none (not zeros).
    expect(converseUsage({ inputTokens: 800, outputTokens: 5, totalTokens: 805 })).toEqual({
      inputTokens: 800,
      outputTokens: 5,
    });
    expect(converseUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('prices Nova 2 Lite’s cache reads at a quarter of its input rate and its cache writes at nothing', () => {
    const M = 1_000_000;
    const usage = {
      inputTokens: M,
      outputTokens: 0,
      cacheReadInputTokens: 600_000,
      cacheWriteInputTokens: 300_000,
    };
    // 100,000 uncached tokens at $0.30, 600,000 read at $0.075, 300,000 written at $0.
    expect(costFor(NOVA_GLOBAL, usage)).toBeCloseTo((100_000 * 0.3 + 600_000 * 0.075) / M, 9);
    // The `us.` profile is listed 10 % higher, cache reads too ($0.0825).
    expect(costFor(NOVA_US, usage)).toBeCloseTo(costFor(NOVA_GLOBAL, usage) * 1.1, 9);
    expect(costFor(NOVA_GLOBAL, { inputTokens: M, outputTokens: 0 })).toBeCloseTo(0.3, 9);
    // Never below zero, never more cached tokens than input tokens.
    expect(
      costFor(NOVA_GLOBAL, { inputTokens: 1_000, outputTokens: 0, cacheReadInputTokens: 5_000 }),
    ).toBeCloseTo((1_000 * 0.075) / M, 9);
  });

  it('prices cached tokens at the input rate for a model without cache rates, so the caps never under-count', () => {
    const usage = {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadInputTokens: 9_000,
      cacheWriteInputTokens: 1_000,
    };
    expect(costFor('global.anthropic.claude-sonnet-5-5', usage)).toBe(
      costFor('global.anthropic.claude-sonnet-5-5', { inputTokens: 10_000, outputTokens: 0 }),
    );
    expect(costFor('some.unknown-model', usage)).toBe(
      costFor('some.unknown-model', { inputTokens: 10_000, outputTokens: 0 }),
    );
  });

  it('accepts cache-rate overrides and refuses negative ones', () => {
    const table = createPricingTable({
      'amazon.nova-2-lite-v1:0': {
        inputPerMillionUsd: 0.3,
        outputPerMillionUsd: 2.5,
        cacheReadPerMillionUsd: 0.03,
      },
    });
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 };
    expect(costFor(NOVA_US, usage, table)).toBeCloseTo(0.03, 9);
    expect(() =>
      createPricingTable({
        x: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, cacheWritePerMillionUsd: -1 },
      }),
    ).toThrow(RangeError);
  });
});

describe('MODEL_PROMPT_CACHE', () => {
  const ENV = {
    APP_ENV: 'production',
    MODEL_PROVIDER: 'bedrock',
    MODEL_PRIMARY_ID: NOVA_US,
    MODEL_FALLBACK_ID: NOVA_GLOBAL,
  };

  it('is on by default, off on request, and never reaches the mock', () => {
    expect(modelGatewayConfigFromEnv(ENV)).toMatchObject({ provider: 'bedrock', promptCache: true });
    expect(modelGatewayConfigFromEnv({ ...ENV, MODEL_PROMPT_CACHE: 'on' })).toMatchObject({
      promptCache: true,
    });
    expect(modelGatewayConfigFromEnv({ ...ENV, MODEL_PROMPT_CACHE: 'off' })).toMatchObject({
      promptCache: false,
    });
    expect(modelGatewayConfigFromEnv({ APP_ENV: 'test', MODEL_PROMPT_CACHE: 'on' })).toEqual({
      provider: 'mock',
    });
    expect(() => modelGatewayConfigFromEnv({ ...ENV, MODEL_PROMPT_CACHE: 'sometimes' })).toThrow(
      /MODEL_PROMPT_CACHE/,
    );
  });

  it('decides whether the gateway’s Nova requests carry cache points', async () => {
    for (const promptCache of [true, false, undefined]) {
      const inputs: ConverseStreamCommandInput[] = [];
      const gateway = createModelGateway({
        provider: 'bedrock',
        region: 'us-east-1',
        primaryModelId: NOVA_US,
        fallbackModelId: NOVA_GLOBAL,
        embeddingsModelId: 'amazon.titan-embed-text-v2:0',
        ...(promptCache === undefined ? {} : { promptCache }),
        transports: {
          converse: () => Promise.reject(new Error('unused')),
          converseStream: (input) => {
            inputs.push(structuredClone(input));
            return Promise.resolve(
              events([
                { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi.' } } },
                { messageStop: { stopReason: 'end_turn' } },
                { metadata: { usage: STREAM_USAGE, metrics: { latencyMs: 5 } } },
              ]),
            );
          },
          invokeModel: () => Promise.reject(new Error('unused')),
        },
      });
      const request: StreamTextRequest = {
        purpose: 'turn',
        system: SYSTEM,
        messages: MESSAGES,
        requestId: 'req-gw',
        promptCache: HINT,
      };
      const result = await gateway.streamText(request, () => undefined);
      const on = promptCache !== false;
      expect(inputs[0]?.system).toEqual(
        on ? [{ text: STABLE }, CACHE_POINT, { text: TURN }] : [{ text: SYSTEM }],
      );
      expect(pointsIn(inputs[0]?.messages)).toEqual(on ? ['2:1', '4:1'] : []);
      // The turn's usage carries the cache counts, and its cost prices them (900 + 6,000 read + 1,000 written), at the
      // `us.` profile's rates (10 % over global).
      expect(result.usage).toEqual({
        inputTokens: 7_900,
        outputTokens: 40,
        cacheReadInputTokens: 6_000,
        cacheWriteInputTokens: 1_000,
      });
      expect(result.costUsd).toBeCloseTo(((900 * 0.3 + 6_000 * 0.075 + 40 * 2.5) * 1.1) / 1_000_000, 6);
    }
  });

  it('is ignored by the mock: the same reply with or without the hint', async () => {
    const request: StreamTextRequest = {
      purpose: 'turn',
      system: SYSTEM,
      messages: MESSAGES,
      requestId: 'req-mock',
    };
    const plain = await new MockModelGateway({ streamDelayMs: 0 }).streamText(request, () => undefined);
    const hinted = await new MockModelGateway({ streamDelayMs: 0 }).streamText(
      { ...request, promptCache: HINT },
      () => undefined,
    );
    expect(hinted.text).toBe(plain.text);
    expect(hinted.usage).toEqual(plain.usage);
    expect(hinted.attempts.map((a) => a.cachePoints)).toEqual([undefined]);
  });
});
