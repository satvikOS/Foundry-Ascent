import { retrievalRepo, type AppExecutor } from '@foundry/db';

import { type CoreConfig } from '../config.js';
import { buildEvidencePack, classificationsFor, type EvidencePack } from './evidence.js';

export interface RetrievalArgs {
  readonly tenantId: string;
  readonly ventureId: string;
  /** Assigned persona: its doctrine corpus is searchable. */
  readonly personaId: string;
  readonly stage: string;
  /** Founder text (lexical query). */
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
 * venture first, and the result is re-filtered by {@link buildEvidencePack}.
 */
export async function retrieveEvidence(tx: AppExecutor, args: RetrievalArgs): Promise<EvidencePack> {
  const base = { tenantId: args.tenantId, query: args.query };
  const memory =
    args.budgets.memory > 0
      ? await retrievalRepo.searchVentureMemory(tx, {
          ...base,
          ventureId: args.ventureId,
          embedding: args.embedding,
          limit: args.budgets.memory,
          privateOwnerId: args.privateOwnerId,
        })
      : [];
  const chunks =
    args.budgets.chunks > 0
      ? await retrievalRepo.searchVentureChunks(tx, {
          ...base,
          ventureId: args.ventureId,
          embedding: args.embedding,
          limit: args.budgets.chunks,
        })
      : [];
  const classifications = classificationsFor(args.dataClassCeiling);
  const shared =
    args.budgets.doctrine > 0
      ? await retrievalRepo.searchSharedChunks(tx, {
          ...base,
          embedding: args.embedding,
          personaId: args.personaId,
          ...(classifications === null ? {} : { classifications }),
          limit: args.budgets.doctrine,
        })
      : [];
  const resources =
    args.budgets.resources > 0
      ? await retrievalRepo.searchResources(tx, { ...base, stage: args.stage, limit: args.budgets.resources })
      : [];
  const patterns =
    args.budgets.patterns > 0
      ? await retrievalRepo.searchPatterns(tx, { ...base, limit: args.budgets.patterns })
      : [];
  return buildEvidencePack({ memory, chunks, shared, resources, patterns }, args.ventureId, {
    allowPrivateMemory: args.privateOwnerId !== null,
  });
}
