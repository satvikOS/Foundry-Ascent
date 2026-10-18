import type {
  ContentBlock,
  ConverseCommandOutput,
  ConverseStreamOutput,
  InferenceConfiguration,
  Message,
  StopReason,
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
import type { ChatMessage, RawModelAttempt, StreamStopReason } from './types.js';

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
  /** Default 0.2. */
  temperature?: number;
  /** Repair re-asks after invalid tool input. Default 1. */
  maxRepairAttempts?: number;
}

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|us-gov|global)\./;
const PROFILE_REQUIRED = /on-demand throughput|inference profile/i;

/**
 * Anthropic Claude ids on Bedrock (`anthropic.…`, also behind `us.`/`global.` inference profiles). Current
 * Claude models reject sampling parameters and a forced tool choice, so Converse requests for them send
 * neither: the structured call asks for the tool in its description and relies on validation and repair.
 */
export function isClaudeModelId(modelId: string): boolean {
  return /^(?:[a-z-]+\.)?anthropic\./.test(modelId);
}

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
 * The input tokens a Converse call billed. With prompt caching (Nova caches repeated prompt prefixes on its
 * own, with or without cache points), `inputTokens` counts only the tokens neither read from nor written to
 * the cache; the cached ones are reported apart and billed too (reads at a discount). All three are counted at
 * the input rate, so the spend caps never under-count a call; the bill can only be lower.
 */
export function billedInputTokens(
  usage: { inputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined,
): number {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheWriteInputTokens ?? 0);
}

/** Geographic inference-profile prefix for a region (`us-east-1` → `us.`). */
export function inferenceProfilePrefix(region: string): string {
  if (region.startsWith('us-gov-')) return 'us-gov.';
  if (region.startsWith('eu-')) return 'eu.';
  if (region.startsWith('ap-')) return 'apac.';
  return 'us.';
}

/** Converse requires alternating roles starting (and, for a reply, ending) with `user`. */
export function toConverseMessages(messages: readonly ChatMessage[]): Message[] {
  const merged: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const message of messages) {
    if (message.content.trim() === '') continue;
    const last = merged.at(-1);
    if (last?.role === message.role) last.text = `${last.text}\n\n${message.content}`;
    else merged.push({ role: message.role, text: message.content });
  }
  while (merged[0]?.role === 'assistant') merged.shift();
  if (merged.length === 0 || merged.at(-1)?.role !== 'user') {
    throw new TypeError('Converse conversation must contain at least one user message and end with one');
  }
  return merged.map((m) => ({ role: m.role, content: [{ text: m.text }] }));
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
 * Bedrock Converse reasoning models: Amazon Nova 2 Lite today, Anthropic Claude ready. Structured output
 * is obtained through a single tool (`submit_response`) whose input schema is the response schema, forced
 * for Nova and requested (tool choice `auto`) for Claude, which rejects a forced tool. Plain text streams
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
  }

  /** The id currently used for calls (the inference profile after a profile retry). */
  get effectiveModelId(): string {
    return this.#useProfile && this.#profileId ? this.#profileId : this.modelId;
  }

  #inferenceConfig(modelId: string, maxTokens: number): InferenceConfiguration {
    return isClaudeModelId(modelId) ? { maxTokens } : { maxTokens, temperature: this.#temperature };
  }

  #toolChoice(modelId: string): ToolChoice {
    return isClaudeModelId(modelId) ? { auto: {} } : { tool: { name: SUBMIT_TOOL_NAME } };
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
    const messages = toConverseMessages(request.messages);
    let kind: RawModelAttempt['kind'] = 'initial';

    for (;;) {
      const modelId = this.effectiveModelId;
      const started = performance.now();
      /** What reached `onText`: the visible reply. */
      let text = '';
      /** Everything the model generated, reasoning included (for a usage estimate). */
      let generated = '';
      const reasoning = new ReasoningFilter();
      let stopReason: StopReason | undefined;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let cached: number | undefined;
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
              reasoning: false,
            }),
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
          errorName,
        });
      };
      try {
        const events = await this.#converseStream(
          {
            modelId,
            system: [{ text: request.system }],
            messages,
            inferenceConfig: this.#inferenceConfig(modelId, request.maxOutputTokens),
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
            usage = {
              inputTokens: billedInputTokens(event.metadata.usage),
              outputTokens: event.metadata.usage.outputTokens ?? 0,
            };
            cached = event.metadata.usage.cacheReadInputTokens;
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

    const baseMessages = toConverseMessages(request.messages);
    let messages = baseMessages;
    let lastIssues: string[];
    let repairs = 0;
    let kind: RawModelAttempt['kind'] = 'initial';
    let maxTokens = request.maxOutputTokens;

    for (;;) {
      const modelId = this.effectiveModelId;
      const started = performance.now();
      let output: ConverseCommandOutput;
      try {
        output = await this.#converse(
          {
            modelId,
            system: [{ text: request.system }],
            messages,
            inferenceConfig: this.#inferenceConfig(modelId, maxTokens),
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
              toolChoice: this.#toolChoice(modelId),
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
          errorName: mapped.errorName,
        });
        if (this.#profileRetry(error, kind)) {
          this.#useProfile = true; // cached for every later call on this instance
          kind = 'profile_retry';
          continue;
        }
        return fail(mapped);
      }

      const latencyMs = Math.round(performance.now() - started);
      const usage = {
        inputTokens: billedInputTokens(output.usage),
        outputTokens: output.usage?.outputTokens ?? 0,
      };
      const cached = output.usage?.cacheReadInputTokens;
      const record = (outcome: RawModelAttempt['outcome'], issues: readonly string[] = []): void => {
        rawAttempts.push({
          provider: 'nova',
          modelId,
          kind,
          outcome,
          latencyMs,
          usage,
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
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
