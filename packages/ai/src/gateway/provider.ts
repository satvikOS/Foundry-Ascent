import type { z } from 'zod';

import type { Deadline } from './deadline.js';
import { restoreOptionalNulls, type StrictJsonSchema } from './json-schema.js';
import type { ChatMessage, ModelProviderName, RawModelAttempt } from './types.js';

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

/**
 * A structured-output backend. Implementations throw a `ModelGatewayError` whose `rawAttempts`
 * lists every network call they made.
 */
export interface StructuredProvider {
  readonly name: ModelProviderName;
  readonly modelId: string;
  generate<T>(request: ProviderRequest<T>): Promise<ProviderResult<T>>;
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
