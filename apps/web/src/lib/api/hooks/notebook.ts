import { NotebookResponse, type VeirNotebook } from '@foundry/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { api, path } from '../client';
import { isApiError } from '../errors';
import { queryKeys } from '../query-keys';

/**
 * GET /ventures/:id/notebook — "What <vEIR> knows about you": unverified AI notes the venture team can
 * see and correct. `null` when the venture has no notebook yet (404), so screens can treat it as
 * optional context (the new-chat greeting uses its `nextOpener`).
 */
export const notebookQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.notebook(ventureId),
    queryFn: async ({ signal }): Promise<VeirNotebook | null> => {
      try {
        return await api.get(path`/ventures/${ventureId}/notebook`, NotebookResponse, { signal });
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });

/** The vEIR notebook for a venture (optional context: errors never block the screen using it). */
export function useNotebook(ventureId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...notebookQueryOptions(ventureId), enabled, retry: false });
}
