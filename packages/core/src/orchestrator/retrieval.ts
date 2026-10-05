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
  return buildEvidencePack({ memory, chunks, shared, resources, patterns }, args.ventureId);
}
