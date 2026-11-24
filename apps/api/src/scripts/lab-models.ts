/**
 * The models benchmark: which reasoning, embedding and rerank models this account may call, and how fast, how good and
 * how expensive each is, before the app uses any of them (docs/runbooks/conversation-lab.md, "Models benchmark";
 * ADR-0024). Candidates are `benchmark` in ops/lab/models.json.
 *
 *   MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1 \
 *   pnpm --filter @foundry/api exec tsx src/scripts/lab-models.ts --budget-usd 2 [--requests 6] [--structured 4]
 *     [--rerank-queries 40] [--out DIR]
 *
 * The conversation lab runs it on GitHub as its `models` suite (ops/lab conversation_lab/models_bench.py, under the
 * lab's role). No app, database or browser.
 *
 * - Access: one tiny call per candidate; a failure is its AWS error code, never fatal.
 * - Reasoning models that answered: streamed coaching requests through the app's gateway (first token, whole answer,
 *   tokens, cost) and the app's annotation schema as structured output (valid on the first answer, after a repair, or
 *   not).
 * - Embedding models that answered: query latency and retrieval quality over the committed benchmark
 *   (@foundry/db/retrieval-benchmark): vector alone and fused with a word search, against the word search alone.
 * - Rerankers that answered: the best embedding's fused top 20, reordered, on a fixed sample of the questions.
 *
 * `--budget-usd` is a hard cap: a call is made only when its worst case still fits beside what was spent and what the
 * calls in flight may still cost. Without MODEL_PROVIDER=bedrock it runs on the mock gateway and hashed embeddings (a
 * plumbing check, free). Prints counts, rates, ids, codes, milliseconds and dollars only; with `--out`, the replies and
 * each question's rankings (synthetic) go to `<DIR>/private/models-benchmark.json`.
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

import { benchmarkMessages, benchmarkSystemPrompt } from './lab-models-prompt.js';

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

async function probeReasoning(clients: Clients, budget: Budget, id: string): Promise<Access> {
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
    return { id, kind: 'reasoning', ok: false, code: failureCode(error), latencyMs: null };
  }
}

async function benchReasoning(
  clients: Clients,
  budget: Budget,
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
          batch.map((p) => `${p.title}\n${p.text}`),
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
      result: result(null, {
        vector: quality(corpus.queries, ranked, { scoresMeanRelevance: true }),
        hybrid: quality(corpus.queries, hybrid, { scoresMeanRelevance: false }),
      }),
    };
  } catch (error) {
    return { hybrid: new Map(), result: result(failureCode(error), empty) };
  }
}

async function probeEmbedding(
  clients: Clients,
  budget: Budget,
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
    return { id, kind: 'embedding', ok: false, code: failureCode(error), latencyMs: null };
  }
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

export interface RerankResult {
  readonly id: string;
  readonly region: string;
  readonly code: string | null;
  readonly ms: { p50: number | null; p95: number | null };
  readonly usdPerThousandQueries: number;
  readonly quality: RetrievalQuality | null;
}

async function benchReranker(
  clients: Clients,
  budget: Budget,
  model: Reranker,
  sample: readonly BenchmarkQuery[],
  candidates: ReadonlyMap<string, readonly Scored[]>,
  texts: ReadonlyMap<string, string>,
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
      break;
    }
  }
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
}

export async function runModelsBenchmark(clients: Clients, candidates: Candidates, options: BenchOptions) {
  const budget = new Budget(options.budgetUsd);
  const passages = benchmarkPassages();
  const queries = benchmarkQueries();
  const { region } = options;

  const access: Access[] = [];
  for (const c of candidates.reasoning) access.push(await probeReasoning(clients, budget, c.id));
  for (const c of candidates.embeddings) {
    access.push(await probeEmbedding(clients, budget, region, c.id, c.dimensions[0] ?? 1024));
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
      access.push({ id: c.id, kind: 'rerank', ok: false, code: failureCode(error), latencyMs: null });
    }
  }
  const may = (id: string): boolean => access.some((a) => a.id === id && a.ok);

  const index = new LexicalIndex(passages);
  const lexical = new Map(queries.map((q) => [q.id, index.search(q.query)] as const));
  const embeddings: EmbeddingResult[] = [];
  /** The best embedding so far by its fused ranking (what a reranker would reorder). */
  let best: Embedded | null = null;
  for (const c of candidates.embeddings.filter((e) => may(e.id))) {
    for (const dimensions of c.dimensions) {
      const embedded = await benchEmbedding(
        clients,
        budget,
        region,
        { id: c.id, dimensions },
        { passages, queries },
        lexical,
      );
      embeddings.push(embedded.result);
      if ((embedded.result.hybrid?.mrr ?? -1) > (best?.result.hybrid?.mrr ?? -1)) best = embedded;
    }
  }

  const sample = sampleQueries(queries, options.rerankQueries);
  const texts = new Map(passages.map((p) => [p.id, `${p.title}\n${p.text}`]));
  const rerankers: RerankResult[] = [];
  const rerankings: Record<string, Record<string, readonly string[]>> = {};
  if (best !== null) {
    for (const c of candidates.rerankers.filter((r) => may(r.id))) {
      const { result, rankings } = await benchReranker(clients, budget, c, sample, best.hybrid, texts);
      rerankers.push(result);
      rerankings[c.id] = Object.fromEntries(
        [...rankings].map(([id, r]) => [id, r.slice(0, 5).map((s) => s.id)]),
      );
    }
  }

  // Last and dearest: whatever the retrieval part left of the budget.
  const system = benchmarkSystemPrompt(passages);
  const reasoning: ReasoningResult[] = [];
  const replies: Reply[] = [];
  for (const c of candidates.reasoning.filter((r) => may(r.id))) {
    for (const effort of c.efforts.length > 0 ? c.efforts : [null]) {
      const run = await benchReasoning(
        clients,
        budget,
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
      rerank: {
        base: best === null ? null : { id: best.result.id, dimensions: best.result.dimensions },
        sample: sample.length,
        before: best === null ? null : quality(sample, best.hybrid, { scoresMeanRelevance: false }),
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
      fused:
        best === null
          ? {}
          : Object.fromEntries([...best.hybrid].map(([id, r]) => [id, r.slice(0, 5).map((s) => s.id)])),
      rerankings,
    },
  };
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
    rerankQueries: 40,
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
  const run = await runModelsBenchmark(live ? bedrockClients(region) : mockClients(), candidates, {
    ...args,
    region,
  });
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
