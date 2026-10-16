import { focusManager, QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryQueryOptions } from './hooks/memory';
import { notebookQueryOptions } from './hooks/notebook';
import { ventureOverviewQueryOptions } from './hooks/ventures';
import { createQueryClient } from './query-client';
import { queryKeys } from './query-keys';
import { refreshVentureAfterTurn } from './venture-refresh';

const V = '55555555-5555-4555-8555-555555555555';

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe('refreshing a venture’s data', () => {
  it('after a turn, refreshes what a turn changes and nothing else of the venture', async () => {
    const client = new QueryClient();
    const keys: Record<string, QueryKey> = {
      memory: queryKeys.venture.memory(V, { status: 'confirmed' }),
      memoryAll: queryKeys.venture.memory(V),
      overview: queryKeys.venture.overview(V),
      detail: queryKeys.venture.detail(V),
      escalations: queryKeys.venture.escalations(V),
      sessions: queryKeys.venture.sessions(V),
      notebook: queryKeys.venture.notebook(V),
      documents: queryKeys.venture.documents(V),
      team: queryKeys.venture.team(V),
      callConfig: [...queryKeys.venture.scope(V), 'call-config'],
    };
    for (const key of Object.values(keys)) client.setQueryData(key, { items: [] });
    refreshVentureAfterTurn(client, V);
    await vi.waitFor(() => {
      expect(client.getQueryState(keys.memory ?? [])?.isInvalidated).toBe(true);
    });
    const invalidated = Object.fromEntries(
      Object.entries(keys).map(([name, key]) => [name, client.getQueryState(key)?.isInvalidated ?? false]),
    );
    expect(invalidated).toEqual({
      memory: true,
      memoryAll: true,
      overview: true,
      detail: true,
      escalations: true,
      sessions: true,
      notebook: false,
      documents: false,
      team: false,
      callConfig: false,
    });
  });

  it('a return to the tab within five minutes asks again for neither the memory list nor the overview', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T19:00:00Z'));
    const client = createQueryClient();
    // As the app's provider does: the client follows the tab's focus.
    client.mount();
    const fetched: Record<string, number> = { memory: 0, overview: 0, notebook: 0 };
    const counted = (name: string) => (): Promise<never> => {
      fetched[name] = (fetched[name] ?? 0) + 1;
      return Promise.resolve({ items: [], nextCursor: null } as never);
    };
    const observers = [
      new QueryObserver(client, { ...memoryQueryOptions(V), queryFn: counted('memory') }),
      new QueryObserver(client, { ...ventureOverviewQueryOptions(V), queryFn: counted('overview') }),
      new QueryObserver(client, { ...notebookQueryOptions(V), queryFn: counted('notebook') }),
    ];
    const stop = observers.map((o) =>
      o.subscribe(() => {
        /* active, as a mounted page's queries are */
      }),
    );
    const loaded = async (): Promise<void> => {
      await vi.waitFor(() => {
        expect(observers.map((o) => o.getCurrentResult().fetchStatus)).toEqual(['idle', 'idle', 'idle']);
      });
    };
    await loaded();
    expect(fetched).toEqual({ memory: 1, overview: 1, notebook: 1 });

    // The founder switches away between calls and comes back two minutes later.
    vi.setSystemTime(new Date('2026-10-16T19:02:00Z'));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() => {
      expect(fetched.notebook).toBe(2); // fresh for a minute only: asked again
    });
    await loaded();
    expect(fetched.memory).toBe(1);
    expect(fetched.overview).toBe(1);

    // After five minutes they are read again on return.
    vi.setSystemTime(new Date('2026-10-16T19:07:30Z'));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() => {
      expect(fetched.memory).toBe(2);
    });
    expect(fetched.overview).toBe(2);
    for (const unsubscribe of stop) unsubscribe();
    client.unmount();
    client.clear();
  });
});
