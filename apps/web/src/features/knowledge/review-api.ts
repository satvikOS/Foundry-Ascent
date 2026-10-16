import {
  BatchMemoryActionRequest,
  BatchMemoryActionResponse,
  type MemoryListResponse,
  type MemoryObjectView,
} from '@foundry/contracts';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '@/lib/api/body';
import { api, createIdempotencyKey, path } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { pluralize } from '@/lib/format';
import { sendMemoryAction } from '@/lib/api/hooks/memory';
import { queryKeys, type MemoryFilters } from '@/lib/api/query-keys';
import { useInvalidateVentureMemory } from '@/features/memory/api';
import { applyMemoryActionToList } from '@/features/memory/optimistic';

export type ReviewAction = BatchMemoryActionRequest['action'];

export interface ReviewResult {
  /** The items that changed. */
  items: MemoryObjectView[];
  /** Items that were no longer waiting for review (someone else handled them) or are gone. */
  skippedIds: string[];
}

/** An API without `POST /ventures/:id/memory/batch` answers 404 (no such endpoint) or 405. */
function isMissingEndpoint(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 405);
}

/** An item another person already decided (409) or that is gone (404) is skipped, as the batch does. */
function isSkippable(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 409);
}

/**
 * Fallback for an API that has no batch endpoint yet: one `PATCH /memory/:id` per item, in order, with
 * the batch endpoint's semantics (handled or missing items are skipped, anything else fails).
 */
async function reviewOneByOne(ids: readonly string[], action: ReviewAction): Promise<ReviewResult> {
  const items: MemoryObjectView[] = [];
  const skippedIds: string[] = [];
  for (const id of ids) {
    try {
      const item = await sendMemoryAction(id, { action });
      if (item) items.push(item);
      else skippedIds.push(id);
    } catch (error) {
      if (!isSkippable(error)) throw error;
      skippedIds.push(id);
    }
  }
  return { items, skippedIds };
}

/**
 * Approve or reject proposals: `POST /ventures/:id/memory/batch`, or one PATCH per item when the API
 * predates the batch endpoint.
 */
export async function reviewMemory(
  ventureId: string,
  ids: readonly string[],
  action: ReviewAction,
): Promise<ReviewResult> {
  try {
    return await api.post(
      path`/ventures/${ventureId}/memory/batch`,
      BatchMemoryActionResponse,
      encodeBody(BatchMemoryActionRequest, { ids: [...ids], action }),
      { idempotencyKey: createIdempotencyKey() },
    );
  } catch (error) {
    if (!isMissingEndpoint(error)) throw error;
  }
  return reviewOneByOne(ids, action);
}

/** Toast copy for a finished review (counts only, never memory content). */
export function reviewMessage(action: ReviewAction, result: ReviewResult): string {
  const done = result.items.length;
  const verb = action === 'approve' ? 'Approved' : 'Rejected';
  const skipped = result.skippedIds.length;
  if (done === 0) return 'Nothing changed: these were already handled.';
  const main = done === 1 ? verb : `${verb} ${done}`;
  return skipped === 0 ? main : `${main}. ${pluralize(skipped, 'item')} had already been handled.`;
}

type MemoryListData = z.infer<typeof MemoryListResponse>;

function filtersFromKey(key: QueryKey): MemoryFilters | undefined {
  const filters = key[4];
  return typeof filters === 'object' && filters !== null ? filters : undefined;
}

export interface ReviewVariables {
  ids: readonly string[];
  action: ReviewAction;
}

/**
 * The one way to approve or reject memory proposals, for one item or many: every cached memory list
 * changes at once (proposals leave the queue), rolls back if the request fails, and the lists, counts
 * and badges refresh when it settles.
 */
export function useMemoryReview(ventureId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidateVentureMemory(ventureId);
  return useMutation({
    mutationFn: ({ ids, action }: ReviewVariables) => reviewMemory(ventureId, ids, action),
    onMutate: async ({ ids, action }) => {
      const scope = { queryKey: queryKeys.venture.memoryAll(ventureId) };
      await client.cancelQueries(scope);
      const snapshots = client.getQueriesData<MemoryListData>(scope);
      for (const [key, data] of snapshots) {
        if (!data) continue;
        let items = data.items;
        for (const id of ids) items = applyMemoryActionToList(items, id, { action }, filtersFromKey(key));
        client.setQueryData<MemoryListData>(key, { ...data, items });
      }
      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.snapshots ?? []) client.setQueryData(key, data);
    },
    onSettled: (_result, _error, { ids }) => {
      invalidate(ids);
    },
  });
}
