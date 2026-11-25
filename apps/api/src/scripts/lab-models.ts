/**
 * The models benchmark: which reasoning, embedding and rerank models this account may call, and how fast, how good and
 * how expensive each is, before the app uses any of them (docs/runbooks/conversation-lab.md, "Models benchmark";
 * ADR-0024). Candidates are `benchmark` in ops/lab/models.json.
 *
 *   MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1 \
 *   pnpm --filter @foundry/api exec tsx src/scripts/lab-models.ts --budget-usd 2 [--requests 6] [--structured 4]
 *     [--rerank-queries 60] [--out DIR]
 *
 * The conversation lab runs it on GitHub as its `models` suite (ops/lab conversation_lab/models_bench.py, under the
 * lab's role). No app, database or browser.
 *
 * - Access: one tiny call per candidate; a failure is its AWS error code, never fatal.
 * - Reasoning models that answered: streamed coaching requests through the app's gateway (first token, whole answer,
 *   tokens, cost) and the app's annotation schema as structured output (valid on the first answer, after a repair, or
 *   not).
 * - Embedding models that answered: query latency and retrieval quality over the committed benchmark
 *   (@foundry/db/retrieval-benchmark: the shared corpus production holds, by the text production embeds): vector alone,
 *   and fused with a word search in memory, against the word search alone.
 * - With a local DATABASE_URL (the lab's own, reset and seeded): production's own search with each model's 1024-dimension
 *   vectors, for every candidate set of fusion weights and floors (./lab-retrieval.ts).
 * - Rerankers that answered: the top 20 of production's ranking with production's embedding model, reordered, on a fixed
 *   sample of the questions: for every question, and only for those whose ranking is ambiguous.
 *
 * `--budget-usd` is a hard cap: a call is made only when its worst case still fits beside what was spent and what the
 * calls in flight may still cost. Without MODEL_PROVIDER=bedrock it runs on the mock gateway and hashed embeddings (a
 * plumbing check, free). Prints counts, rates, ids, codes, milliseconds and dollars only; with `--out`, the replies,
 * each question's rankings (synthetic) and what AWS said when it refused a candidate (account ids masked) go to
 * `<DIR>/private/models-benchmark.json`, which the lab seals.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  CONVERSE_REASONING_EFFORTS,
  CoachAnnotations,
  EMBEDDING_BATCH,
  MockModelGateway,
  awsErrorName,
  costFor,
  createBedrockRuntimeTransport,
  createModelGateway,
  embeddingBody,
  embeddingFamily,
  hashEmbedding,
  isModelGatewayError,
  parseEmbeddings,
  parseRerank,
  priceFor,
  rerankBody,
  type ConverseReasoningEffort,
  type InvokeModelFn,
  type ModelAttempt,
  type ModelGateway,
} from '@foundry/ai';
import { PLAYBOOK } from '@foundry/core';
import { retrievalRepo, type Db } from '@foundry/db';
import {
  LexicalIndex,
  RANKING_DEPTH,
  benchmarkPassages,
  benchmarkQueries,
  fuse,
  lexicalOverlap,
  quality,
  rankByVector,
  sampleQueries,
  type BenchmarkPassage,
  type BenchmarkQuery,
  type RetrievalQuality,
  type Scored,
} from '@foundry/db/retrieval-benchmark';
import { z } from 'zod';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';
import { benchmarkMessages, benchmarkSystemPrompt } from './lab-models-prompt.js';
import {
  benchSearch,
  extraTexts,
  isAmbiguous,
  openRetrievalStore,
  type Candidates as RankedCandidates,
  type EmbeddedCorpus,
  type RetrievalStore,
  type SearchResult,
} from './lab-retrieval.js';

export const MODELS_FILE = fileURLToPath(new URL('../../../../ops/lab/models.json', import.meta.url));

const Candidates = z.object({
  reasoning: z.array(
    z.object({ id: z.string(), efforts: z.array(z.enum(CONVERSE_REASONING_EFFORTS)).max(3) }),
  ),
  embeddings: z.array(z.object({ id: z.string(), dimensions: z.array(z.number().int().positive()).min(1) })),
  rerankers: z.array(
    z.object({ id: z.string(), region: z.string(), usdPerThousandQueries: z.number().positive() }),
  ),
});
export type Candidates = z.infer<typeof Candidates>;

/** Output bound of a streamed reply, of the structured answer, and of an access probe. */
export const STREAM_MAX_TOKENS = 420;
export const STRUCTURED_MAX_TOKENS = 1_600;
const PROBE_MAX_TOKENS = 16;
const CALL_TIMEOUT_MS = 30_000;
/** Queries timed one after the other (the rest go several at once, untimed). */
const TIMED_QUERIES = 40;
const CONCURRENCY = 6;

/** The benchmark's calls, injected in tests. */
export interface Clients {
  readonly gateway: (modelId: string, effort: ConverseReasoningEffort | null) => ModelGateway;
  readonly invoke: (region: string) => InvokeModelFn;
}

/** A hard cap over every call: what was spent, and what calls in flight may still cost. */
export class Budget {
  #spent = 0;
  #reserved = 0;
  #reached = false;
  readonly #byPart = new Map<string, number>();

  constructor(readonly limitUsd: number) {}

  get reached(): boolean {
    return this.#reached;
  }

