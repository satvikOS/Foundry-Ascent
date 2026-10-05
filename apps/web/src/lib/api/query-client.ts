import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { sessionHint } from '@/lib/storage';

import { isApiError } from './errors';
import { queryKeys } from './query-keys';

type UnauthenticatedHandler = () => void;
let onUnauthenticated: UnauthenticatedHandler | null = null;

/** Registered by main.tsx: called when any request reports an expired/revoked session. */
export function setUnauthenticatedHandler(handler: UnauthenticatedHandler | null): void {
  onUnauthenticated = handler;
}

function handleError(error: unknown, client: QueryClient): void {
  if (isApiError(error) && error.isUnauthenticated) {
    // Drop every cached venture object immediately (privacy), then let the router redirect.
    sessionHint.set(false);
    client.removeQueries({ predicate: (query) => query.queryKey[1] !== 'me' });
    client.setQueryData(queryKeys.me(), null);
    onUnauthenticated?.();
  }
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        handleError(error, client);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        handleError(error, client);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // `database_resuming` is already retried inside the client; only retry transient network faults here.
        retry: (failureCount, error) => isApiError(error) && error.isTransient && failureCount < 2,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
  return client;
}
