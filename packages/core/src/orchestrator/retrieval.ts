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
  /**
   * The principal whose own founder_private items may be retrieved: only for a session that RLS restricts
   * to that principal (see {@link privateRetrievalOwner}); null excludes founder_private items entirely.
   */
  readonly privateOwnerId: string | null;
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
  const classifications = classificationsFor(args.dataClassCeiling);
  const found = await retrievalRepo.searchEvidenceStores(tx, {
    ...(ventureId !== null && args.budgets.memory > 0
      ? {
          memory: {
            ...base,
            ventureId,
            embedding: args.embedding,
            limit: args.budgets.memory,
            privateOwnerId: args.privateOwnerId,
          },
        }
      : {}),
    ...(ventureId !== null && args.budgets.chunks > 0
      ? { chunks: { ...base, ventureId, embedding: args.embedding, limit: args.budgets.chunks } }
      : {}),
    ...(args.budgets.doctrine > 0
      ? {
          shared: {
            ...base,
            embedding: args.embedding,
            personaId: args.personaId,
            ...(classifications === null ? {} : { classifications }),
            limit: args.budgets.doctrine,
          },
        }
      : {}),
    ...(args.budgets.resources > 0
      ? { resources: { ...base, stage: args.stage, limit: args.budgets.resources } }
      : {}),
    ...(args.budgets.patterns > 0
      ? { patterns: { ...base, personaId: args.personaId, limit: args.budgets.patterns } }
      : {}),
  });
  return buildEvidencePack(found, args.ventureId, { allowPrivateMemory: args.privateOwnerId !== null });
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
