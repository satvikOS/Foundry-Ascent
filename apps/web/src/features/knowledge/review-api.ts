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
import { errorMessage, isApiError } from '@/lib/api/errors';
import { pluralize } from '@/lib/format';
import { sendMemoryAction } from '@/lib/api/hooks/memory';
import { queryKeys } from '@/lib/api/query-keys';
import { filtersFromKey, useInvalidateVentureMemory } from '@/features/memory/api';
import { applyMemoryActionToList } from '@/features/memory/optimistic';

export type ReviewAction = BatchMemoryActionRequest['action'];

export interface ReviewResult {
  /** The items that changed. */
  items: MemoryObjectView[];
  /** Items that were no longer waiting for review (someone else handled them) or are gone. */
  skippedIds: string[];
}

/** Most ids one `POST /ventures/:id/memory/batch` takes (`BatchMemoryActionRequest`); larger selections are sent in parts. */
export const REVIEW_BATCH_MAX = 50;

/** An API without `POST /ventures/:id/memory/batch` answers 404 (no such endpoint) or 405. */
function isMissingEndpoint(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 405);
}

/** An item another person already decided (409) or that is gone (404) is skipped, as the batch does. */
function isSkippable(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 409);
}

/**
 * A review that stopped part of the way: `done` holds what was decided before `cause` stopped it, so the
 * screen keeps those decisions and only the rest is undone.
 */
export class PartialReviewError extends Error {
  readonly done: ReviewResult;
  override readonly cause: unknown;

  constructor(done: ReviewResult, cause: unknown) {
    super('Only part of the review was saved');
    this.name = 'PartialReviewError';
    this.done = done;
    this.cause = cause;
  }
}

/**
 * Fallback for an API that has no batch endpoint yet: one `PATCH /memory/:id` per item, in order, with
 * the batch endpoint's semantics (handled or missing items are skipped, anything else fails). Decisions
 * are added to `done` as they land, so a failure part of the way keeps them.
 */
async function reviewOneByOne(
  ids: readonly string[],
  action: ReviewAction,
  done: ReviewResult,
): Promise<void> {
  for (const id of ids) {
    try {
      const item = await sendMemoryAction(id, { action });
      if (item) done.items.push(item);
      else done.skippedIds.push(id);
    } catch (error) {
      if (!isSkippable(error)) throw error;
      done.skippedIds.push(id);
    }
  }
}

/** The selection in request-sized parts, each validated before anything is sent. */
function batchBodies(ids: readonly string[], action: ReviewAction): BatchMemoryActionRequest[] {
  if (ids.length === 0) return [encodeBody(BatchMemoryActionRequest, { ids: [], action })];
  const bodies: BatchMemoryActionRequest[] = [];
  for (let start = 0; start < ids.length; start += REVIEW_BATCH_MAX) {
    bodies.push(
      encodeBody(BatchMemoryActionRequest, { ids: ids.slice(start, start + REVIEW_BATCH_MAX), action }),
    );
  }
  return bodies;
}

/**
 * Approve or reject proposals: `POST /ventures/:id/memory/batch` in parts of {@link REVIEW_BATCH_MAX},
 * one after another, or one PATCH per item when the API predates the batch endpoint. When a later part
 * fails, the error is a {@link PartialReviewError} carrying what the earlier parts decided.
 */
export async function reviewMemory(
  ventureId: string,
  ids: readonly string[],
  action: ReviewAction,
): Promise<ReviewResult> {
  const bodies = batchBodies(ids, action);
  const done: ReviewResult = { items: [], skippedIds: [] };
  let batchEndpoint = true;
  for (const body of bodies) {
    try {
      if (batchEndpoint) {
        try {
          const result = await api.post(
            path`/ventures/${ventureId}/memory/batch`,
            BatchMemoryActionResponse,
            body,
            { idempotencyKey: createIdempotencyKey() },
          );
          done.items.push(...result.items);
          done.skippedIds.push(...result.skippedIds);
          continue;
        } catch (error) {
          if (!isMissingEndpoint(error)) throw error;
          batchEndpoint = false;
        }
      }
      await reviewOneByOne(body.ids, body.action, done);
    } catch (error) {
      if (done.items.length === 0 && done.skippedIds.length === 0) throw error;
      throw new PartialReviewError(done, error);
    }
  }
  return done;
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

/**
 * Toast copy for a review that failed: what was still decided when only part of it was saved, and the
 * reason (counts and the API's message only, never memory content).
 */
export function reviewFailure(
  action: ReviewAction,
  ids: readonly string[],
  error: unknown,
): { title: string; description: string } {
  if (error instanceof PartialReviewError) {
    const decided = error.done.items.length + error.done.skippedIds.length;
    const saved = reviewMessage(action, error.done);
    return {
      title: `${saved}${saved.endsWith('.') ? '' : '.'} ${pluralize(ids.length - decided, 'item')} couldn’t be updated.`,
      description: errorMessage(error.cause),
    };
  }
  return { title: 'Couldn’t update memory', description: errorMessage(error) };
}

type MemoryListData = z.infer<typeof MemoryListResponse>;

export interface ReviewVariables {
  ids: readonly string[];
  action: ReviewAction;
}

/**
 * The one way to settle memory the vEIR saved as a suggestion before memory was kept automatically (editing
 * such an item keeps it), for one item or many: every cached memory list changes at once, only what failed
 * is rolled back, and the lists and counts refresh when it settles. No screen asks anyone to approve.
 */
export function useMemoryReview(ventureId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidateVentureMemory(ventureId);
  const project = (
    snapshots: [QueryKey, MemoryListData | undefined][],
    ids: readonly string[],
    action: ReviewAction,
  ) => {
    for (const [key, data] of snapshots) {
      if (!data) continue;
      let items = data.items;
      for (const id of ids) items = applyMemoryActionToList(items, id, { action }, filtersFromKey(key));
      client.setQueryData<MemoryListData>(key, { ...data, items });
    }
  };
  return useMutation({
    mutationFn: ({ ids, action }: ReviewVariables) => reviewMemory(ventureId, ids, action),
    onMutate: async ({ ids, action }) => {
      const scope = { queryKey: queryKeys.venture.memoryAll(ventureId) };
      await client.cancelQueries(scope);
      const snapshots = client.getQueriesData<MemoryListData>(scope);
      project(snapshots, ids, action);
      return { snapshots };
    },
    onError: (error, { action }, context) => {
      const snapshots = context?.snapshots ?? [];
      for (const [key, data] of snapshots) client.setQueryData(key, data);
      // Decisions saved before the failure stay on screen; only the rest is undone.
      if (error instanceof PartialReviewError) {
        project(
          snapshots,
          error.done.items.map((item) => item.id),
          action,
        );
      }
    },
    onSettled: (_result, _error, { ids }) => {
      invalidate(ids);
    },
  });
}
