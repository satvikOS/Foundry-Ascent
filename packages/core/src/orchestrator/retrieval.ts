import { type TurnChannel } from '@foundry/contracts';
import {
  embeddingModelOf,
  knowledgePack,
  retrievalRepo,
  tagAlternate,
  tagEmbedding,
  type AppExecutor,
} from '@foundry/db';

import { type CoreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { type Kit } from '../internal/kit.js';
import { type Decision } from '../path/engine.js';
import { buildEvidencePack, classificationsFor, type EvidencePack, type PlayEvidence } from './evidence.js';
import { type GenerationMeter } from './generate.js';
import { isSocialMessage, MAX_CACHED_QUERY_CHARS, queryEmbeddingCache } from './query-embeddings.js';

export interface RetrievalArgs {
  readonly tenantId: string;
  /**
   * The venture whose specific pool (memory, documents) is searched, or null for none: an EIR studio test
   * conversation draws on the persona's common pool alone.
   */
  readonly ventureId: string | null;
  /** Assigned persona: its knowledge library and published lessons are searchable. */
  readonly personaId: string;
  /** Venture stage (resources tagged for it rank higher); null without a venture. */
  readonly stage: string | null;
  /** Lexical query: the founder's message read in the conversation (`buildRetrievalQuery`). */
  readonly query: string;
  /**
   * The founder's own message, as they wrote or said it: the only text the reference library's relevance gate reads
   * (`retrievalRepo.REFERENCE_GATE`). The vEIR's last question and the venture goal that `query` may add are the
   * coach's words, never a request for a reference.
   */
  readonly founderText: string;
  /**
   * What the conversation is about beyond the founder's message (coaching v3): their earlier messages in it, newest
   * first, and the venture's own words. When the message asks for nothing, a reference item it and the conversation
   * both name may be offered as optional background (`retrievalRepo.REFERENCE_GATE`). Absent: only what they ask for.
   */
  readonly conversation?: {
    readonly earlierFounderTexts: readonly string[];
    readonly venture: string | null;
  };
  /** Query embedding or null (lexical only). */
  readonly embedding: readonly number[] | null;
  readonly dataClassCeiling: 'public' | 'program_internal' | 'venture_private';
  readonly budgets: CoreConfig['retrieval'];
  /** A call's turn draws fewer items ({@link VOICE_RETRIEVAL_CAPS}); default `text`. */
  readonly channel?: TurnChannel;
  /**
   * The principal whose own founder_private items may be retrieved: only for a session that RLS restricts
   * to that principal (see {@link privateRetrievalOwner}); null excludes founder_private items entirely.
   */
  readonly privateOwnerId: string | null;
  /**
   * The turn's conversation: AI memory first learned in it is not retrieved (the history already holds it; see
   * `VentureMemoryQuery.excludeSessionId`), nor a reference-library item already cited in it. Null or absent: none
   * is left out (a test conversation).
   */
  readonly sessionId?: string | null;
  /**
   * When the history window is full: the oldest turn still in view (its `createdAt`). Only memory learned from turns
   * in view is left out; what earlier turns of a long conversation taught comes back. Null: the whole conversation is
   * in view.
   */
  readonly historySince?: string | null;
  /**
   * The play the path chose for this turn: it is the pack's first item, and the corpus sources it cites are always
   * evidence (`EvidencePack.playKeys`). Null or absent: none.
   */
  readonly play?: PlayEvidence | null;
  /**
   * What the path says the turn is about, as topics of the cited corpus (`knowledgePack.CORPUS_TOPICS`; others are
   * ignored), besides what the message itself asks. Absent: the message alone.
   */
  readonly topics?: readonly string[];
  /**
   * Shared notes near the founder's own words, whatever the topics and the vocabulary say of them
   * (`retrievalRepo.SEMANTIC_ADMISSION`), for a turn that asks something. Null or absent: semantic admission is off.
   */
  readonly semantic?: SemanticArgs | null;
  /** Other ranking constants, for measurement only (the models benchmark); a turn never passes any. */
  readonly tuning?: retrievalRepo.RetrievalTuning;
}

export interface SemanticArgs {
  /** {@link asksOf}; null: the turn reads none. */
  readonly asks: 'ask' | 'guarded' | null;
  /** The founder's own words, embedded; null: no note is read (the retrieval query may say more than they did). */
  readonly embedding: readonly number[] | null;
  /** A reranker will choose among the candidates ({@link rerankScores}). */
  readonly reranked?: boolean;
}

/**
 * Whether a turn asks something a shared note may answer, and how plainly; null: it reads none. Nothing on a social, a
 * crisis, a rehearsal or a recall turn, on news, on an idea the venture does not hold, or on "get me organized" (the
 * path itself is the answer). A report asks only beside what it reports.
 */
export function asksOf(
  decision: Pick<Decision, 'kind' | 'open' | 'intent' | 'overview'>,
  founderText: string,
): SemanticArgs['asks'] {
  const seeks = knowledgePack.seeksHelp(founderText);
  if ((decision.kind !== 'coaching' && decision.kind !== 'report') || decision.overview) return null;
  if (decision.kind === 'report') return seeks || decision.open !== null ? 'guarded' : null;
  if (seeks || decision.open === 'ask' || decision.intent !== null) return 'ask';
  return decision.open;
}

/**
 * A model that reads the query with each passage and says how relevant it is (a cross-encoder). Off unless a host
 * passes one; it only chooses among the notes near the founder's words, and any failure or slowness leaves the choice to
 * the similarity.
 */
export interface EvidenceReranker {
  readonly id: string;
  /** Longest wait in milliseconds before the fused order is used. */
  readonly timeoutMs: number;
  /** A relevance score per text, in the order given (higher is better). */
  rerank(
    query: string,
    texts: readonly string[],
    options: { readonly signal: AbortSignal },
  ): Promise<readonly number[]>;
}

/**
 * What the reranker says of the notes near the founder's words (by `refId`); null when there is nothing to choose, or when
 * it fails, is late, or answers for another number of texts: the similarity then chooses.
 */
export async function rerankScores(
  reranker: EvidenceReranker,
  founderText: string,
  found: Pick<retrievalRepo.EvidenceResults, 'shared'>,
): Promise<ReadonlyMap<string, number> | null> {
  const items = found.shared.filter((i) => i.near !== undefined);
  if (!items.some((i) => i.lane === 'semantic')) return null;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(null);
      }, reranker.timeoutMs);
    });
    const scores = await Promise.race([
      reranker.rerank(founderText, items.map(rerankText), { signal: abort.signal }),
      late,
    ]);
    if (scores?.length !== items.length || scores.some((s) => !Number.isFinite(s))) return null;
    return new Map(items.map((item, i) => [item.refId, scores[i] ?? 0]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Longest wait for the reranker, in milliseconds: a later answer leaves the choice to the similarity. */
export const RERANK_TIMEOUT_MS = 600;

/**
 * The gateway's reranker for one turn, metered as the turn's embedding is (the daily caps count it); null when the gateway
 * has none. A request is billed whether or not its answer is waited for, so it is recorded when it is made.
 */
export function turnReranker(
  kit: Kit,
  ctx: RequestContext,
  meter: GenerationMeter,
  tails: Promise<void>[],
): EvidenceReranker | null {
  const { gateway, logger } = kit.deps;
  const { reranker } = gateway;
  if (reranker === undefined) return null;
  return {
    id: reranker.modelId,
    timeoutMs: RERANK_TIMEOUT_MS,
    rerank: async (query, texts, { signal }) => {
      tails.push(
        kit.later(
          kit.recordUsage({
            ctx,
            ventureId: meter.ventureId,
            purpose: meter.purpose === 'turn' ? 'embedding' : meter.purpose,
            attempts: [
              {
                modelId: reranker.modelId,
                usage: { inputTokens: 0, outputTokens: 0 },
                costUsd: reranker.costUsd(texts.length),
              },
            ],
          }),
        ),
      );
      const started = performance.now();
      try {
        const scores = await reranker.rerank(query, texts, signal);
        logger.info('turn.reranked', {
          requestId: ctx.requestId,
          count: texts.length,
          latencyMs: Math.round(performance.now() - started),
        });
        return scores;
      } catch (err) {
        logger.warn('turn.rerank_failed', {
          requestId: ctx.requestId,
          count: texts.length,
          latencyMs: Math.round(performance.now() - started),
          error: err instanceof Error ? err.name : 'unknown',
        });
        throw err;
      }
    },
  };
}

/** What a reranker reads of a note. */
export function rerankText(item: retrievalRepo.RetrievedItem): string {
  return `${item.title}\n${item.excerpt}`;
}

/**
 * Most items each store gives a call's turn. A spoken reply is two or three sentences (at most 70 words), and
 * production's call turns carried 20–22 evidence items, about 40 % of a 7–9 k-token prompt that both of the
 * turn's model calls read: more than a spoken reply can use, and more time to the first word. The founder's
 * own memory keeps most of its share; the library, resources and patterns give their best item or two.
 */
export const VOICE_RETRIEVAL_CAPS: CoreConfig['retrieval'] = {
  memory: 5,
  chunks: 2,
  doctrine: 2,
  resources: 1,
  patterns: 1,
};

/**
 * Memory rows read beyond the budget: production's venture memory repeated items up to four times, and a
 * repeated item's slot goes to the next distinct one (`buildEvidencePack`).
 */
const MEMORY_SPARE = 4;

/** Shared rows read beyond the budget, so a passage that repeats another's slot goes to the next one. */
const SHARED_SPARE = 2;

/** Notes of the cited corpus a message's topics bring: two on a typed turn, one on a call or beside a play. */
export const SINGLE_CORPUS_LIMIT = 1;

/** The budgets of a turn on `channel`: the configured ones, capped on a call. */
export function retrievalBudgets(
  budgets: CoreConfig['retrieval'],
  channel: TurnChannel,
): CoreConfig['retrieval'] {
  if (channel === 'text') return budgets;
  const cap = VOICE_RETRIEVAL_CAPS;
  return {
    memory: Math.min(budgets.memory, cap.memory),
    chunks: Math.min(budgets.chunks, cap.chunks),
    doctrine: Math.min(budgets.doctrine, cap.doctrine),
    resources: Math.min(budgets.resources, cap.resources),
    patterns: Math.min(budgets.patterns, cap.patterns),
  };
}

/**
 * Whose founder_private memory a coaching session may retrieve. A private item may only shape output its
 * author alone can read. Session turns, evidence, recaps and escalation drafts are readable by the whole
 * founder/team (RLS `sessions_read`/`turns_read`), and sampled turns by the assigned EIR; no session
 * privacy mode restricts them to their author (`ephemeral` sessions are team-readable too), so the answer
 * is always null: coaching retrieval never uses founder_private items.
 */
export function privateRetrievalOwner(
  _session: { readonly privacy: 'standard' | 'ephemeral'; readonly startedBy: string },
  _principalId: string,
): string | null {
  return null;
}

/** The slots a turn's shared notes have. */
function noteLimits(args: RetrievalArgs, budgets: CoreConfig['retrieval']) {
  // The reference library: only what the founder's own message names, one item (two on a typed turn when they ask
  // for several, never more than one on a call), never an item already cited in this conversation, in slots of its
  // own (`retrievalRepo.REFERENCE_GATE`).
  // With a play, which is evidence itself and brings the note it cites, each gives one at most.
  const single = (args.channel ?? 'text') !== 'text' || args.play != null;
  return {
    reference: budgets.doctrine > 0 ? (single ? 1 : retrievalRepo.REFERENCE_GATE.limit) : 0,
    corpus: budgets.doctrine > 0 ? (single ? SINGLE_CORPUS_LIMIT : retrievalRepo.CORPUS_LIMIT) : 0,
  };
}

/** Semantic admission as the store reads it; null: the turn reads none. */
function semanticQuery(args: RetrievalArgs): retrievalRepo.SemanticQuery | null {
  if (args.semantic == null) return null;
  return {
    ...args.semantic,
    channel: (args.channel ?? 'text') === 'text' ? 'text' : 'voice',
    sessionId: args.sessionId ?? null,
  };
}

/**
 * Authorized, scoped hybrid retrieval (system design §7 step 3). Runs under the request's RLS
 * transaction (an application executor is required by type), every venture store filters tenant +
 * venture first, and the result is re-filtered by {@link buildEvidencePack}. Every store is searched in one
 * statement (`retrievalRepo.searchEvidenceStores`): one Data API round trip instead of five.
 */
export async function retrieveEvidence(tx: AppExecutor, args: RetrievalArgs): Promise<EvidencePack> {
  return packEvidence(await searchEvidence(tx, args), args);
}

/** What the stores hold for a turn: the candidates {@link packEvidence} chooses from. One statement. */
export async function searchEvidence(
  tx: AppExecutor,
  args: RetrievalArgs,
): Promise<retrievalRepo.EvidenceResults> {
  const base = {
    tenantId: args.tenantId,
    query: args.query,
    ...(args.tuning === undefined ? {} : { tuning: args.tuning }),
  };
  const { ventureId } = args;
  const budgets = retrievalBudgets(args.budgets, args.channel ?? 'text');
  const { reference: referenceLimit, corpus: corpusLimit } = noteLimits(args, budgets);
  const semantic = semanticQuery(args);
  const classifications = classificationsFor(args.dataClassCeiling);
  return retrievalRepo.searchEvidenceStores(tx, {
    ...(ventureId !== null && budgets.memory > 0
      ? {
          memory: {
            ...base,
            ventureId,
            embedding: args.embedding,
            limit: budgets.memory + MEMORY_SPARE,
            privateOwnerId: args.privateOwnerId,
            excludeSessionId: args.sessionId ?? null,
            excludeSessionSince: args.historySince ?? null,
          },
        }
      : {}),
    ...(ventureId !== null && budgets.chunks > 0
      ? { chunks: { ...base, ventureId, embedding: args.embedding, limit: budgets.chunks } }
      : {}),
    ...(budgets.doctrine > 0
      ? {
          shared: {
            ...base,
            embedding: args.embedding,
            personaId: args.personaId,
            ...(classifications === null ? {} : { classifications }),
            limit: budgets.doctrine + SHARED_SPARE,
            corpus: {
              founderText: args.founderText,
              limit: corpusLimit,
              topics: args.topics ?? [],
              play: args.play == null ? null : citingPlay(args.play),
              stage: args.stage,
            },
            ...(referenceLimit > 0
              ? {
                  reference: {
                    founderText: args.founderText,
                    limit: referenceLimit,
                    sessionId: args.sessionId ?? null,
                    ...(args.conversation === undefined ? {} : { context: args.conversation }),
                  },
                }
              : {}),
            ...(semantic === null ? {} : { semantic }),
          },
        }
      : {}),
    ...(budgets.resources > 0 ? { resources: { ...base, stage: args.stage, limit: budgets.resources } } : {}),
    ...(budgets.patterns > 0
      ? { patterns: { ...base, personaId: args.personaId, limit: budgets.patterns } }
      : {}),
  });
}

/**
 * The turn's evidence from what the stores hold: which notes near the founder's words are admitted
 * (`retrievalRepo.admitSemantic`; `scores`: a reranker's), then the isolation filter, the duplicates and the limits
 * ({@link buildEvidencePack}). Pure.
 */
export function packEvidence(
  found: retrievalRepo.EvidenceResults,
  args: RetrievalArgs,
  scores: ReadonlyMap<string, number> | null = null,
): EvidencePack {
  const budgets = retrievalBudgets(args.budgets, args.channel ?? 'text');
  const notes = noteLimits(args, budgets);
  const semantic = semanticQuery(args);
  const shared =
    semantic === null
      ? found.shared
      : retrievalRepo.admitSemantic(found.shared, retrievalRepo.semanticRule(semantic, args.tuning), scores);
  return buildEvidencePack({ ...found, shared }, args.ventureId, {
    allowPrivateMemory: args.privateOwnerId !== null,
    limits: {
      memory: budgets.memory,
      chunks: budgets.chunks,
      shared:
        budgets.doctrine +
        notes.reference +
        notes.corpus +
        (args.play == null ? 0 : retrievalRepo.CORPUS_PIN_LIMIT) +
        shared.filter((i) => i.lane === 'semantic').length,
      resources: budgets.resources,
      patterns: budgets.patterns,
    },
    coreLimit: budgets.doctrine,
    play: args.play ?? null,
    query: args.query,
  });
}

/** The play as its cited notes are chosen by it. */
function citingPlay({ play }: PlayEvidence): knowledgePack.CitingPlay {
  return { title: play.title, text: `${play.answer} ${play.why}`, citations: play.citations };
}

/** Embeds one query with `gateway`, metered; null when it fails. */
async function embedQuery(
  kit: Kit,
  ctx: RequestContext,
  meter: GenerationMeter,
  gateway: Kit['deps']['gateway'],
  text: string,
  signal: AbortSignal | undefined,
  tails: Promise<void>[] | undefined,
): Promise<number[] | null> {
  // A coaching turn's embedding is metered as `embedding`; a test conversation meters all of its calls alike.
  const purpose = meter.purpose === 'turn' ? 'embedding' : meter.purpose;
  try {
    const result = await gateway.embed([text.slice(0, 8_000)], {
      purpose,
      requestId: ctx.requestId,
      ...(signal ? { signal } : {}),
    });
    const recorded = kit.recordUsage({
      ctx,
      ventureId: meter.ventureId,
      purpose,
      attempts: [{ modelId: result.modelId, usage: result.usage, costUsd: result.costUsd }],
    });
    if (tails === undefined) await recorded;
    else tails.push(kit.later(recorded));
    const vector = result.vectors[0];
    return vector === undefined ? null : tagEmbedding(vector, result.modelId);
  } catch (err) {
    kit.deps.logger.warn('turn.query_embedding_failed', {
      requestId: ctx.requestId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * The query embedding for retrieval, metered once under `meter` (null when embedding fails: retrieval is then
 * lexical only). Started while a turn is admitted, so it overlaps the first status events. Nothing is embedded for a
 * message that is only courtesy ({@link isSocialMessage}), and a text embedded before in this process is not embedded
 * again (`query-embeddings.ts`). While the platform changes its embedding model (`CoreDeps.previousEmbeddings`), the
 * query is embedded by both models and each row is compared with its own.
 */
export async function embedRetrievalQuery(
  kit: Kit,
  ctx: RequestContext,
  meter: GenerationMeter,
  text: string,
  signal?: AbortSignal,
  /**
   * The turn's work for the host (`Kit.later`): given, the usage row is recorded there and the vector is returned as
   * soon as the model answered, so waiting for it never needs a database connection; else it is recorded first.
   */
  tails?: Promise<void>[],
  /** The founder's own message, when `text` may add to it (default: `text`). */
  founderText: string = text,
): Promise<number[] | null> {
  if (isSocialMessage(founderText)) return null;
  const { gateway, previousEmbeddings } = kit.deps;
  const cache = text.length <= MAX_CACHED_QUERY_CHARS ? queryEmbeddingCache(gateway) : null;
  const cached = cache?.get(text) ?? null;
  if (cached !== null) return cached;
  const [vector, previous] = await Promise.all([
    embedQuery(kit, ctx, meter, gateway, text, signal, tails),
    previousEmbeddings === undefined
      ? null
      : embedQuery(kit, ctx, meter, previousEmbeddings, text, signal, tails),
  ]);
  if (vector === null) return null;
  const previousModel = embeddingModelOf(previous);
  if (previous !== null && previousModel !== null) {
    tagAlternate(vector, { embedding: previous, modelId: previousModel });
  }
  cache?.set(text, vector);
  return vector;
}
