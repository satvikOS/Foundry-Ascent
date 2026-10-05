import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

/** Test-only: render with a fresh QueryClient (no retries) and the tooltip provider used in __root. */
export function renderWithProviders(ui: ReactElement): RenderResult & { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Stub global fetch; returns the mock so tests can queue responses and inspect calls. */
export function stubFetch() {
  const fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Decode the JSON body the API client sent (it sends the exact hashed bytes as a Uint8Array). */
export function sentJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === 'string') return JSON.parse(body) as unknown;
  // `instanceof Uint8Array` fails across realms (Node's TextEncoder vs jsdom); isView does not.
  if (body && ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body)) as unknown;
  return undefined;
}
