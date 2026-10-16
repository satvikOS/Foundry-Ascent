import { BatchMemoryActionRequest, BatchMemoryActionResponse } from '@foundry/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

/**
 * POST /ventures/:id/memory/batch `{ ids, action }`: keep (approve) or decline (reject) up to 50 pending
 * proposals at once. Returns the items that changed and the ids that were skipped (no longer pending).
 * Every memory list, the overview and the venture's counts are refreshed afterwards.
 */
export function useBatchMemoryAction(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BatchMemoryActionRequest) =>
      api.post(
        path`/ventures/${ventureId}/memory/batch`,
        BatchMemoryActionResponse,
        encodeBody(BatchMemoryActionRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.venture.memoryAll(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.detail(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}
