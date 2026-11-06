/**
 * Bedrock prompt caching on the production coach (Claude Haiku 4.5, docs/runbooks/latency.md "Prompt caching"): a
 * conversation's turns, built exactly as the turn engine builds them (the Thomas release's system prompt, its cached
 * prefix, the conversation so far and phase B's messages), sent through the real gateway and Converse adapter to a
 * stand-in for Bedrock's prompt cache. The stand-in keeps what Bedrock documents for Claude Haiku 4.5: a checkpoint
 * caches the whole prefix before it (`tools`, then `system`, then `messages`) once that prefix reaches 4,096 tokens, a
 * read is the longest cached prefix, an entry lives 5 minutes after its last use, and what the request writes past the
 * read is billed as a cache write. Tokens are estimated at 4 characters each (Claude's tokenizer counts English at
 * fewer characters a token, so real prefixes are longer and cache at least as readily).
 *
 * It measures the hit rate (the share of input tokens read from the cache) and checks that the meter prices those
 * tokens at the cache rates.
 */
import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  CoachAnnotations,
  MockModelGateway,
  buildSystemPromptParts,
  costFor,
  createModelGateway,
  type BedrockGatewayConfig,
  type HistoryTurn,
  type ModelUsage,
  type PromptCacheHint,
  type SystemPromptInput,
} from '@foundry/ai';
import { THOMAS_RELEASE } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { assembleContext } from './context-budget.js';
import { annotationMessages, answerSystemPrompt } from './turn-prompts.js';

const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/** Bedrock's model card for Claude Haiku 4.5: the fewest tokens before a checkpoint that caches. */
const MIN_CACHED_TOKENS = 4_096;
const TTL_MS = 5 * 60_000;
const CHARS_PER_TOKEN = 4;

type Transports = NonNullable<BedrockGatewayConfig['transports']>;
type ConverseInput = Parameters<NonNullable<Transports['converse']>>[0];
type StreamEvent =
  Awaited<ReturnType<NonNullable<Transports['converseStream']>>> extends AsyncIterable<infer E> ? E : never;

const tokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * A stand-in for Bedrock's prompt cache, keyed by the model and the exact prefix before each checkpoint.
 * `clock` is the simulated time of the next request.
 */
class PromptCacheStandIn {
  readonly #entries = new Map<string, number>();
  clock = 0;

