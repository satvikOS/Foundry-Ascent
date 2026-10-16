/**
 * Test helpers for the call UI (imported by *.test.tsx only): a query client, the tooltip provider and a
 * memory router around the component, a fetch stub, and a stand-in CallEngine.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { CallEngine, CallSnapshot } from '@/lib/realtime/call-engine';

export function renderWithRouter(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => ui });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function stubFetch() {
  const fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function sentJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (body && ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body)) as unknown;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

export const LIVE: CallSnapshot = {
  phase: 'live',
  ventureId: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  sessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02',
  call: null,
  activity: 'listening',
  input: 'voice',
  typedReason: null,
  muted: false,
  held: false,
  talkMode: 'hands_free',
  talking: false,
  halfDuplex: false,
  reconnecting: false,
  audioBlocked: false,
  liveAt: Date.now(),
  remaining: { seconds: 1200, at: Date.now() },
  captions: { veir: null, founder: null, founderLive: false },
  voice: 'server',
  voicePaused: false,
  notice: null,
  blocked: null,
  queued: 0,
  ended: null,
  error: null,
};

/** The engine methods the call UI uses, as spies. */
export function fakeEngine() {
  const engine = {
    setMuted: vi.fn(),
    setTalkMode: vi.fn(),
    pushToTalk: vi.fn(),
    sendText: vi.fn(),
    interrupt: vi.fn(),
    resumeAudio: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(() => Promise.resolve()),
    avatarState: vi.fn(() => 'listening' as const),
    levels: vi.fn(() => ({ veir: 0, founder: 0 })),
    onSpeak: vi.fn(() => () => undefined),
  };
  return { engine, asEngine: engine as unknown as CallEngine };
}
