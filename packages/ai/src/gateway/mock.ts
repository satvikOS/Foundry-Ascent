import type { CoachResponse } from '@foundry/contracts';

import { parseControlBlock, type PromptControl } from '../prompts/control.js';
import { COACH_RESPONSE_SCHEMA_NAME } from '../prompts/version.js';
import { RISK_ESCALATION_MAP, primaryForcedCategory } from '../risk/escalation-map.js';
import {
  ModelOutputInvalidError,
  ModelRefusalError,
  ModelUnavailableError,
  type ModelGatewayError,
} from './errors.js';
import { fnv1a, hashEmbedding } from './hash-embedding.js';
import { toStrictJsonSchema, type JsonObject, type JsonValue } from './json-schema.js';
import { validateStructured } from './provider.js';
import {
  EMBEDDING_DIMENSIONS,
  type ChatMessage,
  type EmbedOptions,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type ModelAttempt,
  type ModelGateway,
  type ModelGatewayInfo,
} from './types.js';

export const MOCK_MODEL_ID = 'mock';
export const MOCK_FALLBACK_MODEL_ID = 'mock-fallback';
export const MOCK_EMBEDDINGS_MODEL_ID = 'mock-embeddings';

/** Scripted outcomes for the next calls (consumed in order). `fallback` succeeds with `fallbackUsed`. */
export type MockScriptedOutcome = 'unavailable' | 'timeout' | 'invalid_output' | 'refusal' | 'fallback';

export interface MockGenerateContext {
  system: string;
  messages: readonly ChatMessage[];
  control: PromptControl | null;
  founderText: string;
  evidenceIds: string[];
}

export interface MockModelGatewayOptions {
  /** Custom value builders by schema name; the default covers `CoachResponse` and generic schemas. */
  fixtures?: Readonly<Record<string, (context: MockGenerateContext) => unknown>>;
}

