import type { MemoryObjectView } from '@foundry/contracts';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { memoryQueryOptions } from '@/lib/api/hooks/memory';

import type { KnowledgeSearch } from './search';
import { useSelectedMemory } from './selected-memory';
import { json, problem, stubFetch, testQueryClient, urlOf } from './test-utils';
import { IDS, makeMemory } from './testing';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

const kept = makeMemory({ id: IDS.memory, status: 'confirmed' });

function seededClient(lists: { all?: MemoryObjectView[]; filtered?: [KnowledgeSearch, MemoryObjectView[]] }) {
  const client = testQueryClient();
  client.setQueryData(memoryQueryOptions(IDS.venture).queryKey, {
    items: lists.all ?? [kept],
    nextCursor: null,
  });
  client.setQueryData(memoryQueryOptions(IDS.venture, { status: 'proposed' }).queryKey, {
    items: [],
    nextCursor: null,
  });
  if (lists.filtered) {
    const [filters, items] = lists.filtered;
    client.setQueryData(memoryQueryOptions(IDS.venture, filters).queryKey, { items, nextCursor: null });
  }
  return client;
}

function render(client: QueryClient, search: KnowledgeSearch) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSelectedMemory(IDS.venture, search), { wrapper });
}

function itemRequests() {
  return fetchMock.mock.calls.filter(([input]) => urlOf(input).includes(`/api/v1/memory/`));
}

describe('useSelectedMemory', () => {
  it('uses the item from the lists on screen without a request', () => {
    const { result } = render(seededClient({}), { m: IDS.memory });
    expect(result.current).toEqual({ state: 'ready', memory: kept });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('finds a superseded item in the filtered list', () => {
    const superseded = makeMemory({ id: IDS.memory2, status: 'superseded' });
    const filters = { status: 'superseded' as const };
    const { result } = render(seededClient({ filtered: [filters, [superseded]] }), {
      ...filters,
      m: IDS.memory2,
    });
    expect(result.current).toEqual({ state: 'ready', memory: superseded });
  });

  it('fetches an item no list holds (the earlier version a correction replaced)', async () => {
    const earlier = makeMemory({ id: IDS.memory3, status: 'superseded' });
    fetchMock.mockResolvedValue(json(earlier));
    const { result } = render(seededClient({}), { m: IDS.memory3 });
    expect(result.current.state).toBe('loading');
    await waitFor(() => {
      expect(result.current).toEqual({ state: 'ready', memory: earlier });
    });
    expect(urlOf(itemRequests()[0]?.[0])).toContain(`/api/v1/memory/${IDS.memory3}`);
  });

  it('is gone only when the item no longer exists or belongs to another venture', async () => {
    fetchMock.mockResolvedValueOnce(problem(404, 'not_found'));
    const missing = render(seededClient({}), { m: IDS.memory3 });
    await waitFor(() => {
      expect(missing.result.current).toEqual({ state: 'gone' });
    });

    fetchMock.mockResolvedValueOnce(json(makeMemory({ id: IDS.memory3, ventureId: IDS.session })));
    const elsewhere = render(seededClient({}), { m: IDS.memory3 });
    await waitFor(() => {
      expect(elsewhere.result.current).toEqual({ state: 'gone' });
    });
  });

  it('offers a retry when the item could not be loaded', async () => {
    fetchMock.mockResolvedValue(problem(503, 'unavailable'));
    const { result } = render(seededClient({}), { m: IDS.memory3 });
    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });
  });
});
