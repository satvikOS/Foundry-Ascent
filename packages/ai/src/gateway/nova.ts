import type {
  ContentBlock,
  ConverseCommandOutput,
  ConverseStreamOutput,
  InferenceConfiguration,
  Message,
  StopReason,
  SystemContentBlock,
  TokenUsage,
  ToolChoice,
} from '@aws-sdk/client-bedrock-runtime';

import {
  createBedrockRuntimeTransport,
  mapAwsError,
  type ConverseFn,
  type ConverseStreamFn,
} from './bedrock-runtime.js';
import { ModelOutputInvalidError, ModelRefusalError, type ModelGatewayError } from './errors.js';
import {
  MIN_REPAIR_BUDGET_MS,
  estimatedStreamUsage,
  repairInstruction,
  validateStructured,
  type ProviderRequest,
  type ProviderResult,
  type ProviderStreamRequest,
  type ProviderStreamResult,
  type StructuredProvider,
} from './provider.js';
import { ReasoningFilter } from './reasoning-filter.js';
import { extractJsonValue } from './structured-repair.js';
import type { AwsCredentialProvider, AwsCredentials } from './sigv4-fetch.js';
import type { ChatMessage, ModelUsage, PromptCacheHint, RawModelAttempt, StreamStopReason } from './types.js';

export const SUBMIT_TOOL_NAME = 'submit_response';
/** Most output tokens a repair after a cut-off answer asks for (it doubles the request's bound up to this). */
export const MAX_REPAIR_OUTPUT_TOKENS = 16_000;

export interface NovaProviderOptions {
  /** e.g. `amazon.nova-2-lite-v1:0` or an inference profile id such as `us.amazon.nova-2-lite-v1:0`. */
  modelId: string;
  region: string;
  credentials?: AwsCredentials | AwsCredentialProvider;
  /** Converse transport; defaults to a real `BedrockRuntimeClient`. Inject a fake in tests. */
  converse?: ConverseFn;
  /** ConverseStream transport; defaults to the same client. Inject a fake in tests. */
  converseStream?: ConverseStreamFn;
  /** Sampling temperature of requests that name none of their own. Default 0.2. */
  temperature?: number;
  /**
   * OpenAI models ({@link isOpenAiModelId}) and Claude models that think by default ({@link thinksByDefault}): how much
   * they reason before answering. Default `none`, the fastest (for an OpenAI model, the only effort at which it takes a
   * sampling temperature). Other models ignore it.
   */
  reasoningEffort?: ConverseReasoningEffort;
  /** Repair re-asks after invalid tool input. Default 1. */
  maxRepairAttempts?: number;
  /**
   * Bedrock prompt caching: mark the unchanging prefix a request names (`promptCache`) with cache checkpoints, for a
   * model whose cache Bedrock bills and pricing.ts prices ({@link usesCachePoints}: Amazon Nova, Claude Haiku 4.5).
   * Default false: requests are sent without checkpoints.
   */
  promptCache?: boolean;
}

/** OpenAI reasoning efforts on Bedrock (GPT-6 Luna's model card, checked 2026-11-24; the model's own default: medium). */
export const CONVERSE_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ConverseReasoningEffort = (typeof CONVERSE_REASONING_EFFORTS)[number];

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|us-gov|global)\./;
const PROFILE_REQUIRED = /on-demand throughput|inference profile/i;

/**
 * Anthropic Claude ids on Bedrock (`anthropic.…`, also behind `us.`/`global.` inference profiles). Current Claude
 * models reject sampling parameters, so Converse requests for any Claude id send none. This, {@link isOpenAiModelId},
 * {@link forcesTool}, {@link thinksByDefault} and {@link usesCachePoints} are the only places that tell model families apart: nothing outside
 * this adapter knows which family the coach is.
 */
export function isClaudeModelId(modelId: string): boolean {
  return /^(?:[a-z-]+\.)?anthropic\./.test(modelId);
}

/**
 * OpenAI ids on Bedrock. On Converse they are always behind an inference profile (`us.openai.gpt-6-luna`,
 * `global.openai.gpt-6-luna`: the model card offers no in-region call); the bare id is Bedrock Mantle's (router.ts).
 *
 * What their Converse requests carry (GPT-6 Luna's model card, checked 2026-11-24, and what other Converse clients
 * report): `additionalModelRequestFields.reasoning.effort` (the flat `reasoning_effort` is refused); a temperature only
 * at effort `none` (OpenAI takes sampling parameters at no other effort); a forced tool; no cache checkpoints (Bedrock
 * caches a repeated prefix of 1,024 tokens or more on its own, and reports what it read and wrote). A field Bedrock
 * refuses is dropped for one retry and not sent again ({@link withoutRefusedField}).
 */
