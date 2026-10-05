import { knowledgeRepo, settingsRepo } from '@foundry/db';

import { type RequestContext } from '../context.js';
import { type Kit } from './kit.js';

export interface EmbeddableMemory {
  readonly id: string;
  readonly ventureId: string;
  readonly title: string;
  readonly content: string;
}

/** Same text layout as the backfill (`listMemoryMissingEmbeddings`): title, blank line, content. */
export function memoryEmbeddingText(item: Pick<EmbeddableMemory, 'title' | 'content'>): string {
  return `${item.title}\n\n${item.content}`;
}

/**
 * Embeds memory after commit so hybrid retrieval can use the vector term. Best effort: failures (or the
 * AI kill switch) leave the embedding NULL for the migrate/worker backfill, and lexical retrieval keeps
 * working meanwhile.
 *
 * Runs in the caller's own RLS transactions (no owner-role access on this request path): the settings
 * read and the write go through `app_rls`, and `knowledgeRepo.setMemoryEmbeddings` is status-guarded, so
 * an item deleted meanwhile (content erased) never regains a vector of its old text. Only the usage
 * ledger row is written with the owner role (the ledger is closed to `app_rls`).
 */
export async function embedMemoryBestEffort(
  kit: Kit,
  ctx: RequestContext,
  items: readonly EmbeddableMemory[],
): Promise<void> {
  const usable = items.filter((i) => i.content.trim() !== '' || i.title.trim() !== '');
  if (usable.length === 0) return;
  try {
    const settings = await kit.inRequest(ctx, ({ tx }) => settingsRepo.getPlatformSettings(tx));
    if (!settings.aiEnabled) return;
    const result = await kit.deps.gateway.embed(usable.map(memoryEmbeddingText), {
      purpose: 'embedding',
      requestId: ctx.requestId,
    });
    await kit.recordUsage({
      ctx,
      ventureId: usable[0]?.ventureId ?? null,
      purpose: 'embedding',
      attempts: [{ modelId: result.modelId, usage: result.usage, costUsd: result.costUsd }],
    });
    const vectors = usable.flatMap((item, i) => {
      const embedding = result.vectors[i];
      return embedding?.length === knowledgeRepo.EMBEDDING_DIMENSIONS ? [{ id: item.id, embedding }] : [];
    });
    if (vectors.length === 0) return;
    await kit.inRequest(ctx, ({ tx }) => knowledgeRepo.setMemoryEmbeddings(tx, vectors));
  } catch (err) {
    kit.deps.logger.warn('memory.embedding_deferred', {
      requestId: ctx.requestId,
      items: usable.length,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}
