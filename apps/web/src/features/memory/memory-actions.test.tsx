import type { MemoryObjectView } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import { IDS, makeMemory } from '@/features/coach/testing';

import { useOptimisticMemoryAction } from './api';
import { ProposedQueue } from './proposed-queue';

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
  client.setQueryData(allKey, { items });
  client.setQueryData(proposedKey, { items });
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

describe('ProposedQueue', () => {
  /** Queue cards (the list also contains nested provenance list items). */
  function cards(): HTMLElement[] {
    return screen.getAllByRole('listitem').filter((el) => el.tagName === 'ARTICLE');
  }

  /** PATCH returns `updated`; the refetch that follows returns `remaining`. */
  function respond(updated: MemoryObjectView, remaining: MemoryObjectView[]) {
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(init?.method === 'PATCH' ? json(updated) : json({ items: remaining })),
    );
  }

  function patchCalls() {
    return fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
  }

  function renderQueue(canEdit = true) {
    const ctx = setup();
    const onOpenDetail = vi.fn<(id: string) => void>();
    const user = userEvent.setup();
    render(
      <ProposedQueue ventureId={IDS.venture} tenant="ain" canEdit={canEdit} onOpenDetail={onOpenDetail} />,
      { wrapper: ctx.wrapper },
    );
    return { ...ctx, onOpenDetail, user };
  }

  it('lists proposed memory with review actions', () => {
    renderQueue();
    expect(screen.getByText('2 suggestions to review')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Proposed memory' })).toBeInTheDocument();
    const [first] = cards();
    expect(cards()).toHaveLength(2);
    if (!first) throw new Error('no cards');
    expect(within(first).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('moves with J/K and approves the focused suggestion with A', async () => {
    respond({ ...proposedB, status: 'confirmed' }, [proposedA]);
    const { user, proposedKey, client } = renderQueue();
    const [first, second] = cards();
    if (!first || !second) throw new Error('no cards');
    first.focus();
    await user.keyboard('j');
    await waitFor(() => {
      expect(second).toHaveFocus();
    });
    expect(second).toHaveAttribute('aria-current', 'true');
    await user.keyboard('k');
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
    await user.keyboard('j');
    await waitFor(() => {
      expect(second).toHaveFocus();
    });
    await user.keyboard('a');

    await waitFor(() => {
      expect(patchCalls()).toHaveLength(1);
    });
    expect(sentUrl()).toContain(`/memory/${IDS.memory2}`);
    expect(sentJson()).toEqual({ action: 'approve' });
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    expect(client.getQueryData<{ items: MemoryObjectView[] }>(proposedKey)?.items.map((m) => m.id)).toEqual([
      IDS.memory,
    ]);
  });

  it('rejects with R and ignores the second key of a "g" navigation sequence', async () => {
    respond({ ...proposedA, status: 'rejected' }, [proposedB]);
    const { user } = renderQueue();
    const [first] = cards();
    if (!first) throw new Error('no cards');
    first.focus();
    await user.keyboard('ga');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard('r');
    await waitFor(() => {
      expect(patchCalls()).toHaveLength(1);
    });
    expect(sentJson()).toEqual({ action: 'reject' });
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
  });

  it('opens details with Enter and hides review actions for read-only viewers', async () => {
    const { user, onOpenDetail } = renderQueue(false);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    const [first] = cards();
    if (!first) throw new Error('no cards');
    first.focus();
    await user.keyboard('a');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onOpenDetail).toHaveBeenCalledWith(IDS.memory);
  });
});
