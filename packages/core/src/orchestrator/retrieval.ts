import { type TurnChannel } from '@foundry/contracts';
import {
  embeddingModelOf,
  retrievalRepo,
  tagAlternate,
  tagEmbedding,
  type AppExecutor,
  type knowledgePack,
} from '@foundry/db';

import { type CoreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { type Kit } from '../internal/kit.js';
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
  /** Other ranking constants, for measurement only (the models benchmark); a turn never passes any. */
  readonly tuning?: retrievalRepo.RetrievalTuning;
  /** Reorders what the shared corpora and the documents returned. Absent (the default): the fused order stands. */
  readonly reranker?: EvidenceReranker | null;
}

/**
 * A model that reads the query with each passage and says how relevant it is (a cross-encoder). Off unless a host
 * passes one; it never adds a passage, and any failure or slowness leaves the fused order.
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

/** Rows read beyond a store's limit when a reranker chooses among them. */
const RERANK_SPARE = 6;

/** `items` in the reranker's order; as they were when it fails, is late, or answers for another number of items. */
export async function rerankItems(
  reranker: EvidenceReranker,
  query: string,
  items: readonly retrievalRepo.RetrievedItem[],
): Promise<readonly retrievalRepo.RetrievedItem[]> {
  if (items.length < 2) return items;
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
      reranker.rerank(
        query,
        items.map((i) => `${i.title}\n${i.excerpt}`),
        { signal: abort.signal },
      ),
      late,
    ]);
    if (scores?.length !== items.length || scores.some((s) => !Number.isFinite(s))) return items;
    return (
      items
        .map((item, i) => ({ item, i, score: scores[i] ?? 0 }))
        // What the play cites stays first, whatever a model thinks of it.
        .sort(
          (a, b) =>
            Number(b.item.lane === 'pinned') - Number(a.item.lane === 'pinned') ||
            b.score - a.score ||
            a.i - b.i,
        )
        .map((x) => x.item)
    );
  } catch {
    return items;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Authorized, scoped hybrid retrieval (system design §7 step 3). Runs under the request's RLS
 * transaction (an application executor is required by type), every venture store filters tenant +
 * venture first, and the result is re-filtered by {@link buildEvidencePack}. Every store is searched in one
 * statement (`retrievalRepo.searchEvidenceStores`): one Data API round trip instead of five.
 */
export async function retrieveEvidence(tx: AppExecutor, args: RetrievalArgs): Promise<EvidencePack> {
  const base = {
    tenantId: args.tenantId,
    query: args.query,
    ...(args.tuning === undefined ? {} : { tuning: args.tuning }),
  };
  const { ventureId } = args;
  const budgets = retrievalBudgets(args.budgets, args.channel ?? 'text');
  // The reference library: only what the founder's own message names, one item (two on a typed turn when they ask
  // for several, never more than one on a call), never an item already cited in this conversation, in slots of its
  // own (`retrievalRepo.REFERENCE_GATE`).
  // With a play, which is evidence itself and brings the note it cites, each gives one at most.
  const single = (args.channel ?? 'text') !== 'text' || args.play != null;
  const referenceLimit = budgets.doctrine > 0 ? (single ? 1 : retrievalRepo.REFERENCE_GATE.limit) : 0;
  const corpusLimit = budgets.doctrine > 0 ? (single ? SINGLE_CORPUS_LIMIT : retrievalRepo.CORPUS_LIMIT) : 0;
  const reranker = args.reranker ?? null;
  const spare = reranker === null ? 0 : RERANK_SPARE;
  const classifications = classificationsFor(args.dataClassCeiling);
  const found = await retrievalRepo.searchEvidenceStores(tx, {
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
      ? { chunks: { ...base, ventureId, embedding: args.embedding, limit: budgets.chunks + spare } }
      : {}),
    ...(budgets.doctrine > 0
      ? {
          shared: {
            ...base,
            embedding: args.embedding,
            personaId: args.personaId,
            ...(classifications === null ? {} : { classifications }),
            limit: budgets.doctrine + SHARED_SPARE + spare,
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
          },
        }
      : {}),
    ...(budgets.resources > 0 ? { resources: { ...base, stage: args.stage, limit: budgets.resources } } : {}),
    ...(budgets.patterns > 0
      ? { patterns: { ...base, personaId: args.personaId, limit: budgets.patterns } }
      : {}),
  });
  const groups =
    reranker === null
      ? found
      : {
          ...found,
          chunks: await rerankItems(reranker, args.query, found.chunks),
          shared: await rerankItems(reranker, args.query, found.shared),
        };
  return buildEvidencePack(groups, args.ventureId, {
    allowPrivateMemory: args.privateOwnerId !== null,
    limits: {
      memory: budgets.memory,
      chunks: budgets.chunks,
      shared:
        budgets.doctrine +
        referenceLimit +
        corpusLimit +
        (args.play == null ? 0 : retrievalRepo.CORPUS_PIN_LIMIT),
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