export function isOpenAiModelId(modelId: string): boolean {
  return /^(?:[a-z-]+\.)?openai\./.test(modelId);
}

/** The optional fields of an OpenAI model's requests, as far as Bedrock takes them. */
export interface OpenAiRequestFields {
  readonly temperature: boolean;
  /** null: not sent (the model then reasons at its own default). */
  readonly effort: ConverseReasoningEffort | null;
  /** Force the one tool of a structured call (else tool choice `auto`, and a reply written as text is read). */
  readonly forcedTool: boolean;
}

/** Whether a request of an OpenAI model at these fields sends its temperature (only at effort `none`). */
function sendsTemperature(fields: OpenAiRequestFields): boolean {
  return fields.temperature && fields.effort === 'none';
}

/**
 * The fields to retry with after Bedrock refused a request (`message`: its ValidationException, read here and never
 * logged), or null when it names none of them (a malformed or too long request: never retried). Each step sends less
 * than the one before, so the retries end. An effort the model does not take falls back to `low` before it is left out
 * (left out, the model reasons at its default, the slowest choice).
 */
export function withoutRefusedField(
  fields: OpenAiRequestFields,
  message: string,
): OpenAiRequestFields | null {
  if (sendsTemperature(fields) && /temperature|top_?p\b|sampling/i.test(message)) {
    return { ...fields, temperature: false };
  }
  if (fields.forcedTool && /tool[_ ]?choice/i.test(message)) return { ...fields, forcedTool: false };
  if (fields.effort !== null && /reasoning|effort|unsupported value/i.test(message)) {
    return { ...fields, effort: fields.effort === 'none' ? 'low' : null };
  }
  if (
    (sendsTemperature(fields) || fields.effort !== null) &&
    /(?:unknown|unsupported|unrecognized|unexpected) (?:parameter|field|argument|key)|additional_?model_?request_?fields|extraneous key/i.test(
      message,
    )
  ) {
    return { ...fields, temperature: false, effort: null };
  }
  return null;
}

/** What changed between two sets of fields, for the attempt's log line (`dropped:temperature`, `effort:low`). */
function droppedFields(before: OpenAiRequestFields, after: OpenAiRequestFields): string[] {
  return [
    ...(before.temperature !== after.temperature ? ['dropped:temperature'] : []),
    ...(before.effort !== after.effort
      ? [after.effort === null ? 'dropped:reasoning_effort' : `reasoning_effort:${after.effort}`]
      : []),
    ...(before.forcedTool !== after.forcedTool ? ['dropped:tool_choice'] : []),
  ];
}

/**
 * Claude models that take a forced tool (`toolChoice: { tool: { name } }`): Claude 3.x and Claude Haiku 4.5, the
 * production coach. Anthropic's tool-use docs: a forced `tool_choice` (`tool` or `any`) is supported with extended
 * thinking off and refused only with it on; this adapter never turns thinking on. Bedrock's Converse API reference
 * (ToolChoice: `tool`, "the model must request the specified tool", supported by the Anthropic Claude 3 family and
 * later Claude models). The newest generation (Claude Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5, which thinks by
 * default) answers a forced tool with a 400, so they and any Claude id not listed here keep `auto`, the tool asked
 * for in its description, and the text-reply repair path.
 *
 * Lab run 42238272157 (Haiku on `auto`): recap failed 2 of 10 with whole fields missing and distillation was invalid 6
 * of 14; with the tool forced the model cannot answer in prose first.
 */
const FORCED_TOOL_CLAUDE = /^(?:[a-z-]+\.)?anthropic\.claude-(?:3-|haiku-4-5)/;

/** Whether a structured call to `modelId` forces its one tool (every non-Claude model on Converse does). */
export function forcesTool(modelId: string): boolean {
  return !isClaudeModelId(modelId) || FORCED_TOOL_CLAUDE.test(modelId);
}

