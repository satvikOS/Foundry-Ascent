import { type ModelGateway, type ModelPurpose, TITAN_MAX_INPUT_CHARS } from '@foundry/ai';
import { type Db, knowledgeRepo, settingsRepo, usageRepo } from '@foundry/db';

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
}

export interface BackfillReport {
  readonly chunks: number;
  readonly memory: number;
  /** True when items without embeddings may remain (budget, deadline or a failed batch). */
  readonly remaining: boolean;
  /** Why the backfill stopped early, if it did. */
  readonly stoppedBy: 'done' | 'max_items' | 'deadline' | 'ai_disabled' | 'spend_cap' | 'embed_failed';
}

type Kind = 'chunks' | 'memory';

/**
 * Embeds knowledge chunks and memory items whose `embedding` is NULL (seed data, ingestion batches whose
 * embedding call failed or was stopped by a spend cap, memory written while AI was paused). Best effort and
 * bounded by item count and a deadline: the gateway call in flight is aborted at the deadline, so a slow
 * batch cannot run past it. Respects the AI kill switch and the global daily spend cap (checked before
 * every batch); writes one usage-ledger row per embedding call. Runs with the owner role on server-side
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

  for (const kind of ['chunks', 'memory'] as const) {
    for (;;) {
      if (counts.chunks + counts.memory >= options.maxItems) return report('max_items');
      if (now() >= options.deadline) return report('deadline');
      const spent = await deps.db.system((sx) => usageRepo.spendToday(sx), { transaction: false });
      if (spent >= settings.dailyUsdCapGlobal) return report('spend_cap');
      const limit = Math.min(batchSize, options.maxItems - counts.chunks - counts.memory);
      const batch = await deps.db.system(
        (sx) =>
          kind === 'chunks'
            ? knowledgeRepo.listChunksMissingEmbeddings(sx, limit)
            : knowledgeRepo.listMemoryMissingEmbeddings(sx, limit),
        { transaction: false },
      );
      const fresh = batch.filter((item) => !seen.has(item.id));
      if (fresh.length === 0) break; // done with this kind (or only items that could not be stored)
      for (const item of fresh) seen.add(item.id);

      let vectors: number[][];
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

      const items = fresh.flatMap((item, i) => {
        const embedding = vectors[i];
        return embedding?.length === knowledgeRepo.EMBEDDING_DIMENSIONS ? [{ id: item.id, embedding }] : [];
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
