import type { MemoryListResponse, MemoryObjectView } from '@foundry/contracts';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import {
  sendMemoryAction,
  useCreateMemory,
  type CreateMemoryInput,
  type MemoryActionInput,
} from '@/lib/api/hooks/memory';
import { queryKeys, type MemoryFilters } from '@/lib/api/query-keys';

import { applyMemoryActionToList, memoryActionSuccessMessage } from './optimistic';

type MemoryListData = z.infer<typeof MemoryListResponse>;

interface Snapshot {
  key: QueryKey;
  data: MemoryListData | undefined;
}

function filtersFromKey(key: QueryKey): MemoryFilters | undefined {
  // queryKeys.venture.memory(ventureId, filters) → ['fa', 'venture', id, 'memory', filters]
  const filters = key[4];
  return typeof filters === 'object' && filters !== null ? filters : undefined;
}

/** Refresh everything that summarises memory for a venture (lists, overview, nav badge counts). */
export function useInvalidateVentureMemory(ventureId: string) {
  const client = useQueryClient();
  return useCallback(
    (memoryIds: readonly string[] = []) => {
      void client.invalidateQueries({ queryKey: queryKeys.venture.memoryAll(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.detail(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
      for (const id of memoryIds) void client.invalidateQueries({ queryKey: queryKeys.memory.history(id) });
    },
    [client, ventureId],
  );
}

export interface MemoryActionVariables {
  memoryId: string;
  action: MemoryActionInput;
}

/**
 * PATCH /memory/:id with an optimistic update of every cached memory list for the venture: the item
 * changes (or leaves a filtered list such as the proposed queue) immediately, and is rolled back if the
 * request fails. Lists, overview and counts are refetched when the request settles.
 */
export function useOptimisticMemoryAction(ventureId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidateVentureMemory(ventureId);
  return useMutation({
    mutationFn: ({ memoryId, action }: MemoryActionVariables) => sendMemoryAction(memoryId, action),
    onMutate: async ({ memoryId, action }): Promise<{ snapshots: Snapshot[] }> => {
      const scope = { queryKey: queryKeys.venture.memoryAll(ventureId) };
      await client.cancelQueries(scope);
      const snapshots = client
        .getQueriesData<MemoryListData>(scope)
        .map(([key, data]): Snapshot => ({ key, data }));
      for (const { key, data } of snapshots) {
        if (!data) continue;
        client.setQueryData<MemoryListData>(key, {
          ...data,
          items: applyMemoryActionToList(data.items, memoryId, action, filtersFromKey(key)),
        });
      }
      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      for (const { key, data } of context?.snapshots ?? []) client.setQueryData(key, data);
    },
    onSettled: (memory, _error, variables) => {
      invalidate(
        memory && memory.id !== variables.memoryId ? [variables.memoryId, memory.id] : [variables.memoryId],
      );
    },
  });
}

interface RunOptions {
  /** Override the success toast (e.g. a queue that announces progress itself). */
  successMessage?: string | null;
  /** `memory` is the updated item (the new version after `correct`), or `null` after `delete` (204). */
  onSuccess?: (memory: MemoryObjectView | null) => void;
  onError?: (error: unknown) => void;
}

/**
 * Convenience wrapper: runs an optimistic memory action and reports the outcome with a toast and a
 * polite screen-reader announcement (content-free).
 */
export function useMemoryActions(ventureId: string) {
  const mutation = useOptimisticMemoryAction(ventureId);
  const { mutate } = mutation;
  const run = useCallback(
    (memoryId: string, action: MemoryActionInput, options: RunOptions = {}) => {
      mutate(
        { memoryId, action },
        {
          onSuccess: (memory) => {
            const message =
              options.successMessage === undefined
                ? memoryActionSuccessMessage(action.action)
                : options.successMessage;
            if (message) {
              toast.success(message);
              announce(message);
            }
            options.onSuccess?.(memory);
          },
          onError: (error) => {
            toast.error('Couldn’t update memory', { description: errorMessage(error) });
            options.onError?.(error);
          },
        },
      );
    },
    [mutate],
  );
  return { run, mutation, isPending: mutation.isPending, pendingId: mutation.variables?.memoryId ?? null };
}

/** POST /ventures/:id/memory, also refreshing the venture's counts. */
export function useCreateVentureMemory(ventureId: string) {
  const create = useCreateMemory(ventureId);
  const invalidate = useInvalidateVentureMemory(ventureId);
  const { mutateAsync } = create;
  const createMemory = useCallback(
    async (input: CreateMemoryInput) => {
      const memory = await mutateAsync(input);
      invalidate([memory.id]);
      return memory;
    },
    [mutateAsync, invalidate],
  );
  return { createMemory, mutation: create };
}