/**
 * Claude models that think before they answer unless a request says otherwise and that take `thinking: disabled`:
 * Claude Haiku 5.5 (Anthropic's migration guide, checked 2026-11-25: adaptive thinking is on when the request does not
 * set it, its tokens count against `maxTokens`, and `disabled` is accepted at effort `high` or below). The later Opus
 * and Sonnet models refuse `disabled`; none is configured anywhere. Benchmark and lab A/B only: production's coach is
 * no such model.
 */
export function thinksByDefault(modelId: string): boolean {
  return /^(?:[a-z-]+\.)?anthropic\.claude-haiku-5-5/.test(modelId);
}

/** The thinking fields of a Claude model that thinks by default: off at effort `none`, adaptive at the effort otherwise. */
function claudeThinking(
  effort: ConverseReasoningEffort,
):
  | { thinking: { type: 'disabled' } }
  | { thinking: { type: 'adaptive' }; output_config: { effort: ConverseReasoningEffort } } {
  return effort === 'none'
    ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'adaptive' }, output_config: { effort } };
}

/**
 * Model ids whose Converse requests carry prompt-cache checkpoints when prompt caching is on, each one a model whose
 * cache rates pricing.ts carries (a cached token is never metered below what Bedrock bills for it):
 *
 * - Amazon Nova (Nova 2 Lite and the Nova 1 models, also behind `us.`/`global.` inference profiles). Bedrock caches
 *   their `system` and `messages` fields (not `tools`), at least 1K tokens before a checkpoint, at most 4 checkpoints,
 *   5 minutes after the last hit; cache writes are billed at $0 and reads at a quarter of the input rate.
 * - Anthropic Claude Haiku 4.5 (`anthropic.claude-haiku-4-5-20251001-v1:0`, behind its `us.`/`global.` profiles: the
 *   production coach). Bedrock's model card (checked 2026-11-06): explicit caching on Converse, checkpoints in
 *   `system`, `messages` and `tools`, at least 4,096 tokens before a checkpoint (a shorter prefix is simply not
 *   cached), at most 4 checkpoints, a 5-minute TTL; writes are billed at 1.25 times the input rate and reads at a
 *   tenth of it. Bedrock reads `tools`, then `system`, then `messages`, so the system checkpoint also covers a
 *   structured call's tool.
 *
 * GPT-6 Luna's Converse requests take none (its model card: `cachePoint` is not supported, caching is implicit).
 *
 * Other Claude models take checkpoints too, but their cache rates are not in the pricing table yet: not until they are.
 */
export function usesCachePoints(modelId: string): boolean {
  return /^(?:[a-z-]+\.)?(?:amazon\.nova-|anthropic\.claude-haiku-4-5-20251001-v1:0$)/.test(modelId);
}

/** Bedrock's cache checkpoint (the default 5-minute TTL: Nova accepts no other, and a turn comes well within it). */
const CACHE_POINT = { cachePoint: { type: 'default' } } as const;

/** Converse stream events that carry a modelled service exception. */
const STREAM_EXCEPTIONS = [
  'internalServerException',
  'modelStreamErrorException',
  'serviceUnavailableException',
  'throttlingException',
  'validationException',
] as const;

/** A modelled exception inside the event stream, as the error the SDK would throw (its name only). */
function streamException(event: ConverseStreamOutput): Error | null {
  for (const key of STREAM_EXCEPTIONS) {
    if (event[key] !== undefined) {
      const name = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      return Object.assign(new Error(name), { name });
    }
  }
  return null;
}

function streamStopReason(reason: StopReason | undefined): StreamStopReason {
  if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'stop_sequence') return reason;
  return 'other';
}

/**
 * Every input token of a Converse call. With prompt caching (Nova also caches repeated prompt prefixes on its own,
 * with or without checkpoints), `inputTokens` counts only the tokens neither read from nor written to the cache;
 * the cached ones are reported apart: total = inputTokens + cacheReadInputTokens + cacheWriteInputTokens.
 */
export function billedInputTokens(
  usage: { inputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined,
): number {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheWriteInputTokens ?? 0);
}

/**
 * A Converse call's usage: every input token, of which those read from and written to the prompt cache (when
 * reported), which pricing.ts prices at the model's cache rates.
 */