  get spent(): number {
    return this.#spent;
  }

  part(name: string): number {
    return this.#byPart.get(name) ?? 0;
  }

  /**
   * Runs `call` when its worst case fits, and books what it cost (its worst case when it throws without saying);
   * returns null, the call unmade, once the budget is reached.
   */
  async run<T>(
    part: string,
    worstUsd: number,
    call: () => Promise<T>,
    cost: (result: T) => number,
    costOfFailure: (error: unknown) => number,
  ): Promise<T | null> {
    if (this.#spent + this.#reserved + worstUsd > this.limitUsd) {
      this.#reached = true;
      return null;
    }
    this.#reserved += worstUsd;
    const book = (usd: number): void => {
      this.#spent += usd;
      this.#byPart.set(part, this.part(part) + usd);
    };
    try {
      const result = await call();
      book(cost(result));
      return result;
    } catch (error) {
      book(costOfFailure(error));
      throw error;
    } finally {
      this.#reserved -= worstUsd;
    }
  }
}

/** The AWS error code of a failure (its class name), or the gateway's own code: never a message. */
export function failureCode(error: unknown): string {
  const named = isModelGatewayError(error)
    ? (error.attempts.at(-1)?.errorName ?? error.rawAttempts.at(-1)?.errorName ?? error.code)
    : awsErrorName(error);
  return named !== null && /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(named) ? named : 'Error';
}

/** What AWS said about a refused candidate: private, and never with an account id or a key id. */
export interface Refusal {
  readonly part: 'access' | 'reasoning' | 'embeddings' | 'rerank';
  readonly id: string;
  readonly code: string;
  readonly httpStatus: number | null;
  readonly message: string;
}

/**
 * The provider's own message of a failure, account and key ids masked. It can echo a request (a synthetic one here), so it
 * goes to the sealed private report only: it is what tells a missing permission from a model the account has not been
 * given (a Marketplace subscription, a use-case form), which the code alone does not.
 */
export function failureMessage(error: unknown): string {
  const chain: Error[] = [];
  for (let at: unknown = error; at instanceof Error && chain.length < 6; at = at.cause) chain.push(at);
  // The gateway's own errors never carry the provider's words: the deepest cause does.
  const said = chain.at(-1)?.message ?? '';
  return maskAws(said).slice(0, 1_000);
}

/** `text` without AWS account ids (12 digits), access key ids and session tokens. */
export function maskAws(text: string): string {
  return text
    .replace(/\b\d{4}-?\d{4}-?\d{4}\b/g, '<account>')
    .replace(/\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,20}\b/g, '<key>')
    .replace(/[A-Za-z0-9/+=]{80,}/g, '<token>');
}

function httpStatusOf(error: unknown): number | null {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 6; at = at.cause, depth += 1) {
    const status = (at as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
    if (typeof status === 'number') return status;
  }
  return null;
}

/** Keeps what refused candidates were told. */
class Refusals {
  readonly items: Refusal[] = [];

  add(part: Refusal['part'], id: string, error: unknown): void {
    if (this.items.length >= 60) return;
    this.items.push({
      part,
      id,
      code: failureCode(error),
      httpStatus: httpStatusOf(error),
      message: failureMessage(error),
    });
  }
}

const gatewayFailureCost = (error: unknown): number =>
  isModelGatewayError(error) ? error.attempts.reduce((acc, a) => acc + a.costUsd, 0) : 0;

/** Upper bound of a text's tokens (about 3 characters a token; real English is closer to 4). */
const tokenBound = (chars: number): number => Math.ceil(chars / 3) + 16;

/**
 * The most a reasoning call can be billed: its input at the model's dearest input rate (a prompt-cache write), read
 * again with a first answer for a repair, with the gateway's fallback (the same model) doing the same.
 */
export function reasoningWorstUsd(modelId: string, chars: number, maxTokens: number): number {
  const input = tokenBound(chars);
  const once = costFor(modelId, {
    inputTokens: input,
    outputTokens: maxTokens,
    cacheWriteInputTokens: input,
  });
  const repair = costFor(modelId, {
    inputTokens: input + maxTokens,
    outputTokens: maxTokens * 2,
    cacheWriteInputTokens: input,
  });
  return (once + repair) * 2;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null;
}
const spread = (values: readonly number[]): { p50: number | null; p95: number | null } => ({
  p50: percentile(values, 50),
  p95: percentile(values, 95),
});
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

// ---- Reasoning models ------------------------------------------------------------------------------------------

export interface Access {
  readonly id: string;
  readonly kind: 'reasoning' | 'embedding' | 'rerank';
  readonly ok: boolean;
  readonly code: string | null;
  readonly latencyMs: number | null;
}

export interface ReasoningResult {
  readonly id: string;
  readonly effort: ConverseReasoningEffort | null;
  readonly requests: number;
  readonly failures: number;
  readonly codes: readonly string[];
  readonly firstTokenMs: { p50: number | null; p95: number | null };
  readonly totalMs: { p50: number | null; p95: number | null };
  readonly tokens: { input: number | null; cachedInput: number | null; output: number | null };
  readonly costUsd: { total: number; perRequest: number | null };
  readonly structured: {
    readonly requests: number;
    readonly validFirst: number;
    readonly validRepaired: number;
    readonly failed: number;
    readonly codes: readonly string[];
    readonly totalMs: { p50: number | null; p95: number | null };
    readonly costUsd: number;
  };
  /** Request fields Bedrock refused and the gateway left out (`dropped:temperature`). */
  readonly droppedFields: readonly string[];
}