  /** The usage Bedrock would report for this request (Converse `usage`, cached tokens apart). */
  usage(input: ConverseInput, outputTokens: number): Required<ModelUsage> & { totalTokens: number } {
    let prefix = `${input.modelId ?? ''}\n`;
    const checkpoints: { key: string; tokens: number }[] = [];
    const add = (blocks: readonly object[]) => {
      for (const block of blocks) {
        if ('cachePoint' in block && block.cachePoint !== undefined) {
          checkpoints.push({ key: prefix, tokens: tokens(prefix.length) });
        } else if ('text' in block && typeof block.text === 'string') {
          prefix += block.text;
        } else {
          prefix += JSON.stringify(block);
        }
      }
    };
    if (input.toolConfig) prefix += JSON.stringify(input.toolConfig);
    add(input.system ?? []);
    for (const message of input.messages ?? []) {
      prefix += `\n${message.role ?? ''}:`;
      add(message.content ?? []);
    }
    const total = tokens(prefix.length);
    const now = this.clock;
    const live = (key: string) => (this.#entries.get(key) ?? -Infinity) > now;
    const eligible = checkpoints.filter((c) => c.tokens >= MIN_CACHED_TOKENS);
    const hit = [...eligible].reverse().find((c) => live(c.key));
    const read = hit?.tokens ?? 0;
    const last = eligible.at(-1);
    const write = last !== undefined && last.tokens > read ? last.tokens - read : 0;
    for (const c of eligible) if (c.tokens <= (last?.tokens ?? 0)) this.#entries.set(c.key, now + TTL_MS);
    return {
      inputTokens: total - read - write,
      outputTokens,
      cacheReadInputTokens: read,
      cacheWriteInputTokens: write,
      totalTokens: total + outputTokens,
    };
  }
}

/** The Thomas release (production's persona) as the turn's prompt renders it. */
const TURN: SystemPromptInput = {
  release: {
    version: 5,
    personaName: THOMAS_RELEASE.name,
    eirName: 'Corin Halvorsen',
    firstPerson: true,
    eirSeesWork: true,
    mentor: true,
    disclosureText: THOMAS_RELEASE.disclosure,
    doctrine: THOMAS_RELEASE.doctrine,
    style: THOMAS_RELEASE.style,
  },
  mode: 'auto',
  allowedModes: ['diagnose', 'coach', 'teach', 'challenge'],
  policy: { riskCategories: [], groundingThreshold: 0.6 },
  ventureContext: {
    name: 'QuietQuad',
    stage: 'validation',
    domain: 'edtech',
    currentGoal: 'Ten paying libraries by spring',
  },
  conversationGoal: 'Price the pilot',
  today: '2026-11-06',
  channel: 'voice',
  continuity: {
    founderFirstName: 'Maya',
    notebook: {
      summary: 'Maya runs QuietQuad, quiet study seats for exam weeks.',
      founderProfile: [],
      openQuestions: [],
      lastAdvice: [],
      commitments: [],
      nextOpener: null,
      updatedAt: '2026-11-01T10:00:00Z',
    },
  },
};

const FOUNDER = [
  'We did three library interviews this week.',
  'They balked at forty dollars a seat.',
  'Maybe twenty-five? I am not sure what anchors it.',
  'The head librarian said the budget comes from student services.',
  'Should I pilot with one library first or three at once?',
  'Okay, one library. What do I ask them to commit to?',
  'A letter of intent feels heavy for a pilot.',
  'Fine, a paid pilot at half price for four weeks.',
];
const REPLIES = FOUNDER.map((_, i) => `Reply ${String(i + 1)}: here is what I would do next, and why.`);

/** The two calls of each streamed voice turn, as `answer.ts` and `generate.ts` send them, through the gateway. */
async function converse(turns: number, secondsBetweenTurns: number) {
  const cache = new PromptCacheStandIn();
  const mock = new MockModelGateway();
  const calls: { phase: 'A' | 'B'; turn: number; usage: Required<ModelUsage>; costUsd: number }[] = [];
  let pending: { phase: 'A' | 'B'; turn: number } = { phase: 'A', turn: 0 };
  const transports: Transports = {
    converseStream: (input) => {
      const usage = cache.usage(input, 60);
      return Promise.resolve(
        (async function* (): AsyncGenerator<StreamEvent> {
          await Promise.resolve();
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: REPLIES[pending.turn] ?? '' } } };
          yield { messageStop: { stopReason: 'end_turn' as const } };
          yield { metadata: { usage, metrics: { latencyMs: 700 } } };
        })(),
      );
    },
    converse: async (input) => {
      const usage = cache.usage(input, 400);
      // A schema-valid annotation of the reply, as the model would submit it.
      const value = (
        await mock.generateStructured({
          purpose: 'turn',
          system: input.system?.map((b) => ('text' in b ? (b.text ?? '') : '')).join('') ?? '',
          messages: [{ role: 'user', content: 'annotate' }],
          schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
          zodSchema: CoachAnnotations,
          requestId: 'stand-in',
        })
      ).value;
      return {
        $metadata: {},
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 't', name: 'submit_response', input: value } }],
          },
        },
        stopReason: 'tool_use',
        usage,
        metrics: { latencyMs: 900 },
      };
    },
    invokeModel: () => Promise.reject(new Error('no embeddings here')),
  };
  const gateway = createModelGateway({
    provider: 'bedrock',
    region: 'us-east-1',
    primaryModelId: HAIKU,
    fallbackModelId: 'us.amazon.nova-2-lite-v1:0',
    embeddingsModelId: 'amazon.titan-embed-text-v2:0',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    transports,
  });

  const history: HistoryTurn[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const founderText = FOUNDER[turn % FOUNDER.length] ?? '';
    // The turn's own part changes (a flagged topic on one turn); the prefix does not.
    const parts = buildSystemPromptParts({
      ...TURN,
      policy: { riskCategories: turn === 3 ? ['securities_investment'] : [], groundingThreshold: 0.6 },
    });
    const system = `${parts.stable}${parts.turn}`;
    const context = assembleContext({
      system,
      evidence: [],
      history,
      founderText,
      maxInputTokens: 16_000,
      maxHistoryTurns: 12,
      continuity: TURN.continuity ?? null,
      today: '2026-11-06',
      opener: 'Good to see you again, Maya. How did the interviews go?',
    });
    const promptCache: PromptCacheHint = {
      systemChars: parts.stable.length,
      historyMessages: context.messages.length - 1,
    };
    const meter = (phase: 'A' | 'B', usage: ModelUsage, costUsd: number) => {
      calls.push({
        phase,
        turn,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
        },
        costUsd,
      });
    };
    pending = { phase: 'A', turn };
    const answer = await gateway.streamText(
      {
        purpose: 'turn',
        system: answerSystemPrompt(system, {
          channel: 'voice',
          mode: null,
          allowedModes: TURN.allowedModes ?? [],
          stableChars: promptCache.systemChars,
        }),
        messages: context.messages,
        promptCache,
        requestId: `turn-${String(turn)}`,
      },
      () => undefined,
    );
    meter('A', answer.usage, answer.costUsd);
    cache.clock += 2_000;
    pending = { phase: 'B', turn };
    const fields = await gateway.generateStructured({
      purpose: 'turn',
      system,
      messages: annotationMessages(context.messages, answer.text),
      promptCache,
      schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
      zodSchema: CoachAnnotations,
      requestId: `turn-${String(turn)}`,
    });
    meter('B', fields.usage, fields.costUsd);
    history.push({ founderText, answer: answer.text });
    cache.clock += secondsBetweenTurns * 1_000;
  }
  return { calls, stable: buildSystemPromptParts(TURN).stable };
}

