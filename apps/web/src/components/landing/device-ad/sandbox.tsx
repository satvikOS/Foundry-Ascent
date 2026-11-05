import type { SessionView } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { queryKeys } from '@/lib/api/query-keys';
import { callConfigQueryOptions } from '@/features/calls/use-call-veir';

import { AD_CALL_CONFIG, AD_CURRENT, AD_IDS, AD_RECENT, AD_VENTURE } from './fixtures';

function recents(withCurrent: boolean): {
  pages: { items: SessionView[]; nextCursor: null }[];
  pageParams: null[];
} {
  return {
    pages: [{ items: withCurrent ? [AD_CURRENT, ...AD_RECENT] : AD_RECENT, nextCursor: null }],
    pageParams: [null],
  };
}

/**
 * A query cache of its own for the ad, filled with the synthetic venture: the app's real sidebar and conversation
 * components read their data from it exactly as they do from the API, and nothing is requested (no retries, no
 * refetching on mount, focus or reconnect). The landing page's own cache is never touched.
 */
export function createAdQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  const seed = (key: readonly unknown[], data: unknown) => {
    client.setQueryData(key, data);
  };
  seed(queryKeys.ventures.list(), { items: [AD_VENTURE] });
  seed(queryKeys.venture.detail(AD_IDS.venture), AD_VENTURE);
  seed(callConfigQueryOptions(AD_IDS.venture).queryKey, AD_CALL_CONFIG);
  seed(queryKeys.conversations.list({ scope: 'mine' }), recents(false));
  return client;
}

/** The ad's components inside their own seeded cache; `current` adds the ad's conversation to the recents. */
export function AdSandbox({ current, children }: { current: boolean; children: ReactNode }) {
  const [client] = useState(createAdQueryClient);
  useEffect(() => {
    client.setQueryData(queryKeys.conversations.list({ scope: 'mine' }), recents(current));
  }, [client, current]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
