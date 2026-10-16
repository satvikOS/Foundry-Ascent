import type { MemoryObjectView } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/errors';
import { memoryItemQueryOptions, useMemory } from '@/lib/api/hooks/memory';

import type { KnowledgeSearch } from './search';

export type SelectedMemory =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; memory: MemoryObjectView }
  /** Deleted, or not this venture's: nothing to show. */
  | { state: 'gone' }
  | { state: 'error'; error: Error; retry: () => void };

/**
 * The memory item open in the Knowledge page's side panel (`?m=`). It is found in the lists on screen
 * (kept memory, the filtered list, proposals) and otherwise fetched with `GET /memory/:id`, so
 * superseded, rejected and expired items, and the "earlier version" a correction replaced, keep their
 * detail and history. Only a 404, or an item of another venture, counts as gone.
 */
export function useSelectedMemory(
  ventureId: string,
  search: Pick<KnowledgeSearch, 'm' | 'type' | 'status' | 'q' | 'pinned'>,
): SelectedMemory {
  const all = useMemory(ventureId);
  const proposed = useMemory(ventureId, { status: 'proposed' });
  // The same filters as the memory list, so this shares its cached query.
  const filtered = useMemory(ventureId, {
    type: search.type,
    status: search.status,
    q: search.q,
    pinned: search.pinned,
  });
  const id = search.m;
  const listed =
    id === undefined
      ? null
      : ([all.data, filtered.data, proposed.data]
          .flatMap((items) => items ?? [])
          .find((item) => item.id === id) ?? null);
  const listsPending = all.isPending || proposed.isPending || filtered.isPending;
  const fetched = useQuery({
    ...memoryItemQueryOptions(id ?? ''),
    enabled: id !== undefined && listed === null && !listsPending,
  });

  if (id === undefined) return { state: 'none' };
  if (listed) return { state: 'ready', memory: listed };
  if (fetched.data) {
    return fetched.data.ventureId === ventureId
      ? { state: 'ready', memory: fetched.data }
      : { state: 'gone' };
  }
  if (fetched.isError) {
    if (isApiError(fetched.error) && fetched.error.status === 404) return { state: 'gone' };
    return { state: 'error', error: fetched.error, retry: () => void fetched.refetch() };
  }
  return { state: 'loading' };
}
