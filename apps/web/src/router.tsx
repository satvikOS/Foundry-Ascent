import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';

import { NotFoundState, RouteErrorBoundary, RoutePending } from '@/components/shell/route-states';

import { routeTree } from './routeTree.gen';

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    // Preload on hover/focus; TanStack Query owns freshness, so the router never caches loader data itself.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultErrorComponent: RouteErrorBoundary,
    defaultNotFoundComponent: NotFoundState,
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 250,
    defaultPendingMinMs: 300,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
