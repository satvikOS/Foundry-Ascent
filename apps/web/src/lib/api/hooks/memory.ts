import {
  CreateMemoryRequest,
  CreateMemoryResponse,
  MEMORY_PAGE_MAX,
  MemoryAction,
  MemoryActionResponse,
  MemoryHistoryResponse,
  MemoryItemResponse,
  MemoryListResponse,
  MemoryQuery,
  type MemoryObjectView,
} from '@foundry/contracts';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, apiRequestOrEmpty, createIdempotencyKey, path } from '../client';
import { queryKeys, type MemoryFilters } from '../query-keys';

export type MemoryQueryInput = z.input<typeof MemoryQuery>;

function normaliseFilters(filters: MemoryQueryInput): MemoryFilters {
  const parsed = MemoryQuery.safeParse(filters);
  const value = parsed.success ? parsed.data : {};
  return {
    type: value.type,
    status: value.status,
    q: value.q === '' ? undefined : value.q,
    pinned: value.pinned,
  };
}

/** Pages fetched for one memory list (each page is at most MEMORY_PAGE_MAX items with excerpts). */
export const MEMORY_MAX_PAGES = 10;

/**
 * GET /ventures/:id/memory?type&status&q&pinned&limit&cursor, every page (up to MEMORY_MAX_PAGES): the API
 * pages lists and sends content excerpts so each response stays small; the workspace still sees the whole
 * list. Open an item with {@link useFullMemory} for its full text.
 */
export const memoryQueryOptions = (ventureId: string, filters: MemoryQueryInput = {}) => {
  const normalised = normaliseFilters(filters);
  return queryOptions({
    queryKey: queryKeys.venture.memory(ventureId, normalised),
    queryFn: async ({ signal }) => {
      const items: MemoryObjectView[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MEMORY_MAX_PAGES; page += 1) {
        const result = await api.get(path`/ventures/${ventureId}/memory`, MemoryListResponse, {
          signal,
          query: {
            type: normalised.type,
            status: normalised.status,
            q: normalised.q,
            pinned: normalised.pinned,
            limit: MEMORY_PAGE_MAX,
            cursor,
          },
        });
        items.push(...result.items);
        if (result.nextCursor === null) return { items, nextCursor: null };
        cursor = result.nextCursor;
      }
      return { items, nextCursor: cursor ?? null };
    },
  });
};

/** GET /memory/:id — one item with its full content. */
export const memoryItemQueryOptions = (memoryId: string) =>
  queryOptions({
    queryKey: queryKeys.memory.item(memoryId),
    queryFn: ({ signal }) => api.get(path`/memory/${memoryId}`, MemoryItemResponse, { signal }),
  });

/** True when `content` is a list excerpt (the full text is longer). */
export function isContentExcerpt(memory: Pick<MemoryObjectView, 'content' | 'contentLength'>): boolean {
  return memory.contentLength > memory.content.length;
}

/** The content for display: an excerpt ends with an ellipsis. */
export function displayContent(memory: Pick<MemoryObjectView, 'content' | 'contentLength'>): string {
  return isContentExcerpt(memory) ? `${memory.content.trimEnd()}…` : memory.content;
}

/**
 * The full version of a listed item: fetched with GET /memory/:id when the list only carried an excerpt.
 * `complete` is false until the full text is available (editors must wait for it, or a correction would
 * save the excerpt).
 */
export function useFullMemory(memory: MemoryObjectView | null | undefined): {
  memory: MemoryObjectView | null;
  complete: boolean;
} {
  const needsFetch = memory !== null && memory !== undefined && isContentExcerpt(memory);
  const query = useQuery({ ...memoryItemQueryOptions(memory?.id ?? ''), enabled: needsFetch });
  if (memory === null || memory === undefined) return { memory: null, complete: false };
  if (!needsFetch) return { memory, complete: true };
  return { memory: query.data ?? memory, complete: query.data !== undefined };
}

/** Memory objects for a venture; keeps the previous list visible while filters change. */
export function useMemory(ventureId: string, filters: MemoryQueryInput = {}) {
  return useQuery({
    ...memoryQueryOptions(ventureId, filters),
    select: (data) => data.items,
    placeholderData: keepPreviousData,
  });
}

/** GET /memory/:id/history — append-only correction history. */
export const memoryHistoryQueryOptions = (memoryId: string) =>
  queryOptions({
    queryKey: queryKeys.memory.history(memoryId),
    queryFn: ({ signal }) => api.get(path`/memory/${memoryId}/history`, MemoryHistoryResponse, { signal }),
  });

export function useMemoryHistory(memoryId: string | null | undefined) {
  return useQuery({
    ...memoryHistoryQueryOptions(memoryId ?? ''),
    enabled: Boolean(memoryId),
    select: (data) => data.items,
  });
}

function useInvalidateMemory(ventureId: string) {
  const client = useQueryClient();
  return (memoryId?: string) => {
    void client.invalidateQueries({ queryKey: queryKeys.venture.memoryAll(ventureId) });
    void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
    void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    if (memoryId) {
      void client.invalidateQueries({ queryKey: queryKeys.memory.history(memoryId) });
      void client.invalidateQueries({ queryKey: queryKeys.memory.item(memoryId) });
    }
  };
}

export type CreateMemoryInput = z.input<typeof CreateMemoryRequest>;

/** POST /ventures/:id/memory → 201 `MemoryObjectView`. */
export function useCreateMemory(ventureId: string) {
  const invalidate = useInvalidateMemory(ventureId);
  return useMutation({
    mutationFn: (input: CreateMemoryInput) =>
      api.post(
        path`/ventures/${ventureId}/memory`,
        CreateMemoryResponse,
        encodeBody(CreateMemoryRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: (memory) => {
      invalidate(memory.id);
    },
  });
}

export type MemoryActionInput = z.input<typeof MemoryAction>;

/**
 * PATCH /memory/:id. `approve`, `reject`, `dispute`, `pin`, `unpin` → 200 with the item; `correct` → 200
 * with the NEW version that supersedes it; `delete` → 204 No Content, resolved here as `null`.
 */
export function sendMemoryAction(
  memoryId: string,
  action: MemoryActionInput,
  options: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<MemoryObjectView | null> {
  return apiRequestOrEmpty(path`/memory/${memoryId}`, {
    method: 'PATCH',
    schema: MemoryActionResponse,
    body: encodeBody(MemoryAction, action),
    idempotencyKey: options.idempotencyKey ?? createIdempotencyKey(),
    signal: options.signal,
  });
}

/**
 * PATCH /memory/:id with an action: approve / reject / correct / dispute / pin / unpin / delete.
 * Resolves to the updated (or, for `correct`, the superseding) MemoryObjectView, or `null` after `delete`.
 */
export function useMemoryAction(ventureId: string) {
  const invalidate = useInvalidateMemory(ventureId);
  return useMutation({
    mutationFn: ({ memoryId, action }: { memoryId: string; action: MemoryActionInput }) =>
      sendMemoryAction(memoryId, action),
    onSuccess: (memory, variables) => {
      invalidate(variables.memoryId);
      if (memory && memory.id !== variables.memoryId) invalidate(memory.id);
    },
  });
}