function hitRate(calls: readonly { usage: Required<ModelUsage> }[]): number {
  const input = calls.reduce((acc, c) => acc + c.usage.inputTokens, 0);
  const read = calls.reduce((acc, c) => acc + c.usage.cacheReadInputTokens, 0);
  return input === 0 ? 0 : read / input;
}

describe('prompt caching on Claude Haiku 4.5, over a conversation', () => {
  it('caches the Thomas prompt’s unchanging prefix: it is above the model’s 4,096-token minimum', async () => {
    const { calls, stable } = await converse(2, 20);
    expect(tokens(stable.length)).toBeGreaterThan(MIN_CACHED_TOKENS);
    // The first turn writes (each call its own prefix: phase B carries its tool before the system prompt)...
    const first = calls.filter((c) => c.turn === 0);
    expect(first.map((c) => c.usage.cacheReadInputTokens)).toEqual([0, 0]);
    expect(first.every((c) => c.usage.cacheWriteInputTokens >= MIN_CACHED_TOKENS)).toBe(true);
    // ...and the next turn's two calls read it back.
    const second = calls.filter((c) => c.turn === 1);
    expect(second.every((c) => c.usage.cacheReadInputTokens >= tokens(stable.length))).toBe(true);
  });

  it('reads most of every later turn’s input from the cache, both calls', async () => {
    const { calls } = await converse(8, 20);
    const later = calls.filter((c) => c.turn > 0);
    // Measured with this stand-in (docs/runbooks/latency.md): 0 on the first turn, then 0.88 (phase A) and 0.87 (phase B);
    // 0.77 over the 8 turns. A turn whose own part changes (the flagged topic of turn 4) reads back the system prefix
    // alone, and so does the turn after it: the conversation is cached after that part.
    expect(hitRate(calls.filter((c) => c.turn === 0))).toBe(0);
    expect(hitRate(later.filter((c) => c.phase === 'A'))).toBeGreaterThan(0.8);
    expect(hitRate(later.filter((c) => c.phase === 'B'))).toBeGreaterThan(0.8);
    expect(hitRate(calls)).toBeGreaterThan(0.7);
    // Each later call writes only what this turn added past the earlier checkpoint, never the whole prompt again.
    for (const c of later) expect(c.usage.cacheWriteInputTokens).toBeLessThan(c.usage.cacheReadInputTokens);
  });

  it('meters cached tokens at the cache rates: cheaper than the same tokens uncached, never below the price list', async () => {
    const { calls } = await converse(8, 20);
    for (const c of calls) {
      const { inputTokens, outputTokens, cacheReadInputTokens: read, cacheWriteInputTokens: write } = c.usage;
      // The us. profile's rates (pricing.ts): input 1.10, output 5.50, cache write 1.375, cache read 0.11 per million.
      const expected =
        ((inputTokens - read - write) * 1.1 + read * 0.11 + write * 1.375 + outputTokens * 5.5) / 1e6;
      expect(c.costUsd).toBeCloseTo(expected, 5);
      expect(c.costUsd).toBeGreaterThanOrEqual(expected - 1e-6);
    }
    const metered = calls.reduce((acc, c) => acc + c.costUsd, 0);
    const uncached = calls.reduce(
      (acc, c) =>
        acc + costFor(HAIKU, { inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens }),
      0,
    );
    // Measured with this stand-in: USD 0.059 against 0.132 for the same 8 turns without the cache (55 % less).
    expect(metered).toBeLessThan(uncached * 0.5);
  });

  it('writes again once the conversation was idle past the cache’s 5 minutes', async () => {
    const { calls } = await converse(3, 6 * 60);
    expect(calls.map((c) => c.usage.cacheReadInputTokens)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
