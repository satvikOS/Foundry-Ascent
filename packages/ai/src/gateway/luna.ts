import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from 'openai';

import type { Deadline } from './deadline.js';
import {
  ModelRefusalError,
  ModelOutputInvalidError,
  ModelUnavailableError,
  type ModelGatewayError,
} from './errors.js';
import {
  MIN_REPAIR_BUDGET_MS,
  echoForRepair,
  parseStructuredText,
  repairInstruction,
  sanitizeSchemaName,
  type ProviderRequest,
  type ProviderResult,
  type StructuredProvider,
} from './provider.js';
import {
  createSigV4Fetch,
  type AwsCredentialProvider,
  type AwsCredentials,
  type FetchFn,
} from './sigv4-fetch.js';
import type { RawModelAttempt } from './types.js';

export type LunaReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface LunaProviderOptions {
  /** e.g. `openai.gpt-6-luna`. */
  modelId: string;
  region: string;
  /** Default `https://bedrock-mantle.<region>.api.aws/openai/v1`. */
  baseURL?: string;
  credentials?: AwsCredentials | AwsCredentialProvider;
  /** Underlying fetch (the signing wrapper is always applied). For tests. */
  fetch?: FetchFn;
  /** Only sent when set; leave unset unless the model is known to accept it. */
  reasoningEffort?: LunaReasoningEffort;
  /** Repair re-asks after invalid output. Default 1. */
  maxRepairAttempts?: number;
}

export function mantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.constructor.name : null;
}

function causeName(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause: unknown = error.cause;
  return cause instanceof Error ? cause.name : null;
}

/** Maps OpenAI SDK failures to typed gateway errors without copying provider messages. */
export function mapOpenAIError(error: unknown, deadline: Deadline, modelId: string): ModelUnavailableError {
  const name = errorName(error);
  const make = (reason: ConstructorParameters<typeof ModelUnavailableError>[0]): ModelUnavailableError =>
    new ModelUnavailableError(reason, modelId, { cause: error, errorName: name });
  if (deadline.timedOut) return make('timeout');
  if (deadline.callerAborted) return make('aborted');
  if (error instanceof APIConnectionTimeoutError) return make('timeout');
  if (error instanceof APIUserAbortError) return make('aborted');
  if (error instanceof APIConnectionError) {
    return make(causeName(error) === 'CredentialsProviderError' ? 'config' : 'network');
  }
  if (error instanceof RateLimitError) return make('throttled');
  if (error instanceof APIError) {
    const status = (error as APIError).status ?? 0;
    if (status === 408) return make('timeout');
    if (status === 429) return make('throttled');
    if (status >= 500) return make('server_error');
    return make('client_error');
  }
  return make('network');
}

/**
 * Primary reasoning model: OpenAI GPT-6 Luna on the Bedrock Mantle OpenAI-compatible endpoint,
 * Chat Completions with strict JSON-schema structured outputs, SigV4 (service `bedrock-mantle`).
 * SDK retries are disabled; the router owns retry, timeout and fallback policy.
 */
export class LunaProvider implements StructuredProvider {
  readonly name = 'luna' as const;
  readonly modelId: string;
  readonly #client: OpenAI;
  readonly #reasoningEffort: LunaReasoningEffort | undefined;
  readonly #maxRepairAttempts: number;

  constructor(options: LunaProviderOptions) {
    this.modelId = options.modelId;
    this.#reasoningEffort = options.reasoningEffort;
    this.#maxRepairAttempts = Math.max(0, options.maxRepairAttempts ?? 1);
    this.#client = new OpenAI({
      apiKey: 'sigv4', // placeholder: the SDK requires a key; the bearer header is stripped before signing
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: options.baseURL ?? mantleBaseUrl(options.region),
      fetch: createSigV4Fetch({
        region: options.region,
        service: 'bedrock-mantle',
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      maxRetries: 0,
      logLevel: 'off', // the SDK's debug logging would print request bodies
    });
  }

  async generate<T>(request: ProviderRequest<T>): Promise<ProviderResult<T>> {
    const { deadline } = request;
    const rawAttempts: RawModelAttempt[] = [];
    const fail = (error: ModelGatewayError): never => {
      error.rawAttempts = rawAttempts;
      throw error;
    };

    const baseMessages: ChatMessageParam[] = [
      { role: 'system', content: request.system },
      ...request.messages.map((m): ChatMessageParam => ({ role: m.role, content: m.content })),
    ];
    let messages = baseMessages;
    let lastIssues: string[] = [];

    for (let attempt = 0; attempt <= this.#maxRepairAttempts; attempt += 1) {
      if (attempt > 0 && deadline.remainingMs() < MIN_REPAIR_BUDGET_MS) break;
      const params: ChatParams = {
        model: this.modelId,
        messages,
        max_completion_tokens: request.maxOutputTokens,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: sanitizeSchemaName(request.schemaName),
            schema: request.strict.schema,
            strict: true,
          },
        },
        ...(this.#reasoningEffort ? { reasoning_effort: this.#reasoningEffort } : {}),
      };

      const started = performance.now();
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await this.#client.chat.completions.create(params, {
          signal: deadline.signal,
          timeout: Math.max(1, deadline.remainingMs()),
          maxRetries: 0,
        });
      } catch (error) {
        const mapped = mapOpenAIError(error, deadline, this.modelId);
        rawAttempts.push({
          provider: 'luna',
          modelId: this.modelId,
          kind: attempt === 0 ? 'initial' : 'repair',
          outcome: mapped.reason === 'config' ? 'client_error' : mapped.reason,
          latencyMs: Math.round(performance.now() - started),
          usage: { inputTokens: 0, outputTokens: 0 },
          errorName: mapped.errorName,
        });
        return fail(mapped);
      }

      const latencyMs = Math.round(performance.now() - started);
      const usage = {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      };
      const record = (outcome: RawModelAttempt['outcome']): void => {
        rawAttempts.push({
          provider: 'luna',
          modelId: this.modelId, // configured id (the ledger and pricing key), not the echoed model name
          kind: attempt === 0 ? 'initial' : 'repair',
          outcome,
          latencyMs,
          usage,
          errorName: null,
        });
      };

      const choice = completion.choices[0];
      if (!choice) {
        record('invalid_output');
        lastIssues = ['choices: missing'];
        continue;
      }
      if (choice.message.refusal || choice.finish_reason === 'content_filter') {
        record('refusal');
        return fail(new ModelRefusalError(this.modelId, choice.message.refusal ? 'model' : 'content_filter'));
      }

      const content = choice.message.content ?? '';
      const outcome = parseStructuredText(
        content,
        request.zodSchema,
        request.strict,
        choice.finish_reason === 'length',
      );
      if (outcome.ok) {
        record('ok');
        return { value: outcome.value, modelId: this.modelId, rawAttempts };
      }
      record('invalid_output');
      lastIssues = outcome.issues;
      messages = [
        ...baseMessages,
        // An empty assistant turn is rejected by some endpoints; only echo real output.
        ...(content.trim() === '' ? [] : [{ role: 'assistant' as const, content: echoForRepair(content) }]),
        { role: 'user', content: repairInstruction(request.schemaName, outcome.feedback) },
      ];
    }

    return fail(new ModelOutputInvalidError(this.modelId, lastIssues));
  }
}