export interface MockCall {
  kind: 'generate' | 'embed';
  purpose: string;
  requestId: string | null;
  schemaName: string | null;
  count: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function unescapeData(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function lastFounderText(messages: readonly ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  const matches = [...last.content.matchAll(/<founder_message>\n?([\s\S]*?)\n?<\/founder_message>/g)];
  const inner = matches.at(-1)?.[1];
  return unescapeData(inner ?? last.content).trim();
}

function evidenceIdsIn(messages: readonly ChatMessage[], system: string): string[] {
  const ids: string[] = [];
  for (const text of [system, ...messages.map((m) => m.content)]) {
    for (const match of text.matchAll(/<item id="(E\d+)"/g)) {
      const id = match[1];
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Deterministic `CoachResponse` derived from the prompt (mode, risk flags, evidence ids, founder text). */
export function mockCoachResponse(context: MockGenerateContext): CoachResponse {
  const mode = context.control?.mode ?? 'coach';
  const digest = fnv1a(context.founderText).toString(16).padStart(8, '0');
  const [first, second] = context.evidenceIds;
  const cited = [first, second].filter((id): id is string => id !== undefined);
  const flags = context.control?.riskFlags ?? [];
  const forced = primaryForcedCategory(flags) ?? (context.control?.crisis ? 'safety_wellbeing' : null);
  const route = forced ? RISK_ESCALATION_MAP[forced] : null;
  const summary = context.founderText.replace(/\s+/g, ' ').slice(0, 160);

  const claims: CoachResponse['claims'] = [];
  if (cited.length > 0) {
    claims.push({
      text: `The venture record supports this point (${cited.join(', ')}).`,
      kind: 'fact',
      evidence_ids: cited,
    });
  }
  claims.push({
    text: 'The current evidence base is thin, so conclusions are provisional.',
    kind: 'inference',
    evidence_ids: [],
  });
  claims.push({
    text: 'Run a small, cheap test before committing further.',
    kind: 'recommendation',
    evidence_ids: [],
  });

  return {
    mode,
    answer: [
      `Mock ${mode} response (ref ${digest}).`,
      cited.length > 0
        ? `Grounded in ${cited.map((id) => `[${id}]`).join(' ')}.`
        : 'No evidence was available for this turn.',
      route
        ? `This touches a high-risk area (${route.category}); I can only give general information and have flagged it for a human.`
        : '',
      'What evidence do you have so far?',
    ]
      .filter((line) => line !== '')
      .join('\n\n'),
    claims,
    uncertainty: [{ item: 'How representative the available evidence is.', level: 'medium' }],
    challenge: 'What would have to be true for this plan to work?',
    next_actions: [
      { owner: 'founder', action: 'Interview five target customers about this problem.', target_date: null },
    ],
    escalation: route
      ? {
          required: true,
          category: route.category,
          priority: route.priority,
          reason: `Pre-classified high-risk topic: ${forced ?? route.category}.`,
          requested_role: route.requestedRole,
        }
      : { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [
      {
        type: 'hypothesis',
        title: `Founder hypothesis ${digest}`,
        content: summary.length > 0 ? summary : 'Founder shared an update.',
        evidence_ids: cited.slice(0, 1),
        confidence: 0.5,
      },
    ],
    follow_up_questions: ['What have you observed directly, and from how many people?'],
    rehearsal:
      mode === 'rehearse'
        ? {
            counterpart: context.control?.rehearsalCounterpart ?? 'a seed-stage investor',
            line: 'Walk me through the evidence that customers will pay for this.',
            scores: [
              { criterion: 'clarity', score: 3, note: 'The core point is understandable.' },
              { criterion: 'evidence', score: 2, note: 'Claims need supporting data.' },
            ],
            critique: 'Lead with your strongest piece of customer evidence.',
          }
        : null,
  };
}

function resolve(node: JsonObject, root: JsonObject): JsonObject {
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let current: JsonValue = root;
  for (const segment of ref.slice(2).split('/')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return node;
    current = current[segment] ?? null;
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current) ? current : node;
}

function deterministicUuid(seed: string): string {
  const hex = [0, 1, 2, 3].map((i) => fnv1a(`${seed}:${i}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Builds a deterministic value for a (non-strict) JSON schema. Used for schemas without a fixture. */
export function sampleFromJsonSchema(node: JsonObject, root: JsonObject = node, path = '$'): JsonValue {
  const schema = resolve(node, root);
  if ('const' in schema) return schema.const ?? null;
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const objects = branches.filter(
        (b): b is JsonObject => typeof b === 'object' && b !== null && !Array.isArray(b),
      );
      const pick = objects.find((b) => b.type !== 'null') ?? objects[0];
      return pick ? sampleFromJsonSchema(pick, root, path) : null;
    }
  }
  const rawType = schema.type;
  const type = Array.isArray(rawType) ? rawType.find((t) => t !== 'null') : rawType;
  switch (type) {
    case 'object': {
      const out: JsonObject = {};
      const props = schema.properties;
      if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
        for (const [key, child] of Object.entries(props)) {
          if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
            out[key] = sampleFromJsonSchema(child, root, `${path}.${key}`);
          }
        }
      }
      return out;
    }
    case 'array': {
      const items = schema.items;
      const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : 1;
      if (maxItems < 1 || typeof items !== 'object' || items === null || Array.isArray(items)) return [];
      return [sampleFromJsonSchema(items, root, `${path}[0]`)];
    }
    case 'string': {
      switch (schema.format) {
        case 'uuid':
          return deterministicUuid(path);
        case 'date-time':
          return '2026-01-01T00:00:00.000Z';
        case 'date':
          return '2026-01-01';
        case 'email':
          return 'mock@example.com';
        case 'uri':
        case 'url':
          return 'https://example.com/mock';
        default:
          break;
      }
      if (typeof schema.pattern === 'string' && schema.pattern === '^E\\d+$') return 'E1';
      const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
      return 'mock'.padEnd(Math.max(4, min), 'x');
    }
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 1;
    case 'number':
      if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number')
        return (schema.minimum + schema.maximum) / 2;
      return typeof schema.minimum === 'number' ? schema.minimum : 0.5;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

/**
 * Deterministic, offline {@link ModelGateway} for tests and local development. Produces schema-valid
 * values (a prompt-derived `CoachResponse` for coaching turns), stable hash embeddings, records
 * calls, and can be scripted to fail via {@link MockModelGateway.scriptNext}.
 */
export class MockModelGateway implements ModelGateway {
  readonly info: ModelGatewayInfo = {
    provider: 'mock',
    primaryModelId: MOCK_MODEL_ID,
    fallbackModelId: MOCK_FALLBACK_MODEL_ID,
    embeddingsModelId: MOCK_EMBEDDINGS_MODEL_ID,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
  readonly calls: MockCall[] = [];
  readonly #fixtures: Readonly<Record<string, (context: MockGenerateContext) => unknown>>;
  readonly #script: MockScriptedOutcome[] = [];

  constructor(options: MockModelGatewayOptions = {}) {
    this.#fixtures = options.fixtures ?? {};
  }

  /** Queues outcomes for the next `generateStructured` calls. */
  scriptNext(...outcomes: MockScriptedOutcome[]): void {
    this.#script.push(...outcomes);
  }

  #attempt(modelId: string, outcome: ModelAttempt['outcome'], input: number, output: number): ModelAttempt {
    return {
      provider: 'mock',
      modelId,
      kind: 'initial',
      outcome,
      latencyMs: 0,
      usage: { inputTokens: input, outputTokens: output },
      errorName: null,
      costUsd: 0,
    };
  }

  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    this.calls.push({
      kind: 'generate',
      purpose: request.purpose,
      requestId: request.requestId,
      schemaName: request.schemaName,
      count: 1,
    });
    if (request.signal?.aborted) {
      return Promise.reject(new ModelUnavailableError('aborted', MOCK_MODEL_ID));
    }
    const inputTokens =
      estimateTokens(request.system) +
      request.messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    const scripted = this.#script.shift();
    const fail = (error: ModelGatewayError): Promise<never> => {
      error.attempts = [
        this.#attempt(
          MOCK_MODEL_ID,
          error instanceof ModelUnavailableError
            ? error.reason === 'timeout'
              ? 'timeout'
              : 'server_error'
            : error instanceof ModelRefusalError
              ? 'refusal'
              : 'invalid_output',
          inputTokens,
          0,
        ),
      ];
      return Promise.reject(error);
    };
    if (scripted === 'unavailable') return fail(new ModelUnavailableError('server_error', MOCK_MODEL_ID));
    if (scripted === 'timeout') return fail(new ModelUnavailableError('timeout', MOCK_MODEL_ID));
    if (scripted === 'refusal') return fail(new ModelRefusalError(MOCK_MODEL_ID, 'model'));
    if (scripted === 'invalid_output')
      return fail(new ModelOutputInvalidError(MOCK_MODEL_ID, ['(root): scripted']));

    const context: MockGenerateContext = {
      system: request.system,
      messages: request.messages,
      control: parseControlBlock(request.system),
      founderText: lastFounderText(request.messages),
      evidenceIds: evidenceIdsIn(request.messages, request.system),
    };
    const strict = toStrictJsonSchema(request.zodSchema);
    const fixture = this.#fixtures[request.schemaName];
    const candidate: unknown = fixture
      ? fixture(context)
      : request.schemaName === COACH_RESPONSE_SCHEMA_NAME
        ? mockCoachResponse(context)
        : sampleFromJsonSchema(strict.original);
    const outcome = validateStructured(candidate, request.zodSchema, strict);
    if (!outcome.ok) return fail(new ModelOutputInvalidError(MOCK_MODEL_ID, outcome.issues));

    const fallbackUsed = scripted === 'fallback';
    const outputTokens = estimateTokens(JSON.stringify(candidate));
    const attempts = fallbackUsed
      ? [
          this.#attempt(MOCK_MODEL_ID, 'timeout', inputTokens, 0),
          this.#attempt(MOCK_FALLBACK_MODEL_ID, 'ok', inputTokens, outputTokens),
        ]
      : [this.#attempt(MOCK_MODEL_ID, 'ok', inputTokens, outputTokens)];
    return Promise.resolve({
      value: outcome.value,
      modelId: fallbackUsed ? MOCK_FALLBACK_MODEL_ID : MOCK_MODEL_ID,
      fallbackUsed,
      usage: {
        inputTokens: attempts.reduce((acc, a) => acc + a.usage.inputTokens, 0),
        outputTokens,
      },
      costUsd: 0,
      latencyMs: 0,
      attempts,
    });
  }

  embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
    this.calls.push({
      kind: 'embed',
      purpose: options.purpose,
      requestId: options.requestId ?? null,
      schemaName: null,
      count: texts.length,
    });
    if (options.signal?.aborted)
      return Promise.reject(new ModelUnavailableError('aborted', MOCK_EMBEDDINGS_MODEL_ID));
    for (const text of texts) {
      if (typeof text !== 'string' || text.trim() === '') {
        return Promise.reject(new TypeError('embed: every input must be a non-empty string'));
      }
    }
    return Promise.resolve({
      vectors: texts.map((t) => hashEmbedding(t, EMBEDDING_DIMENSIONS)),
      modelId: MOCK_EMBEDDINGS_MODEL_ID,
      usage: { inputTokens: texts.reduce((acc, t) => acc + estimateTokens(t), 0), outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
    });
  }
}
