import type { ContentBlock, ConverseCommandOutput, Message } from '@aws-sdk/client-bedrock-runtime';

import { createBedrockRuntimeTransport, mapAwsError, type ConverseFn } from './bedrock-runtime.js';
import { ModelOutputInvalidError, ModelRefusalError, type ModelGatewayError } from './errors.js';
import {
  MIN_REPAIR_BUDGET_MS,
  repairInstruction,
  validateStructured,
  type ProviderRequest,
  type ProviderResult,
  type StructuredProvider,
} from './provider.js';
import type { AwsCredentialProvider, AwsCredentials } from './sigv4-fetch.js';
import type { ChatMessage, RawModelAttempt } from './types.js';

export const SUBMIT_TOOL_NAME = 'submit_response';

export interface NovaProviderOptions {
  /** e.g. `amazon.nova-2-lite-v1:0` or an inference profile id such as `us.amazon.nova-2-lite-v1:0`. */
  modelId: string;
  region: string;
  credentials?: AwsCredentials | AwsCredentialProvider;
  /** Converse transport; defaults to a real `BedrockRuntimeClient`. Inject a fake in tests. */
  converse?: ConverseFn;
  /** Default 0.2. */
  temperature?: number;
  /** Repair re-asks after invalid tool input. Default 1. */
  maxRepairAttempts?: number;
}

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|us-gov|global)\./;
const PROFILE_REQUIRED = /on-demand throughput|inference profile/i;

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
 * Fallback reasoning model: Amazon Nova 2 Lite via Bedrock Converse. Structured output is obtained
 * by forcing a single tool (`submit_response`) whose input schema is the response schema. If the
 * base model id requires an inference profile, the provider retries once with the geographic
 * profile id and remembers that choice for the lifetime of the instance.
 */
export class NovaProvider implements StructuredProvider {
  readonly name = 'nova' as const;
  readonly modelId: string;
  readonly #converse: ConverseFn;
  readonly #profileId: string | null;
  readonly #temperature: number;
  readonly #maxRepairAttempts: number;
  #useProfile = false;

  constructor(options: NovaProviderOptions) {
    this.modelId = options.modelId;
    this.#converse =
      options.converse ??
      createBedrockRuntimeTransport({
        region: options.region,
        ...(options.credentials ? { credentials: options.credentials } : {}),
      }).converse;
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
            inferenceConfig: { maxTokens: request.maxOutputTokens, temperature: this.#temperature },
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
              toolChoice: { tool: { name: SUBMIT_TOOL_NAME } },
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
        if (
          !this.#useProfile &&
          this.#profileId !== null &&
          kind !== 'profile_retry' &&
          isProfileRequiredError(error)
        ) {
          this.#useProfile = true; // cached for every later call on this instance
          kind = 'profile_retry';
          continue;
        }
        return fail(mapped);
      }

      const latencyMs = Math.round(performance.now() - started);
      const usage = {
        inputTokens: output.usage?.inputTokens ?? 0,
        outputTokens: output.usage?.outputTokens ?? 0,
      };
      const record = (outcome: RawModelAttempt['outcome']): void => {
        rawAttempts.push({ provider: 'nova', modelId, kind, outcome, latencyMs, usage, errorName: null });
      };

      if (output.stopReason === 'content_filtered' || output.stopReason === 'guardrail_intervened') {
        record('refusal');
        return fail(new ModelRefusalError(modelId, 'content_filter'));
      }

      const toolUse = findToolUse(output);
      let feedback: string;
      if (toolUse) {
        const outcome = validateStructured(toolUse.toolUse.input, request.zodSchema, request.strict);
        if (outcome.ok) {
          record('ok');
          return { value: outcome.value, modelId, rawAttempts };
        }
        lastIssues = outcome.issues;
        feedback = outcome.feedback;
        if (output.stopReason === 'max_tokens') {
          feedback = `- The tool input was cut off before it was complete. Respond more concisely.\n${feedback}`;
        }
      } else {
        lastIssues = [`(root): no_tool_use:${output.stopReason ?? 'unknown'}`];
        feedback = `- You must call the ${SUBMIT_TOOL_NAME} tool with the complete object.`;
      }
      record('invalid_output');

      if (repairs >= this.#maxRepairAttempts || deadline.remainingMs() < MIN_REPAIR_BUDGET_MS) break;
      repairs += 1;
      kind = 'repair';
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
