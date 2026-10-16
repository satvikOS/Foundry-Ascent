import { BatchMemoryActionRequest } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { MEMORY_BATCH_MAX, useBatchMemoryAction } from './memory-batch';

const VENTURE = '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBatchMemoryAction', () => {
  it('matches the contract limit per request', () => {
    const ids = Array.from({ length: MEMORY_BATCH_MAX }, (_, n) => id(n));
    expect(BatchMemoryActionRequest.safeParse({ ids, action: 'approve' }).success).toBe(true);
    expect(BatchMemoryActionRequest.safeParse({ ids: [...ids, id(999)], action: 'approve' }).success).toBe(
      false,
    );
  });

  it('keeps every item, in requests of at most 50, and adds up what changed and what was skipped', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_input, init) => {
      const body = sentJson(init) as { ids: string[] };
      return Promise.resolve(jsonResponse({ items: [], skippedIds: body.ids.slice(0, 1) }));
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBatchMemoryAction(VENTURE), { wrapper });
    const ids = Array.from({ length: 120 }, (_, n) => id(n));
    let outcome: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      outcome = await result.current.mutateAsync({ ids, action: 'approve' });
    });
    const sent = fetchMock.mock.calls.map(([, init]) => (sentJson(init) as { ids: string[] }).ids);
    expect(sent.map((chunk) => chunk.length)).toEqual([50, 50, 20]);
    expect(sent.flat()).toEqual(ids);
    expect(outcome?.skippedIds).toEqual([id(0), id(50), id(100)]);
  });
});
