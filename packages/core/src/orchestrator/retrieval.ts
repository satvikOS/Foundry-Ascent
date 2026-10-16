import { type TurnChannel } from '@foundry/contracts';
import { retrievalRepo, type AppExecutor } from '@foundry/db';

import { type CoreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { type Kit } from '../internal/kit.js';
import { buildEvidencePack, classificationsFor, type EvidencePack } from './evidence.js';
import { type GenerationMeter } from './generate.js';

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
}

/**
 * Most items each store gives a call's turn. A spoken reply is two or three sentences (at most 70 words), and
 * production's call turns carried 20–22 evidence items, about 40 % of a 7–9 k-token prompt that both of the
 * turn's model calls read: more than a spoken reply can use, and more time to the first word. The founder's
 * own memory keeps most of its share; the library, resources and patterns give their best item or two.
 */
export const VOICE_RETRIEVAL_CAPS: CoreConfig['retrieval'] = {
  memory: 6,
  chunks: 3,
  doctrine: 2,
  resources: 1,
  patterns: 1,
};

/**
 * Memory rows read beyond the budget: production's venture memory repeated items up to four times, and a
 * repeated item's slot goes to the next distinct one (`buildEvidencePack`).
 */
const MEMORY_SPARE = 4;

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
  const base = { tenantId: args.tenantId, query: args.query };
  const { ventureId } = args;
  const budgets = retrievalBudgets(args.budgets, args.channel ?? 'text');
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
            limit: budgets.doctrine,
          },
        }
      : {}),
    ...(budgets.resources > 0 ? { resources: { ...base, stage: args.stage, limit: budgets.resources } } : {}),
    ...(budgets.patterns > 0
      ? { patterns: { ...base, personaId: args.personaId, limit: budgets.patterns } }
      : {}),
  });
  return buildEvidencePack(found, args.ventureId, {
    allowPrivateMemory: args.privateOwnerId !== null,
    limits: {
      memory: budgets.memory,
      chunks: budgets.chunks,
      shared: budgets.doctrine,
      resources: budgets.resources,
      patterns: budgets.patterns,
    },
  });
}

/**
 * The query embedding for retrieval, metered once under `meter` (null when embedding fails: retrieval is then
 * lexical only). Started while a turn is admitted, so it overlaps the first status events.
 */
export async function embedRetrievalQuery(
  kit: Kit,
  ctx: RequestContext,
  meter: GenerationMeter,
  text: string,
  signal?: AbortSignal,
): Promise<number[] | null> {
  // A coaching turn's embedding is metered as `embedding`; a test conversation meters all of its calls alike.
  const purpose = meter.purpose === 'turn' ? 'embedding' : meter.purpose;
  try {
    const result = await kit.deps.gateway.embed([text.slice(0, 8_000)], {
      purpose,
      requestId: ctx.requestId,
      ...(signal ? { signal } : {}),
    });
    await kit.recordUsage({
      ctx,
      ventureId: meter.ventureId,
      purpose,
      attempts: [{ modelId: result.modelId, usage: result.usage, costUsd: result.costUsd }],
    });
    return result.vectors[0] ?? null;
  } catch (err) {
    kit.deps.logger.warn('turn.query_embedding_failed', {
      requestId: ctx.requestId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}