export function converseUsage(usage: TokenUsage | undefined): ModelUsage {
  const read = usage?.cacheReadInputTokens;
  const write = usage?.cacheWriteInputTokens;
  return {
    inputTokens: billedInputTokens(usage),
    outputTokens: usage?.outputTokens ?? 0,
    ...(typeof read === 'number' ? { cacheReadInputTokens: read } : {}),
    ...(typeof write === 'number' ? { cacheWriteInputTokens: write } : {}),
  };
}

/**
 * The `system` field of a Converse request: the prompt, with a cache checkpoint after its first `systemChars`
 * characters (the conversation's unchanging prefix) when there are any. The text is the same either way, in two
 * blocks around the checkpoint.
 */
export function converseSystem(system: string, systemChars: number): SystemContentBlock[] {
  const cut = Math.min(Math.max(0, Math.floor(systemChars)), system.length);
  const prefix = system.slice(0, cut);
  const rest = system.slice(cut);
  if (prefix.trim() === '') return [{ text: system }];
  if (rest.trim() === '') return [{ text: system }, CACHE_POINT];
  return [{ text: prefix }, CACHE_POINT, { text: rest }];
}

/** Geographic inference-profile prefix for a region (`us-east-1` → `us.`). */
export function inferenceProfilePrefix(region: string): string {
  if (region.startsWith('us-gov-')) return 'us-gov.';
  if (region.startsWith('eu-')) return 'eu.';
  if (region.startsWith('ap-')) return 'apac.';
  return 'us.';
}

/**
 * Converse requires alternating roles starting (and, for a reply, ending) with `user`.
 *
 * With `historyMessages` (prompt caching), the conversation so far is marked for the cache at the end of its last two
 * founder messages: the earlier one is where the previous turn marked it (its prefix is read back from the cache),
 * the later one is written for the next turn. A checkpoint goes only at the end of a message made of earlier
 * exchanges alone, never in this turn's message.
 */
export function toConverseMessages(messages: readonly ChatMessage[], historyMessages = 0): Message[] {
  /** `last`: index in `messages` of the last message merged into this one. */
  const merged: { role: 'user' | 'assistant'; text: string; last: number }[] = [];
  messages.forEach((message, index) => {
    if (message.content.trim() === '') return;
    const last = merged.at(-1);
    if (last?.role === message.role) {
      last.text = `${last.text}\n\n${message.content}`;
      last.last = index;
    } else merged.push({ role: message.role, text: message.content, last: index });
  });
  while (merged[0]?.role === 'assistant') merged.shift();
  if (merged.length === 0 || merged.at(-1)?.role !== 'user') {
    throw new TypeError('Converse conversation must contain at least one user message and end with one');
  }
  const marked = new Set(
    merged
      .slice(0, -1)
      .flatMap((m, i) => (m.role === 'user' && m.last < historyMessages ? [i] : []))
      .slice(-2),
  );
  return merged.map((m, i) => ({
    role: m.role,
    content: marked.has(i) ? [{ text: m.text }, CACHE_POINT] : [{ text: m.text }],
  }));
}

/** Cache checkpoints in a Converse request's system prompt and messages. */
function cachePointsIn(system: readonly SystemContentBlock[], messages: readonly Message[]): number {
  const isPoint = (block: object): boolean => 'cachePoint' in block && block.cachePoint !== undefined;
  return (
    system.filter(isPoint).length +
    messages.reduce((acc, m) => acc + (m.content ?? []).filter(isPoint).length, 0)
  );
}

/** The text blocks of a Converse answer (what the model wrote instead of, or before, a tool call). */
function textOf(output: ConverseCommandOutput): string {
  return (output.output?.message?.content ?? [])
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function findToolUse(output: ConverseCommandOutput): ContentBlock.ToolUseMember | null {
  const content = output.output?.message?.content ?? [];
  for (const block of content) {
    if (block.toolUse?.name === SUBMIT_TOOL_NAME) return block as ContentBlock.ToolUseMember;
  }
  return null;
}

function isProfileRequiredError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'ValidationException' && PROFILE_REQUIRED.test(error.message)
  );
}

/**
 * Bedrock Converse reasoning models: Amazon Nova 2 Lite, Anthropic Claude (Claude Haiku 4.5 is the production coach)
 * and OpenAI GPT-6 Luna ({@link isOpenAiModelId}). Structured output is obtained through a single tool
 * (`submit_response`) whose input schema is the response schema, forced for Nova, Claude Haiku 4.5 and Luna, and requested (tool choice `auto`) for the newer Claude models that
 * reject a forced tool ({@link forcesTool}; a reply written as text is still read, and repaired). Plain text streams
 * through ConverseStream. If the base model id requires an inference profile, the provider retries once
 * with the geographic profile id and remembers that choice for the lifetime of the instance.
 */
