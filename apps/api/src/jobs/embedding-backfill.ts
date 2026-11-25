import { type ModelGateway, type ModelPurpose, TITAN_MAX_INPUT_CHARS } from '@foundry/ai';
import {
  type Db,
  knowledgeRepo,
  settingsRepo,
  type SystemExecutor,
  tagEmbedding,
  usageRepo,
} from '@foundry/db';

import { errorFields, type Logger } from '../logging.js';

export interface BackfillDeps {
  readonly db: Pick<Db, 'system'>;
  readonly gateway: Pick<ModelGateway, 'embed'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface BackfillOptions {
  readonly requestId: string;
  /** Ledger purpose: `seed` for the deploy-time backfill, `embedding` for the worker. */
  readonly purpose: Extract<ModelPurpose, 'seed' | 'embedding'>;
  /** Stop after this many items (chunks + memory). */
  readonly maxItems: number;
  /** Texts per embedding call. */
  readonly batchSize?: number;
  /** Epoch ms after which no new batch starts. */
  readonly deadline: number;
  /**
   * A change of embedding model (docs/runbooks/embedding-model.md): embed again the rows recorded as another model's,
   * instead of those without a vector. `target` is the model the gateway embeds with (a batch another model answers is
   * not stored); `previous` is recorded on rows whose vector's model is not (embedded before migration 0034).
   */
  readonly reembed?: { readonly target: string; readonly previous: string };
}

export interface BackfillReport {
  readonly chunks: number;
  readonly memory: number;
  /** True when items without embeddings may remain (budget, deadline or a failed batch). */
  readonly remaining: boolean;
  /** Why the backfill stopped early, if it did. */
  readonly stoppedBy:
    'done' | 'max_items' | 'deadline' | 'ai_disabled' | 'spend_cap' | 'embed_failed' | 'model_mismatch';
}

type Kind = 'chunks' | 'memory';

function listBacklog(
  sx: SystemExecutor,
  kind: Kind,
  limit: number,
  target: string | undefined,
): Promise<knowledgeRepo.EmbeddingBacklogItem[]> {
  if (target !== undefined) {
    return kind === 'chunks'
      ? knowledgeRepo.listChunksOfOtherModels(sx, target, limit)
      : knowledgeRepo.listMemoryOfOtherModels(sx, target, limit);
  }
  return kind === 'chunks'
    ? knowledgeRepo.listChunksMissingEmbeddings(sx, limit)
    : knowledgeRepo.listMemoryMissingEmbeddings(sx, limit);
}

/**
 * Embeds knowledge chunks and memory items whose `embedding` is NULL (seed data, ingestion batches whose
 * embedding call failed or was stopped by a spend cap, memory written while AI was paused). Best effort and
 * bounded by item count and a deadline: the gateway call in flight is aborted at the deadline, so a slow
 * batch cannot run past it. Respects the AI kill switch and the global daily spend cap (checked before
 * every batch); writes one usage-ledger row per embedding call. With `reembed`, rows of another embedding model instead
 * (online: each row keeps its old vector until the new one replaces it, and queries compare each row with its own model). Runs with the owner role on server-side
 * data only (no request input).
 */
export async function backfillEmbeddings(
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const now = deps.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 16, 64));
  const counts: Record<Kind, number> = { chunks: 0, memory: 0 };
  const seen = new Set<string>();
  const report = (stoppedBy: BackfillReport['stoppedBy']): BackfillReport => ({
    chunks: counts.chunks,
    memory: counts.memory,
    remaining: stoppedBy !== 'done',
    stoppedBy,
  });

  const settings = await deps.db.system((sx) => settingsRepo.getPlatformSettings(sx), { transaction: false });
  if (!settings.aiEnabled) return report('ai_disabled');

  if (options.reembed !== undefined) {
    const { previous } = options.reembed;
    const stamped = await deps.db.system((sx) => knowledgeRepo.stampEmbeddingModel(sx, previous));
    deps.logger.info('embeddings.model_recorded', { requestId: options.requestId, rows: stamped });
  }

  for (const kind of ['chunks', 'memory'] as const) {
    for (;;) {
      if (counts.chunks + counts.memory >= options.maxItems) return report('max_items');
      if (now() >= options.deadline) return report('deadline');
      const spent = await deps.db.system((sx) => usageRepo.spendToday(sx), { transaction: false });
      if (spent >= settings.dailyUsdCapGlobal) return report('spend_cap');
      const limit = Math.min(batchSize, options.maxItems - counts.chunks - counts.memory);
      const batch = await deps.db.system((sx) => listBacklog(sx, kind, limit, options.reembed?.target), {
        transaction: false,
      });
      const fresh = batch.filter((item) => !seen.has(item.id));
      if (fresh.length === 0) break; // done with this kind (or only items that could not be stored)
      for (const item of fresh) seen.add(item.id);

      let vectors: number[][];
      let modelId: string;
      // Abort the call in flight at the deadline (the caller keeps a margin after it for its response).
      const abort = new AbortController();
      const timer = setTimeout(
        () => {
          abort.abort();
        },
        Math.max(0, options.deadline - now()),
      );
      try {
        const result = await deps.gateway.embed(
          fresh.map((item) => item.text.slice(0, TITAN_MAX_INPUT_CHARS)),
          { purpose: options.purpose, requestId: options.requestId, signal: abort.signal },
        );
        vectors = result.vectors;
        modelId = result.modelId;
        await deps.db.system(
          (sx) =>
            usageRepo.recordUsage(sx, {
              purpose: options.purpose,
              modelId: result.modelId,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              costUsd: result.costUsd,
              requestId: options.requestId,
            }),
          { transaction: false },
        );
      } catch (err) {
        if (abort.signal.aborted) return report('deadline');
        deps.logger.warn('embeddings.backfill_batch_failed', {
          requestId: options.requestId,
          kind,
          items: fresh.length,
          ...errorFields(err),
        });
        return report('embed_failed');
      } finally {
        clearTimeout(timer);
      }

      if (options.reembed !== undefined && modelId !== options.reembed.target)
        return report('model_mismatch');
      const items = fresh.flatMap((item, i) => {
        const embedding = vectors[i];
        return embedding?.length === knowledgeRepo.EMBEDDING_DIMENSIONS
          ? [{ id: item.id, embedding: tagEmbedding(embedding, modelId) }]
          : [];
      });
      // setMemoryEmbeddings is status-guarded: an item deleted meanwhile (content erased) never regains a
      // vector of its old text.
      const stored = await deps.db.system(
        (sx) =>
          kind === 'chunks'
            ? knowledgeRepo.setChunkEmbeddings(sx, items)
            : knowledgeRepo.setMemoryEmbeddings(sx, items),
        { transaction: false },
      );
      counts[kind] += stored;
    }
  }
  return report('done');
}
