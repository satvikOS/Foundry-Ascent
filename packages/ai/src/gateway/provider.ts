import type { z } from 'zod';

import type { Deadline } from './deadline.js';
import { restoreOptionalNulls, type StrictJsonSchema } from './json-schema.js';
import type {
  AttemptOutcome,
  ChatMessage,
  ModelProviderName,
  ModelUsage,
  RawModelAttempt,
  StreamStopReason,
  TextChunkHandler,
} from './types.js';

/** What the router hands to a concrete structured-output provider. */
export interface ProviderRequest<T> {
  system: string;
  messages: readonly ChatMessage[];
  schemaName: string;
  zodSchema: z.ZodType<T>;
  strict: StrictJsonSchema;
  maxOutputTokens: number;
  deadline: Deadline;
  requestId: string;
}

export interface ProviderResult<T> {
  value: T;
  /** Model id actually invoked (may differ from the configured id, e.g. an inference profile). */
  modelId: string;
  rawAttempts: RawModelAttempt[];
}

/** What the router hands to a provider for a streamed plain-text generation. */
export interface ProviderStreamRequest {
  system: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  deadline: Deadline;
  requestId: string;
  /** Called with every text chunk, in order (awaited). */
  onText: TextChunkHandler;
}

export interface ProviderStreamResult {
  text: string;
  /** Model id actually invoked. */
  modelId: string;
  stopReason: StreamStopReason;
  rawAttempts: RawModelAttempt[];
}

/**
 * A structured-output backend. Implementations throw a `ModelGatewayError` whose `rawAttempts`
 * lists every network call they made. Backends that can stream plain text implement `streamText`; their
 * errors set `textDelivered` once any text reached `onText`.
 */
export interface StructuredProvider {
  readonly name: ModelProviderName;
  readonly modelId: string;
  generate<T>(request: ProviderRequest<T>): Promise<ProviderResult<T>>;
  streamText?(request: ProviderStreamRequest): Promise<ProviderStreamResult>;
}

/** Rough token estimate (≈ 4 characters per token) for usage the provider never reported. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** How a stream attempt whose usage the provider never reported ended (see {@link estimatedStreamUsage}). */
export interface UnreportedStreamAttempt {
  readonly outcome: AttemptOutcome;
  /** The provider accepted the request: its stream opened (a response arrived), whatever happened next. */
  readonly opened: boolean;
  /** The request was never sent: the deadline or the caller had already cancelled it. */
  readonly cancelledBeforeSend: boolean;
  /**
   * The model reasons before it writes, and the provider bills the hidden reasoning tokens as output (they
   * never reach the stream, so only the request's output bound says how many there could have been).
   */
  readonly reasoning: boolean;
}

/**
 * Usage of a stream attempt that ended before the provider reported it (cancelled, timed out or failed),
 * estimated so the spend caps stay conservative. Usage the provider did report is always used instead.
 *
 * The attempt is billed once the request reached the provider: its stream opened, text arrived, or it was
 * cut off by our deadline or the caller (`timeout`, `aborted`) after it was sent, while the provider was
 * working on it (a reasoning model can think for many seconds before its first visible word). Nothing is
 * billed for a request the provider refused or never received: throttled, client or configuration errors,
 * a network failure before the stream opened, or a request cancelled before it was sent.
 *
 * Input is estimated from the prompt's characters. Output is the visible text; for a reasoning model it is
 * the request's `maxOutputTokens`, which bounds reasoning and visible output together: the most the attempt
 * can have cost. Like the speech-to-text metering, this errs high rather than letting spend go unmetered.
 */
export function estimatedStreamUsage(
  request: Pick<ProviderStreamRequest, 'system' | 'messages' | 'maxOutputTokens'>,
  generated: string,
  attempt: UnreportedStreamAttempt,
): ModelUsage {
  const reached =
    attempt.opened ||
    generated !== '' ||
    (!attempt.cancelledBeforeSend && (attempt.outcome === 'aborted' || attempt.outcome === 'timeout'));
  if (!reached) return { inputTokens: 0, outputTokens: 0 };
  const visible = estimateTokens(generated);
  return {
    inputTokens:
      estimateTokens(request.system) +
      request.messages.reduce((acc, m) => acc + estimateTokens(m.content), 0),
    outputTokens: attempt.reasoning ? Math.max(visible, request.maxOutputTokens) : visible,
  };
}

/** Minimum remaining budget for a repair attempt to be worth making. */
export const MIN_REPAIR_BUDGET_MS = 1_500;

/** Upper bound on how much invalid output is echoed back to the model in a repair turn. */
const MAX_ECHO_CHARS = 24_000;

export type ValidationOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** `path: code` strings, safe to log. */
      issues: string[];
      /** Human-readable problems for the repair prompt (sent to the model only, never logged). */
      feedback: string;
    };

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.');
}

/** Validates an already-decoded JSON value against the request schema. */
export function validateStructured<T>(
  value: unknown,
  zodSchema: z.ZodType<T>,
  strict: StrictJsonSchema,
): ValidationOutcome<T> {
  const restored = restoreOptionalNulls(value, strict);
  const parsed = zodSchema.safeParse(restored);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.slice(0, 20);
  return {
    ok: false,
    issues: issues.map((issue) => `${formatPath(issue.path)}: ${issue.code}`),
    feedback: issues.map((issue) => `- ${formatPath(issue.path)}: ${issue.message}`).join('\n'),
  };
}

/** Parses model text as JSON (tolerating a Markdown code fence) and validates it. */
export function parseStructuredText<T>(
  text: string,
  zodSchema: z.ZodType<T>,
  strict: StrictJsonSchema,
  truncated: boolean,
): ValidationOutcome<T> {
  let candidate = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenced?.[1] !== undefined) candidate = fenced[1];
  let decoded: unknown;
  try {
    decoded = JSON.parse(candidate);
  } catch {
    return {
      ok: false,
      issues: [truncated ? '(root): truncated_json' : '(root): invalid_json'],
      feedback: truncated
        ? '- The response was cut off before the JSON object was complete. Respond more concisely.'
        : '- The response was not a single valid JSON object.',
    };
  }
  return validateStructured(decoded, zodSchema, strict);
}

export function repairInstruction(schemaName: string, feedback: string): string {
  return [
    `Your previous response did not satisfy the required JSON schema "${schemaName}".`,
    'Problems found:',
    feedback,
    'Return the complete corrected JSON object only, with every required field, and no commentary.',
  ].join('\n');
}

export function echoForRepair(text: string): string {
  return text.length > MAX_ECHO_CHARS ? text.slice(0, MAX_ECHO_CHARS) : text;
}

/** Bedrock/OpenAI-safe schema name. */
export function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'response';
}