export class NovaProvider implements StructuredProvider {
  readonly name = 'nova' as const;
  readonly modelId: string;
  readonly #converse: ConverseFn;
  readonly #converseStream: ConverseStreamFn;
  readonly #profileId: string | null;
  readonly #temperature: number;
  readonly #maxRepairAttempts: number;
  readonly #promptCache: boolean;
  /** The optional request fields of an OpenAI model, without those Bedrock refused; null for every other model. */
  #openAi: OpenAiRequestFields | null;
  /** How much a Claude model that thinks by default thinks; null for every other model. */
  readonly #claudeEffort: ConverseReasoningEffort | null;
  /** Bedrock refused a request with cache checkpoints: this instance sends none from then on. */
  #cacheRefused = false;
  #useProfile = false;

  constructor(options: NovaProviderOptions) {
    this.modelId = options.modelId;
    const runtime = (): ReturnType<typeof createBedrockRuntimeTransport> =>
      createBedrockRuntimeTransport({
        region: options.region,
        ...(options.credentials ? { credentials: options.credentials } : {}),
      });
    const transport = options.converse && options.converseStream ? null : runtime();
    this.#converse = options.converse ?? (transport ?? runtime()).converse;
    this.#converseStream = options.converseStream ?? (transport ?? runtime()).converseStream;
    this.#profileId = GEO_PREFIX.test(options.modelId)
      ? null
      : `${inferenceProfilePrefix(options.region)}${options.modelId}`;
    this.#temperature = options.temperature ?? 0.2;
    this.#maxRepairAttempts = Math.max(0, options.maxRepairAttempts ?? 1);
    this.#promptCache = options.promptCache === true && usesCachePoints(options.modelId);
    this.#openAi = isOpenAiModelId(options.modelId)
      ? { temperature: true, effort: options.reasoningEffort ?? 'none', forcedTool: true }
      : null;
    this.#claudeEffort = thinksByDefault(options.modelId) ? (options.reasoningEffort ?? 'none') : null;
  }

  /** The id currently used for calls (the inference profile after a profile retry). */
  get effectiveModelId(): string {
    return this.#useProfile && this.#profileId ? this.#profileId : this.modelId;
  }

  /** The request fields an OpenAI model's requests carry now; null for every other model. */
  get openAiFields(): OpenAiRequestFields | null {
    return this.#openAi;
  }

