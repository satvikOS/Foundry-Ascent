import type { MemoryObjectView } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import { IDS, makeMemory } from '@/features/knowledge/testing';

import { useOptimisticMemoryAction } from './api';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ type: `https://x/${code}`, title: 'Problem', status, code, requestId: 'req-1' }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function sentJson(call = 0): unknown {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as unknown;
}

function sentUrl(call = 0): string {
  const input = fetchMock.mock.calls[call]?.[0];
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? '');
}

const proposedA = makeMemory({ id: IDS.memory, title: 'Exam weeks drive demand' });
const proposedB = makeMemory({ id: IDS.memory2, title: 'Group chats are the workaround', type: 'insight' });

function setup(items: MemoryObjectView[] = [proposedA, proposedB]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const allKey = memoryQueryOptions(IDS.venture).queryKey;
  const proposedKey = memoryQueryOptions(IDS.venture, { status: 'proposed' }).queryKey;
  client.setQueryData(allKey, { items, nextCursor: null });
  client.setQueryData(proposedKey, { items, nextCursor: null });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, allKey, proposedKey, wrapper };
}

beforeEach(() => {
  fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal('fetch', fetchMock);
});

describe('useOptimisticMemoryAction', () => {
  it('updates every cached list immediately and keeps the server result', async () => {
    let resolve: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const { client, allKey, proposedKey, wrapper } = setup();
    const { result } = renderHook(() => useOptimisticMemoryAction(IDS.venture), { wrapper });

    act(() => {
      result.current.mutate({ memoryId: IDS.memory, action: { action: 'approve' } });
    });

    // Optimistic: approved item leaves the proposed queue and is confirmed in the full list.
    await waitFor(() => {
      expect(client.getQueryData<{ items: MemoryObjectView[] }>(proposedKey)?.items.map((m) => m.id)).toEqual(
        [IDS.memory2],
      );
    });
    expect(client.getQueryData<{ items: MemoryObjectView[] }>(allKey)?.items[0]?.status).toBe('confirmed');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(sentUrl()).toContain(`/api/v1/memory/${IDS.memory}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PATCH');
    expect(sentJson()).toEqual({ action: 'approve' });

    resolve(json({ ...proposedA, status: 'confirmed', approvedAt: '2026-10-05T09:00:00.000Z' }));
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('rolls the caches back when the server rejects the change', async () => {
    fetchMock.mockResolvedValue(problem(409, 'conflict'));
    const { client, allKey, proposedKey, wrapper } = setup();
    const { result } = renderHook(() => useOptimisticMemoryAction(IDS.venture), { wrapper });

    act(() => {
      result.current.mutate({ memoryId: IDS.memory, action: { action: 'reject', reason: 'Not true' } });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(client.getQueryData<{ items: MemoryObjectView[] }>(proposedKey)?.items.map((m) => m.id)).toEqual([
      IDS.memory,
      IDS.memory2,
    ]);
    expect(client.getQueryData<{ items: MemoryObjectView[] }>(allKey)?.items[0]?.status).toBe('proposed');
    expect(sentJson()).toEqual({ action: 'reject', reason: 'Not true' });
  });

  it('treats the 204 No Content answer to delete as success and drops the item', async () => {
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH' ? new Response(null, { status: 204 }) : json({ items: [proposedB] }),
      ),
    );
    const { client, allKey, wrapper } = setup();
    const { result } = renderHook(() => useOptimisticMemoryAction(IDS.venture), { wrapper });
    act(() => {
      result.current.mutate({ memoryId: IDS.memory, action: { action: 'delete' } });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toBeNull();
    expect(sentJson()).toEqual({ action: 'delete' });
    expect(client.getQueryData<{ items: MemoryObjectView[] }>(allKey)?.items.map((m) => m.id)).not.toContain(
      IDS.memory,
    );
  });

  it('validates the action locally before sending', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useOptimisticMemoryAction(IDS.venture), { wrapper });
    act(() => {
      result.current.mutate({ memoryId: IDS.memory, action: { action: 'dispute', reason: 'x'.repeat(501) } });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