interface Reply {
  readonly model: string;
  readonly effort: ConverseReasoningEffort | null;
  readonly index: number;
  readonly text: string;
}

const dropped = (attempts: readonly ModelAttempt[]): string[] =>
  attempts
    .filter((a) => a.kind === 'field_retry')
    .flatMap((a) => a.issues ?? [])
    .filter((i) => /^(?:dropped|reasoning_effort):[a-z_]+$/.test(i));

async function probeReasoning(
  clients: Clients,
  budget: Budget,
  refusals: Refusals,
  id: string,
): Promise<Access> {
  const started = performance.now();
  try {
    const result = await budget.run(
      'access',
      reasoningWorstUsd(id, 200, PROBE_MAX_TOKENS),
      () =>
        clients.gateway(id, null).streamText(
          {
            purpose: 'turn',
            system: 'Answer with one word.',
            messages: [{ role: 'user', content: 'Say ok.' }],
            maxOutputTokens: PROBE_MAX_TOKENS,
            timeoutMs: CALL_TIMEOUT_MS,
            requestId: randomUUID(),
          },
          () => undefined,
        ),
      (r) => r.costUsd,
      gatewayFailureCost,
    );
    if (result === null) return { id, kind: 'reasoning', ok: false, code: 'BudgetReached', latencyMs: null };
    return {
      id,
      kind: 'reasoning',
      ok: true,
      code: null,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    refusals.add('access', id, error);
    return { id, kind: 'reasoning', ok: false, code: failureCode(error), latencyMs: null };
  }
}

async function benchReasoning(
  clients: Clients,
  budget: Budget,
  refusals: Refusals,
  candidate: { readonly id: string; readonly effort: ConverseReasoningEffort | null },
  options: { readonly system: string; readonly requests: number; readonly structured: number },
): Promise<{ result: ReasoningResult; replies: Reply[] }> {
  const { id, effort } = candidate;
  const gateway = clients.gateway(id, effort);
  const { system } = options;
  const promptCache = { systemChars: system.length, historyMessages: 0 };
  const chars = (index: number): number =>
    system.length + benchmarkMessages(index).reduce((acc, m) => acc + m.content.length, 0);
  const replies: Reply[] = [];
  const codes: string[] = [];
  const fields: string[] = [];
  const firstToken: number[] = [];
  const total: number[] = [];
  const input: number[] = [];
  const cached: number[] = [];
  const output: number[] = [];
  const costs: number[] = [];
  let requests = 0;
  for (let index = 0; index < options.requests; index += 1) {
    const started = performance.now();
    try {
      const result = await budget.run(
        'reasoning',
        reasoningWorstUsd(id, chars(index), STREAM_MAX_TOKENS),
        () =>
          gateway.streamText(
            {
              purpose: 'turn',
              system,
              messages: benchmarkMessages(index),
              maxOutputTokens: STREAM_MAX_TOKENS,
              timeoutMs: CALL_TIMEOUT_MS,
              promptCache,
              requestId: randomUUID(),
            },
            () => undefined,
          ),
        (r) => r.costUsd,
        gatewayFailureCost,
      );
      if (result === null) break;
      requests += 1;
      fields.push(...dropped(result.attempts));
      if (result.fallbackUsed) codes.push(failedCodeOf(result.attempts));
      if (result.firstTokenMs !== null) firstToken.push(result.firstTokenMs);
      total.push(Math.round(performance.now() - started));
      input.push(result.usage.inputTokens);
      cached.push(result.usage.cacheReadInputTokens ?? 0);
      output.push(result.usage.outputTokens);
      costs.push(result.costUsd);
      replies.push({ model: id, effort, index, text: result.text });
    } catch (error) {
      requests += 1;
      codes.push(failureCode(error));
      refusals.add('reasoning', id, error);
    }
  }

  let structuredRequests = 0;
  let validFirst = 0;
  let validRepaired = 0;
  let structuredCost = 0;
  const structuredCodes: string[] = [];
  const structuredMs: number[] = [];
  const reply = replies[0]?.text ?? 'Send both emails by Friday and ask for a paid month at 40 dollars.';
  const annotate = `${system}\n\n# Now\nThe mentor's reply to the founder's last message is below. Fill in its annotations: the reply's claims with their evidence keys, uncertainty, challenge, next actions, escalation and memory candidates. Add nothing the reply does not say.\n\n${reply}`;
  for (let index = 0; index < options.structured; index += 1) {
    const started = performance.now();
    try {
      const result = await budget.run(
        'reasoning',
        reasoningWorstUsd(id, chars(index) + annotate.length - system.length, STRUCTURED_MAX_TOKENS),
        () =>
          gateway.generateStructured({
            purpose: 'turn',
            system: annotate,
            messages: benchmarkMessages(index),
            schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
            zodSchema: CoachAnnotations,
            maxOutputTokens: STRUCTURED_MAX_TOKENS,
            timeoutMs: CALL_TIMEOUT_MS,
            promptCache,
            requestId: randomUUID(),
          }),
        (r) => r.costUsd,
        gatewayFailureCost,
      );
      if (result === null) break;
      structuredRequests += 1;
      structuredCost += result.costUsd;
      structuredMs.push(Math.round(performance.now() - started));
      fields.push(...dropped(result.attempts));
      if (result.attempts.some((a) => a.outcome === 'invalid_output') || result.fallbackUsed)
        validRepaired += 1;
      else validFirst += 1;
    } catch (error) {
      structuredRequests += 1;
      structuredCost += gatewayFailureCost(error);
      structuredCodes.push(failureCode(error));
      refusals.add('reasoning', id, error);
    }
  }
  return {
    replies,
    result: {
      id,
      effort,
      requests,
      failures: codes.length,
      codes: [...new Set(codes)].sort(),
      firstTokenMs: spread(firstToken),
      totalMs: spread(total),
      tokens: { input: mean(input), cachedInput: mean(cached), output: mean(output) },
      costUsd: {
        total: round(
          costs.reduce((a, b) => a + b, 0),
          6,
        ),
        perRequest: costs.length === 0 ? null : round(costs.reduce((a, b) => a + b, 0) / costs.length, 6),
      },
      structured: {
        requests: structuredRequests,
        validFirst,
        validRepaired,
        failed: structuredCodes.length,
        codes: [...new Set(structuredCodes)].sort(),
        totalMs: spread(structuredMs),
        costUsd: round(structuredCost, 6),
      },
      droppedFields: [...new Set(fields)].sort(),
    },
  };
}

/** Why a first attempt failed and the same model was asked again (the gateway's fallback is the model itself). */
function failedCodeOf(attempts: readonly ModelAttempt[]): string {
  const failed = attempts.find((a) => a.outcome !== 'ok');
  return failed?.errorName ?? failed?.outcome ?? 'Error';
}

// ---- Embedding models ------------------------------------------------------------------------------------------

export interface EmbeddingResult {
  readonly id: string;
  readonly dimensions: number;
  readonly code: string | null;
  readonly queryMs: { p50: number | null; p95: number | null };
  readonly usdPerMillionTokens: number;
  /** Tokens of the whole corpus, and whether the model reported them (else estimated, about 4 characters a token). */
  readonly corpusTokens: number;
  readonly tokensReported: boolean;
  readonly vector: RetrievalQuality | null;
  readonly hybrid: RetrievalQuality | null;
}

interface Embedded {
  readonly result: EmbeddingResult;
  readonly hybrid: ReadonlyMap<string, readonly Scored[]>;
  /** The vectors, when every text was embedded. */
  readonly corpus: EmbeddedCorpus | null;
}

async function embedBatch(
  invoke: InvokeModelFn,
  budget: Budget,
  model: { readonly id: string; readonly dimensions: number },
  texts: readonly string[],
  input: 'query' | 'document',
): Promise<{ vectors: readonly (readonly number[])[]; tokens: number; reported: boolean } | null> {
  const chars = texts.reduce((acc, t) => acc + t.length, 0);
  const worst = costFor(model.id, {
    inputTokens: tokenBound(chars) + 8 * texts.length,
    outputTokens: 0,
  });
  return budget.run(
    'embeddings',
    worst,
    async () => {
      const raw = await invoke(
        { modelId: model.id, body: embeddingBody(model.id, texts, { input, dimensions: model.dimensions }) },
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      const parsed = parseEmbeddings(model.id, raw, { count: texts.length, dimensions: model.dimensions });
      return {
        vectors: parsed.vectors,
        tokens: parsed.inputTokens ?? Math.ceil(chars / 4),
        reported: parsed.inputTokens !== null,
      };
    },
    (r) => costFor(model.id, { inputTokens: r.tokens, outputTokens: 0 }),
    () => 0,
  );
}

class BudgetReachedError extends Error {
  override readonly name = 'BudgetReached';
}

/** Runs `job` over `items`, at most `CONCURRENCY` at a time, in order of the results; the first failure stops it. */
async function pooled<T, R>(items: readonly T[], job: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = await job(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

async function benchEmbedding(
  clients: Clients,
  budget: Budget,
  refusals: Refusals,
  region: string,
  model: { readonly id: string; readonly dimensions: number },
  corpus: { readonly passages: readonly BenchmarkPassage[]; readonly queries: readonly BenchmarkQuery[] },
  lexical: ReadonlyMap<string, readonly Scored[]>,
): Promise<Embedded> {
  const invoke = clients.invoke(region);
  const family = embeddingFamily(model.id);
  const usdPerMillionTokens = round(costFor(model.id, { inputTokens: 1_000_000, outputTokens: 0 }), 4);
  const queryMs: number[] = [];
  let corpusTokens = 0;
  let reported = true;
  const empty = { vector: null, hybrid: null };
  const result = (
    code: string | null,
    measured: Pick<EmbeddingResult, 'vector' | 'hybrid'>,
  ): EmbeddingResult => ({
    id: model.id,
    dimensions: model.dimensions,
    code,
    queryMs: spread(queryMs),
    usdPerMillionTokens,
    corpusTokens,
    tokensReported: reported,
    ...measured,
  });
  const one = async (texts: readonly string[], input: 'query' | 'document') => {
    const answer = await embedBatch(invoke, budget, model, texts, input);
    if (answer === null) throw new BudgetReachedError();
    return answer;
  };
  try {
    const size = family === null ? 1 : EMBEDDING_BATCH[family];
    const batches = Array.from({ length: Math.ceil(corpus.passages.length / size) }, (_, i) =>
      corpus.passages.slice(i * size, (i + 1) * size),
    );
    const indexed = (
      await pooled(batches, async (batch) => {
        const answer = await one(
          batch.map((p) => p.embedText),
          'document',
        );
        corpusTokens += answer.tokens;
        reported &&= answer.reported;
        return batch.map((p, i) => ({ id: p.id, vector: answer.vectors[i] ?? [] }));
      })
    ).flat();
    const vectors = new Map<string, readonly number[]>();
    const ask = async (q: BenchmarkQuery): Promise<void> => {
      vectors.set(q.id, (await one([q.query], 'query')).vectors[0] ?? []);
    };
    const timed = sampleQueries(corpus.queries, TIMED_QUERIES);
    for (const q of timed) {
      const started = performance.now();
      await ask(q);
      queryMs.push(Math.round(performance.now() - started));
    }
    const timedIds = new Set(timed.map((q) => q.id));
    await pooled(
      corpus.queries.filter((q) => !timedIds.has(q.id)),
      ask,
    );
    const ranked = new Map(
      corpus.queries.map((q) => [q.id, rankByVector(vectors.get(q.id) ?? [], indexed)] as const),
    );
    const hybrid = new Map(
      corpus.queries.map((q) => [q.id, fuse([ranked.get(q.id) ?? [], lexical.get(q.id) ?? []])] as const),
    );
    return {
      hybrid,
      corpus: {
        modelId: model.id,
        dimensions: model.dimensions,
        passages: new Map(indexed.map((x) => [x.id, x.vector])),
        queries: vectors,
      },
      result: result(null, {
        vector: quality(corpus.queries, ranked, { scoresMeanRelevance: true }),
        hybrid: quality(corpus.queries, hybrid, { scoresMeanRelevance: false }),
      }),
    };
  } catch (error) {
    refusals.add('embeddings', model.id, error);
    return { hybrid: new Map(), corpus: null, result: result(failureCode(error), empty) };
  }
}

async function probeEmbedding(
  clients: Clients,
  budget: Budget,
  refusals: Refusals,
  region: string,
  id: string,
  dimensions: number,
): Promise<Access> {
  const started = performance.now();
  try {
    const answer = await embedBatch(clients.invoke(region), budget, { id, dimensions }, ['ok'], 'query');
    return answer === null
      ? { id, kind: 'embedding', ok: false, code: 'BudgetReached', latencyMs: null }
      : { id, kind: 'embedding', ok: true, code: null, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    refusals.add('access', id, error);
    return { id, kind: 'embedding', ok: false, code: failureCode(error), latencyMs: null };
  }
}

/** The home tenant's stored texts the benchmark does not have, embedded; null when the model or the budget stopped it. */
async function embedExtras(
  clients: Clients,
  budget: Budget,
  region: string,
  store: RetrievalStore,
  model: { readonly id: string; readonly dimensions: number },
): Promise<ReadonlyMap<string, readonly number[]> | null> {
  const family = embeddingFamily(model.id);
  const size = family === null ? 1 : EMBEDDING_BATCH[family];
  const texts = extraTexts(store);
  const batches = Array.from({ length: Math.ceil(texts.length / size) }, (_, i) =>
    texts.slice(i * size, (i + 1) * size),
  );
  const out = new Map<string, readonly number[]>();
  for (const batch of batches) {
    const answer = await embedBatch(
      clients.invoke(region),
      budget,
      model,
      batch.map((x) => x.text),
      'document',
    );
    if (answer === null) return null;
    batch.forEach((x, i) => out.set(x.id, answer.vectors[i] ?? []));
  }
  return out;
}

// ---- Rerankers -------------------------------------------------------------------------------------------------

type Reranker = Candidates['rerankers'][number];

async function rerank(
  clients: Clients,
  budget: Budget,
  model: Reranker,
  query: string,
  documents: readonly string[],
): Promise<readonly { readonly index: number; readonly score: number }[] | null> {
  // Billed per query: at most 100 documents of 500 tokens (these are 20 short passages).
  const usd = model.usdPerThousandQueries / 1_000;
  return budget.run(
    'rerank',
    usd,
    async () =>
      parseRerank(
        model.id,
        await clients.invoke(model.region)(
          { modelId: model.id, body: rerankBody(model.id, query, documents) },
          AbortSignal.timeout(CALL_TIMEOUT_MS),
        ),
        documents.length,
      ),
    () => usd,
    () => 0,
  );
}

/** A reranker on the same questions, used always and only where the ranking was ambiguous. */
export interface RerankResult {
  readonly id: string;
  readonly region: string;
  readonly code: string | null;
  readonly ms: { p50: number | null; p95: number | null };
  readonly usdPerThousandQueries: number;
  readonly quality: RetrievalQuality | null;
  readonly ambiguousOnly: {
    /** Share of the questions it was used for; what a thousand questions then cost. */
    readonly share: number;
    readonly usdPerThousandQuestions: number;
    readonly quality: RetrievalQuality;
  } | null;
}

async function benchReranker(
  clients: Clients,
  budget: Budget,
  refusals: Refusals,
  model: Reranker,
  sample: readonly BenchmarkQuery[],
  candidates: ReadonlyMap<string, readonly Scored[]>,
  texts: ReadonlyMap<string, string>,
  ambiguous: ReadonlySet<string> | null,
): Promise<{ result: RerankResult; rankings: ReadonlyMap<string, readonly Scored[]> }> {
  const ms: number[] = [];
  const rankings = new Map<string, readonly Scored[]>();
  let code: string | null = null;
  for (const q of sample) {
    const top = (candidates.get(q.id) ?? []).slice(0, RANKING_DEPTH);
    const started = performance.now();
    try {
      const order = await rerank(
        clients,
        budget,
        model,
        q.query,
        top.map((s) => texts.get(s.id) ?? ''),
      );
      if (order === null) throw new BudgetReachedError();
      ms.push(Math.round(performance.now() - started));
      rankings.set(
        q.id,
        order.map(({ index, score }) => ({ id: top[index]?.id ?? '', score })),
      );
    } catch (error) {
      code = failureCode(error);
      refusals.add('rerank', model.id, error);
      break;
    }
  }
  const used = ambiguous === null ? [] : sample.filter((q) => ambiguous.has(q.id));
  return {
    rankings,
    result: {
      id: model.id,
      region: model.region,
      code,
      ms: spread(ms),
      usdPerThousandQueries: model.usdPerThousandQueries,
      // Half a sample is no measure: only a reranker that answered every question is graded.
      quality: code === null ? quality(sample, rankings, { scoresMeanRelevance: true }) : null,
      ambiguousOnly:
        code !== null || ambiguous === null
          ? null
          : {
              share: sample.length === 0 ? 0 : round(used.length / sample.length, 3),
              usdPerThousandQuestions:
                sample.length === 0
                  ? 0
                  : round((model.usdPerThousandQueries * used.length) / sample.length, 3),
              quality: quality(
                sample,
                new Map(
                  sample.map((q) => [
                    q.id,
                    (ambiguous.has(q.id) ? rankings.get(q.id) : candidates.get(q.id)) ?? [],
                  ]),
                ),
                { scoresMeanRelevance: false },
              ),
            },
    },
  };
}

// ---- The run ---------------------------------------------------------------------------------------------------

export interface BenchOptions {
  readonly region: string;
  readonly budgetUsd: number;
  readonly requests: number;
  readonly structured: number;
  readonly rerankQueries: number;
  /** The questions (tests ask fewer); default: the committed ones. */
  readonly queries?: readonly BenchmarkQuery[];
}

/** Production's embedding model at its size: the base a reranker would reorder. */
export const PRODUCTION_EMBEDDING = { id: 'amazon.titan-embed-text-v2:0', dimensions: 1024 } as const;

export async function runModelsBenchmark(
  clients: Clients,
  candidates: Candidates,
  options: BenchOptions,
  /** The lab's own database (reset and seeded) and its home tenant; null: production's search is not measured. */
  database: { readonly db: Db; readonly tenantSlug: string } | null = null,
) {
  const budget = new Budget(options.budgetUsd);
  const refusals = new Refusals();
  const passages = benchmarkPassages(PLAYBOOK.plays);
  const queries = options.queries ?? benchmarkQueries();
  const { region } = options;

  const access: Access[] = [];
  for (const c of candidates.reasoning) access.push(await probeReasoning(clients, budget, refusals, c.id));
  for (const c of candidates.embeddings) {
    access.push(await probeEmbedding(clients, budget, refusals, region, c.id, c.dimensions[0] ?? 1024));
  }
  for (const c of candidates.rerankers) {
    const started = performance.now();
    try {
      const order = await rerank(clients, budget, c, 'what do we charge', ['Set a price.', 'Walk the dog.']);
      access.push(
        order === null
          ? { id: c.id, kind: 'rerank', ok: false, code: 'BudgetReached', latencyMs: null }
          : {
              id: c.id,
              kind: 'rerank',
              ok: true,
              code: null,
              latencyMs: Math.round(performance.now() - started),
            },
      );
    } catch (error) {
      refusals.add('access', c.id, error);
      access.push({ id: c.id, kind: 'rerank', ok: false, code: failureCode(error), latencyMs: null });
    }
  }
  const may = (id: string): boolean => access.some((a) => a.id === id && a.ok);

  const index = new LexicalIndex(passages);
  const lexical = new Map(queries.map((q) => [q.id, index.search(q.query)] as const));
  const embeddings: EmbeddingResult[] = [];
  const store =
    database === null
      ? null
      : await openRetrievalStore(database.db, { passages, queries }, database.tenantSlug);
  const search: SearchResult[] = [];
  const searchKept: Record<string, Record<string, unknown>> = {};
  /** What a reranker reorders: production's ranking with its own model when both were there, else the best fused one. */
  interface Base {
    readonly id: string;
    readonly dimensions: number;
    readonly by: 'search' | 'fused';
    readonly mrr: number;
    readonly rankings: ReadonlyMap<string, readonly Scored[]>;
    readonly ambiguous: ReadonlySet<string> | null;
  }
  let best: Base | null = null;
  let fused: Embedded | null = null;
  for (const c of candidates.embeddings.filter((e) => may(e.id))) {
    for (const dimensions of c.dimensions) {
      const embedded = await benchEmbedding(
        clients,
        budget,
        refusals,
        region,
        { id: c.id, dimensions },
        { passages, queries },
        lexical,
      );
      embeddings.push(embedded.result);
      const mrr = embedded.result.hybrid?.mrr ?? -1;
      if (embedded.corpus !== null && mrr > (fused?.result.hybrid?.mrr ?? -1)) fused = embedded;
      if (embedded.corpus !== null && (best === null || (best.by === 'fused' && mrr > best.mrr))) {
        best = { id: c.id, dimensions, by: 'fused', mrr, rankings: embedded.hybrid, ambiguous: null };
      }
      if (store === null || embedded.corpus === null || dimensions !== PRODUCTION_EMBEDDING.dimensions)
        continue;
      const extras = await embedExtras(clients, budget, region, store, { id: c.id, dimensions });
      if (extras === null) continue;
      const measured = await benchSearch(store, embedded.corpus, extras);
      search.push(measured.result);
      searchKept[c.id] = measured.kept;
      if (c.id === PRODUCTION_EMBEDDING.id) {
        best = {
          id: c.id,
          dimensions,
          by: 'search',
          mrr: measured.result.ranking.default.mrr,
          rankings: measured.candidates,
          ambiguous: ambiguousOf(measured.candidates, retrievalRepo.embeddingProfile(c.id)),
        };
      }
    }
  }

  const sample = sampleQueries(queries, options.rerankQueries);
  const texts = new Map(passages.map((p) => [p.id, `${p.title}\n${p.text}`]));
  const rerankers: RerankResult[] = [];
  const rerankings: Record<string, Record<string, readonly string[]>> = {};
  if (best !== null) {
    for (const c of candidates.rerankers.filter((r) => may(r.id))) {
      const { result, rankings } = await benchReranker(
        clients,
        budget,
        refusals,
        c,
        sample,
        best.rankings,
        texts,
        best.ambiguous,
      );
      rerankers.push(result);
      rerankings[c.id] = Object.fromEntries(
        [...rankings].map(([id, r]) => [id, r.slice(0, 5).map((s) => s.id)]),
      );
    }
  }

  // Last and dearest: whatever the retrieval part left of the budget.
  const system = benchmarkSystemPrompt(benchmarkPassages());
  const reasoning: ReasoningResult[] = [];
  const replies: Reply[] = [];
  for (const c of candidates.reasoning.filter((r) => may(r.id))) {
    for (const effort of c.efforts.length > 0 ? c.efforts : [null]) {
      const run = await benchReasoning(
        clients,
        budget,
        refusals,
        { id: c.id, effort },
        { system, requests: options.requests, structured: options.structured },
      );
      reasoning.push(run.result);
      replies.push(...run.replies);
    }
  }

  return {
    report: {
      budgetUsd: options.budgetUsd,
      budgetReached: budget.reached,
      corpus: {
        passages: passages.length,
        characters: passages.reduce((acc, p) => acc + p.title.length + p.text.length, 0),
        queries: queries.length,
        answerable: queries.filter((q) => q.kind === 'answerable').length,
        noAnswer: queries.filter((q) => q.kind === 'no_answer').length,
      },
      access,
      reasoning,
      lexical: quality(queries, lexical, { scoresMeanRelevance: true }),
      embeddings,
      search,
      rerank: {
        base: best === null ? null : { id: best.id, dimensions: best.dimensions, by: best.by },
        sample: sample.length,
        before: best === null ? null : quality(sample, best.rankings, { scoresMeanRelevance: false }),
        models: rerankers,
      },
      costUsd: {
        total: round(budget.spent, 6),
        access: round(budget.part('access'), 6),
        reasoning: round(budget.part('reasoning'), 6),
        embeddings: round(budget.part('embeddings'), 6),
        rerank: round(budget.part('rerank'), 6),
      },
    },
    private: {
      replies,
      refusals: refusals.items,
      fused:
        fused === null
          ? {}
          : Object.fromEntries([...fused.hybrid].map(([id, r]) => [id, r.slice(0, 5).map((s) => s.id)])),
      search: searchKept,
      rerankings,
    },
  };
}

function ambiguousOf(
  candidates: RankedCandidates,
  profile: retrievalRepo.EmbeddingProfile,
): ReadonlySet<string> {
  return new Set([...candidates].filter(([, ranked]) => isAmbiguous(ranked, profile)).map(([id]) => id));
}

// ---- Clients ---------------------------------------------------------------------------------------------------

function bedrockClients(region: string): Clients {
  const transports = new Map<string, ReturnType<typeof createBedrockRuntimeTransport>>();
  const transport = (where: string) => {
    const known = transports.get(where) ?? createBedrockRuntimeTransport({ region: where });
    transports.set(where, known);
    return known;
  };
  const gateways = new Map<string, ModelGateway>();
  return {
    // Primary and fallback are the model under test: a failure cannot hide behind another model's answer.
    gateway: (modelId, effort) => {
      const key = `${modelId}|${effort ?? ''}`;
      const known =
        gateways.get(key) ??
        createModelGateway({
          provider: 'bedrock',
          region,
          primaryModelId: modelId,
          fallbackModelId: modelId,
          embeddingsModelId: 'amazon.titan-embed-text-v2:0',
          transports: {
            converse: transport(region).converse,
            converseStream: transport(region).converseStream,
            invokeModel: transport(region).invokeModel,
          },
          ...(effort === null ? {} : { reasoningEffort: effort }),
        });
      gateways.set(key, known);
      return known;
    },
    invoke: (where) => transport(where).invokeModel,
  };
}

/** The dry run's clients: the mock gateway, hashed embeddings and word-overlap reranking (no network, no cost). */
export function mockClients(): Clients {
  const gateway = new MockModelGateway();
  const invoke: InvokeModelFn = ({ modelId, body }) => {
    const request = JSON.parse(body) as {
      inputText?: string;
      dimensions?: number;
      texts?: string[];
      output_dimension?: number;
      singleEmbeddingParams?: { embeddingDimension: number; text: { value: string } };
      query?: string;
      documents?: string[];
    };
    const { query, documents } = request;
    if (query !== undefined && documents !== undefined) {
      return Promise.resolve(
        JSON.stringify({
          results: documents.map((d, i) => ({ index: i, relevance_score: lexicalOverlap(query, d) })),
        }),
      );
    }
    const family = embeddingFamily(modelId);
    const answer =
      family === 'titan'
        ? {
            embedding: hashEmbedding(request.inputText ?? '', request.dimensions),
            inputTextTokenCount: Math.ceil((request.inputText ?? '').length / 4),
          }
        : family === 'cohere'
          ? {
              embeddings: {
                float: (request.texts ?? []).map((t) => hashEmbedding(t, request.output_dimension)),
              },
            }
          : {
              embeddings: [
                {
                  embedding: hashEmbedding(
                    request.singleEmbeddingParams?.text.value ?? '',
                    request.singleEmbeddingParams?.embeddingDimension,
                  ),
                },
              ],
            };
    return Promise.resolve(JSON.stringify(answer));
  };
  return { gateway: () => gateway, invoke: () => invoke };
}

// ---- Command line ----------------------------------------------------------------------------------------------

/** A wrong command line: its message names flags only, so it is printed. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Most a run may spend (the owner's cap on a paid run). */
export const MAX_BUDGET_USD = 2;

export function parseArgs(argv: readonly string[]): Omit<BenchOptions, 'region'> & { out: string | null } {
  const args = {
    budgetUsd: MAX_BUDGET_USD,
    requests: 6,
    structured: 4,
    rerankQueries: 60,
    out: null as string | null,
  };
  const count = (flag: string, value: string, max: number): number => {
    if (!/^\d{1,3}$/.test(value) || Number(value) > max)
      throw new UsageError(`${flag} is 0 to ${String(max)}`);
    return Number(value);
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    switch (flag) {
      case '--budget-usd':
        args.budgetUsd = Number.parseFloat(value);
        break;
      case '--requests':
        args.requests = count(flag, value, 20);
        break;
      case '--structured':
        args.structured = count(flag, value, 20);
        break;
      case '--rerank-queries':
        args.rerankQueries = count(flag, value, 200);
        break;
      case '--out':
        args.out = value;
        break;
      default:
        throw new UsageError(`unknown argument ${flag}`);
    }
  }
  if (!Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0 || args.budgetUsd > MAX_BUDGET_USD) {
    throw new UsageError(`--budget-usd is above 0 and at most ${String(MAX_BUDGET_USD)}`);
  }
  return args;
}

export async function loadCandidates(path: string = MODELS_FILE): Promise<Candidates> {
  const file = JSON.parse(await readFile(path, 'utf8')) as { benchmark?: unknown };
  const candidates = Candidates.parse(file.benchmark);
  // The budget is only as good as the prices: an unpriced candidate is a mistake in the file, found before any call.
  for (const { id } of [...candidates.reasoning, ...candidates.embeddings]) {
    if (!priceFor(id).known) throw new UsageError(`no price for ${id}`);
  }
  for (const { id, dimensions } of candidates.embeddings) {
    for (const size of dimensions) embeddingBody(id, ['ok'], { input: 'query', dimensions: size });
  }
  return candidates;
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const candidates = await loadCandidates();
  const live = process.env.MODEL_PROVIDER === 'bedrock';
  const region = process.env.BEDROCK_REGION ?? 'us-east-1';
  const started = performance.now();
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const url = env.DATABASE_URL?.trim() ?? '';
  // Only a database of the lab's own: the benchmark's passages and every vector in it are replaced.
  const refused = url === '' ? 'none' : refusal(env);
  if (url !== '' && refused !== null) throw new UsageError(`not the lab's own database (${refused})`);
  const db = url === '' ? null : createDatabase(env);
  const slug = env.HOME_TENANT_SLUG?.trim() ?? '';
  const run = await runModelsBenchmark(
    live ? bedrockClients(region) : mockClients(),
    candidates,
    { ...args, region },
    db === null ? null : { db, tenantSlug: slug === '' ? 'ain' : slug },
  ).finally(() => db?.close());
  const report = {
    provider: live ? 'bedrock' : 'mock',
    wallMs: Math.round(performance.now() - started),
    ...run.report,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.out !== null) {
    const dir = join(args.out, 'private');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'models-benchmark.json'),
      `${JSON.stringify({ report, ...run.private }, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && /lab-models\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // Only a usage error's message is printed: anything else may echo a prompt or a provider message.
    process.stderr.write(
      `lab-models: ${err instanceof UsageError ? err.message : err instanceof Error ? err.name : 'error'}\n`,
    );
    process.exitCode = 1;
  });
}
