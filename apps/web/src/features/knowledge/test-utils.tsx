/**
 * Test-only rendering helpers for the Knowledge, memory and help screens: a fresh query client, the
 * tooltip provider, and a memory router so links render.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
}

/** Renders `ui` as the root route of a memory router, so `<Link>`s work. */
export async function renderWithRouter(
  ui: ReactElement,
  client: QueryClient = testQueryClient(),
): Promise<RenderResult & { client: QueryClient }> {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  let result: RenderResult | undefined;
  await act(async () => {
    result = render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
  if (!result) throw new Error('render failed');
  return { ...result, client };
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Stubs global fetch; returns the mock to queue responses and inspect calls. */
export function stubFetch() {
  const fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function problem(status: number, code: string, detail = 'Problem'): Response {
  return new Response(
    JSON.stringify({ type: `urn:x:${code}`, title: 'Problem', status, code, detail, requestId: 'req-1' }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** The JSON body of a request the API client sent (it sends the hashed bytes as a Uint8Array). */
export function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === 'string') return JSON.parse(body) as unknown;
  if (body && ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body)) as unknown;
  return undefined;
}

export function urlOf(input: RequestInfo | URL | undefined): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? '');
}
