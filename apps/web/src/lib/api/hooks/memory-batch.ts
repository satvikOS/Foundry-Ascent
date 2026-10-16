import { BatchMemoryActionRequest, BatchMemoryActionResponse } from '@foundry/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

/** Most ids one `POST /ventures/:id/memory/batch` takes (`BatchMemoryActionRequest.ids`). */
export const MEMORY_BATCH_MAX = 50;

export interface BatchMemoryActionInput {
  ids: readonly string[];
  action: BatchMemoryActionRequest['action'];
}

/**
 * Keep (approve) or decline (reject) any number of pending proposals: `POST /ventures/:id/memory/batch`,
 * {@link MEMORY_BATCH_MAX} ids per request, one request after another. Returns every item that changed and
 * every id that was skipped (no longer pending). Every memory list, the overview and the venture's counts
 * are refreshed afterwards, also when a later request fails.
 */
export function useBatchMemoryAction(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, action }: BatchMemoryActionInput): Promise<BatchMemoryActionResponse> => {
      const result: BatchMemoryActionResponse = { items: [], skippedIds: [] };
      for (let start = 0; start < ids.length; start += MEMORY_BATCH_MAX) {
        const page = await api.post(
          path`/ventures/${ventureId}/memory/batch`,
          BatchMemoryActionResponse,
          encodeBody(BatchMemoryActionRequest, { ids: ids.slice(start, start + MEMORY_BATCH_MAX), action }),
          { idempotencyKey: createIdempotencyKey() },
        );
        result.items.push(...page.items);
        result.skippedIds.push(...page.skippedIds);
      }
      return result;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.venture.memoryAll(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.detail(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}
