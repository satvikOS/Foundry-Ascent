import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { queryKeys } from './query-keys';

/**
 * How long a venture's memory list and overview stay fresh. Both change only through this app's own writes
 * (each of which refreshes them at once) and through turns (refreshed by {@link refreshVentureAfterTurn}),
 * so a return to the tab or a page opened again within this time reuses them instead of asking again.
 * Production read `GET /ventures/:id/memory` 93 times in a month for one founder (docs/runbooks/latency.md).
 */
export const VENTURE_DATA_STALE_MS = 5 * 60_000;

/**
 * What a finished turn can change in the venture's cached data: the memory it kept, the overview that counts
 * it, the venture itself, a draft escalation, and the venture's conversations. Not the notebook (written
 * later, by distillation), the documents, the team or the call settings, which a turn never changes.
 */
export function ventureKeysAfterTurn(ventureId: string): QueryKey[] {
  return [
    queryKeys.venture.memoryAll(ventureId),
    queryKeys.venture.overview(ventureId),
    queryKeys.venture.detail(ventureId),
    queryKeys.venture.escalations(ventureId),
    queryKeys.venture.sessions(ventureId),
  ];
}

/**
 * Refreshes what a finished turn changed. A read that started before the turn was saved (e.g. the memory list
 * fetched as the conversation opened) cannot include what the turn added, and an in-flight first fetch is not
 * restarted by invalidation alone: each is cancelled, then fetched again.
 */
export function refreshVentureAfterTurn(client: QueryClient, ventureId: string): void {
  for (const queryKey of ventureKeysAfterTurn(ventureId)) {
    void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
  }
}