  /** What tells one model family's request from another's, besides its prompt. */
  #modelConfig(
    modelId: string,
    maxTokens: number,
    temperature: number | undefined,
    openAi: OpenAiRequestFields | null,
  ): {
    inferenceConfig: InferenceConfiguration;
    additionalModelRequestFields?:
      { reasoning: { effort: ConverseReasoningEffort } } | ReturnType<typeof claudeThinking>;
  } {
    const sampling = { maxTokens, temperature: temperature ?? this.#temperature };
    if (openAi !== null) {
      return {
        inferenceConfig: sendsTemperature(openAi) ? sampling : { maxTokens },
        ...(openAi.effort === null
          ? {}
          : { additionalModelRequestFields: { reasoning: { effort: openAi.effort } } }),
      };
    }
    if (this.#claudeEffort !== null) {
      return {
        inferenceConfig: { maxTokens },
        additionalModelRequestFields: claudeThinking(this.#claudeEffort),
      };
    }
    return { inferenceConfig: isClaudeModelId(modelId) ? { maxTokens } : sampling };
  }

  /**
   * The request's system prompt and messages, with cache checkpoints where its unchanging prefix ends when prompt
   * caching is on (the text is the same either way).
   */
  #prompt(
    system: string,
    messages: readonly ChatMessage[],
    hint: PromptCacheHint | undefined,
  ): { system: SystemContentBlock[]; messages: Message[]; cachePoints: number } {
    const cache = this.#promptCache && !this.#cacheRefused && hint !== undefined ? hint : null;
    const blocks = cache === null ? [{ text: system }] : converseSystem(system, cache.systemChars);
    const converse = toConverseMessages(messages, cache?.historyMessages ?? 0);
    return { system: blocks, messages: converse, cachePoints: cachePointsIn(blocks, converse) };
  }

  #toolChoice(modelId: string, openAi: OpenAiRequestFields | null): ToolChoice {
    const forced = forcesTool(modelId) && openAi?.forcedTool !== false;
    return forced ? { tool: { name: SUBMIT_TOOL_NAME } } : { auto: {} };
  }

  /**
   * The fields to retry a refused request of an OpenAI model with, or null. Not for a repair, whose messages were
   * built from the first answer.
   */
  #fieldRetry(
    error: unknown,
    openAi: OpenAiRequestFields | null,
    kind: RawModelAttempt['kind'],
  ): OpenAiRequestFields | null {
    if (openAi === null || kind === 'repair') return null;
    if (!(error instanceof Error) || error.name !== 'ValidationException' || isProfileRequiredError(error)) {
      return null;
    }
    return withoutRefusedField(openAi, error.message);
  }

  /**
   * Whether a failed call should be retried once without its cache checkpoints: Bedrock refused the request
   * (ValidationException) before the model ran, so a turn never fails for the cache. Not for a repair, whose messages
   * were built from the first ones.
   */
  #cacheRetry(error: unknown, cachePoints: number, kind: RawModelAttempt['kind']): boolean {
    return (
      cachePoints > 0 &&
      kind !== 'repair' &&
      error instanceof Error &&
      error.name === 'ValidationException' &&
      !isProfileRequiredError(error)
    );
  }

  /** Whether a failed call should be retried once with the geographic inference profile. */
  #profileRetry(error: unknown, kind: RawModelAttempt['kind']): boolean {
    return (
      !this.#useProfile &&
      this.#profileId !== null &&
      kind !== 'profile_retry' &&
      isProfileRequiredError(error)
    );
  }

  /**
   * Streams plain text through ConverseStream. Each text delta goes to `onText` as it arrives, without the
   * model's reasoning: reasoning content blocks are never handed on, and reasoning the model writes into its
   * text inside `<thinking>` tags is dropped as it streams (`ReasoningFilter`; on a call it would be spoken). A
   * failure after text was delivered is never retried (not even the inference-profile retry) and is marked
   * `textDelivered`; usage the stream never reported (it ended early) is estimated once the request reached
   * Bedrock (`estimatedStreamUsage`, from everything the model generated, reasoning included).
   */
  async streamText(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
    const { deadline } = request;
    const rawAttempts: RawModelAttempt[] = [];
    let prompt = this.#prompt(request.system, request.messages, request.promptCache);
    let kind: RawModelAttempt['kind'] = 'initial';
    let openAi = this.#openAi;
    let dropped: string[] = [];

    for (;;) {
      const modelId = this.effectiveModelId;
      const started = performance.now();
      /** What reached `onText`: the visible reply. */
      let text = '';
      /** Everything the model generated, reasoning included (for a usage estimate). */
      let generated = '';
      const reasoning = new ReasoningFilter();
      let stopReason: StopReason | undefined;
      let usage: ModelUsage | null = null;
      let opened = false;
      const cancelledBeforeSend = deadline.aborted;
      const record = (outcome: RawModelAttempt['outcome'], errorName: string | null): void => {
        rawAttempts.push({
          provider: 'nova',
          modelId,
          kind,
          outcome,
          latencyMs: Math.round(performance.now() - started),
          usage:
            usage ??
            estimatedStreamUsage(request, generated, {
              outcome,
              opened,
              cancelledBeforeSend,
              // An OpenAI model's reasoning is billed as output and reaches the stream as a summary at most; a Claude
              // model's thinking text is omitted from the stream by default.
              reasoning:
                (openAi !== null && openAi.effort !== 'none') ||
                (this.#claudeEffort !== null && this.#claudeEffort !== 'none'),
            }),
          ...(prompt.cachePoints > 0 ? { cachePoints: prompt.cachePoints } : {}),
          errorName,
          ...(dropped.length > 0 ? { issues: dropped } : {}),
        });
      };
      try {
        const events = await this.#converseStream(
          {
            modelId,
            system: prompt.system,
            messages: prompt.messages,
            ...this.#modelConfig(modelId, request.maxOutputTokens, request.temperature, openAi),
          },
          deadline.signal,
        );
        opened = true;
        for await (const event of events) {
          const thrown = streamException(event);
          if (thrown) throw thrown;
          const delta = event.contentBlockDelta?.delta;
          const chunk = delta?.text;
          if (typeof chunk === 'string' && chunk !== '') {
            generated += chunk;
            const visible = reasoning.push(chunk);
            if (visible !== '') {
              text += visible;
              await request.onText(visible);
            }
          } else if (delta?.reasoningContent !== undefined) {
            // The model's reasoning, kept apart by Bedrock: never part of the reply.
            generated += delta.reasoningContent.text ?? '';
          } else if (event.messageStop) {
            stopReason = event.messageStop.stopReason;
          } else if (event.metadata?.usage) {
            usage = converseUsage(event.metadata.usage);
          }
        }
      } catch (error) {
        const mapped = mapAwsError(error, deadline, modelId);
        record(mapped.reason === 'config' ? 'client_error' : mapped.reason, mapped.errorName);
        if (text === '' && this.#profileRetry(error, kind)) {
          this.#useProfile = true; // cached for every later call on this instance
          kind = 'profile_retry';
          continue;
        }
        if (text === '' && this.#cacheRetry(error, prompt.cachePoints, kind)) {
          this.#cacheRefused = true; // for every later call on this instance
          prompt = this.#prompt(request.system, request.messages, request.promptCache);
          kind = 'cache_retry';
          continue;
        }
        const fewer = text === '' && openAi !== null ? this.#fieldRetry(error, openAi, kind) : null;
        if (fewer !== null && openAi !== null) {
          dropped = [...dropped, ...droppedFields(openAi, fewer)];
          openAi = fewer;
          kind = 'field_retry';
          continue;
        }
        mapped.rawAttempts = rawAttempts;
        mapped.textDelivered = text !== '';
        throw mapped;
      }

      // What the filter still held (a "<" that turned out not to open a reasoning block) is the reply's end.
      const tail = reasoning.end();
      if (tail !== '') {
        text += tail;
        await request.onText(tail);
      }
      if (stopReason === 'content_filtered' || stopReason === 'guardrail_intervened') {
        record('refusal', null);
        const refusal = new ModelRefusalError(modelId, 'content_filter');
        refusal.rawAttempts = rawAttempts;
        refusal.textDelivered = text !== '';
        throw refusal;
      }
      record('ok', null);
      // Bedrock took the request without them: for every later call on this instance.
      if (dropped.length > 0) this.#openAi = openAi;
      return { text, modelId, stopReason: streamStopReason(stopReason), rawAttempts };
    }
  }

  async generate<T>(request: ProviderRequest<T>): Promise<ProviderResult<T>> {
    const { deadline } = request;
    const rawAttempts: RawModelAttempt[] = [];
    const fail = (error: ModelGatewayError): never => {
      error.rawAttempts = rawAttempts;
      throw error;
    };

    let prompt = this.#prompt(request.system, request.messages, request.promptCache);
    let baseMessages = prompt.messages;
    let messages = baseMessages;
    let lastIssues: string[];
    let repairs = 0;
    let kind: RawModelAttempt['kind'] = 'initial';
    let maxTokens = request.maxOutputTokens;
    let openAi = this.#openAi;
    let dropped: string[] = [];

    for (;;) {
      const modelId = this.effectiveModelId;
      const started = performance.now();
      let output: ConverseCommandOutput;
      try {
        output = await this.#converse(
          {
            modelId,
            system: prompt.system,
            messages,
            ...this.#modelConfig(modelId, maxTokens, request.temperature, openAi),
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: SUBMIT_TOOL_NAME,
                    description: `Submit the final ${request.schemaName} object. Always respond by calling this tool.`,
                    inputSchema: { json: request.strict.schema },
                  },
                },
              ],
              toolChoice: this.#toolChoice(modelId, openAi),
            },
          },
          deadline.signal,
        );
      } catch (error) {
        const mapped = mapAwsError(error, deadline, modelId);
        rawAttempts.push({
          provider: 'nova',
          modelId,
          kind,
          outcome: mapped.reason === 'config' ? 'client_error' : mapped.reason,
          latencyMs: Math.round(performance.now() - started),
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(prompt.cachePoints > 0 ? { cachePoints: prompt.cachePoints } : {}),
          errorName: mapped.errorName,
          ...(dropped.length > 0 ? { issues: dropped } : {}),
        });
        if (this.#profileRetry(error, kind)) {
          this.#useProfile = true; // cached for every later call on this instance
          kind = 'profile_retry';
          continue;
        }
        if (this.#cacheRetry(error, prompt.cachePoints, kind)) {
          this.#cacheRefused = true; // for every later call on this instance
          prompt = this.#prompt(request.system, request.messages, request.promptCache);
          baseMessages = prompt.messages;
          messages = baseMessages;
          kind = 'cache_retry';
          continue;
        }
        const fewer = this.#fieldRetry(error, openAi, kind);
        if (fewer !== null && openAi !== null) {
          dropped = [...dropped, ...droppedFields(openAi, fewer)];
          openAi = fewer;
          kind = 'field_retry';
          continue;
        }
        return fail(mapped);
      }
      // Bedrock took the request without them: for every later call on this instance.
      if (dropped.length > 0) this.#openAi = openAi;

      const latencyMs = Math.round(performance.now() - started);
      const usage = converseUsage(output.usage);
      const record = (outcome: RawModelAttempt['outcome'], found: readonly string[] = []): void => {
        const issues = kind === 'field_retry' ? [...dropped, ...found] : found;
        rawAttempts.push({
          provider: 'nova',
          modelId,
          kind,
          outcome,
          latencyMs,
          usage,
          ...(prompt.cachePoints > 0 ? { cachePoints: prompt.cachePoints } : {}),
          errorName: null,
          ...(issues.length > 0 ? { issues } : {}),
        });
      };

      if (output.stopReason === 'content_filtered' || output.stopReason === 'guardrail_intervened') {
        record('refusal');
        return fail(new ModelRefusalError(modelId, 'content_filter'));
      }

      const toolUse = findToolUse(output);
      const truncated = output.stopReason === 'max_tokens';
      let feedback: string;
      if (toolUse) {
        const outcome = validateStructured(toolUse.toolUse.input, request.zodSchema, request.strict);
        if (outcome.ok) {
          record('ok', outcome.repairs);
          return { value: outcome.value, modelId, rawAttempts };
        }
        lastIssues = outcome.issues;
        feedback = outcome.feedback;
        if (truncated) {
          feedback = `- The tool input was cut off before it was complete. Respond more concisely.\n${feedback}`;
        }
      } else {
        // No tool call: the model may have written the object as text (alone, fenced, after prose or reasoning).
        const written = extractJsonValue(textOf(output));
        const outcome =
          written === undefined ? null : validateStructured(written, request.zodSchema, request.strict);
        if (outcome?.ok) {
          record('ok', ['text_output:(root)', ...outcome.repairs]);
          return { value: outcome.value, modelId, rawAttempts };
        }
        lastIssues =
          outcome === null ? [`(root): no_tool_use:${output.stopReason ?? 'unknown'}`] : outcome.issues;
        feedback = `- You must call the ${SUBMIT_TOOL_NAME} tool with the complete object.`;
        if (outcome !== null) feedback = `${feedback}\n${outcome.feedback}`;
      }
      record('invalid_output', truncated ? ['(root): max_tokens', ...lastIssues] : lastIssues);

      if (repairs >= this.#maxRepairAttempts || deadline.remainingMs() < MIN_REPAIR_BUDGET_MS) break;
      repairs += 1;
      kind = 'repair';
      // Cut off at the output bound: the repair gets room to finish (a second answer at the same bound would be
      // cut off again).
      if (truncated) maxTokens = Math.max(maxTokens, Math.min(maxTokens * 2, MAX_REPAIR_OUTPUT_TOKENS));
      const instruction = repairInstruction(request.schemaName, feedback);
      messages = toolUse?.toolUse.toolUseId
        ? [
            ...baseMessages,
            { role: 'assistant', content: [toolUse] },
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: toolUse.toolUse.toolUseId,
                    status: 'error',
                    content: [{ text: instruction }],
                  },
                },
              ],
            },
          ]
        : [...baseMessages.slice(0, -1), appendText(baseMessages.at(-1), instruction)];
    }

    return fail(new ModelOutputInvalidError(this.effectiveModelId, lastIssues));
  }
}

function appendText(message: Message | undefined, text: string): Message {
  return { role: 'user', content: [...(message?.content ?? []), { text }] };
}
