import type { Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { makeNotebook, makeVenture } from '@/features/knowledge/testing';
import { meQueryOptions } from '@/lib/api/hooks/auth';

import { NewChatPage } from './new-chat-page';

const A = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01';
const B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c02';
const NAMED_OPENER = 'Last time Corin suggested five library interviews. How did they go?';
const GREETING = 'Last time you planned five library interviews. How did they go?';

const ME: Me = {
  principal: {
    id: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
    displayName: 'Maya Example',
    title: null,
    synthetic: true,
  },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  // A founder of two ventures: the precondition of a switch that keeps New chat mounted.
  memberships: [
    { ventureId: A, ventureName: 'QuietQuad', role: 'founder' },
    { ventureId: B, ventureName: 'BenchTally', role: 'founder' },
  ],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
};

interface Call {
  method: string;
  url: string;
  signal: AbortSignal | null;
}

/** The API as New chat reads it: each venture, its notebook, and an upload that stays in flight until aborted. */
function stubApi(): Call[] {
  const calls: Call[] = [];
  stubFetch().mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    calls.push({ method, url, signal });
    for (const [id, name, notebook] of [
      [A, 'QuietQuad', makeNotebook({ ventureId: A, nextOpener: NAMED_OPENER, greeting: null })],
      [B, 'BenchTally', makeNotebook({ ventureId: B, nextOpener: GREETING, greeting: GREETING })],
    ] as const) {
      if (method === 'GET' && url === `/api/v1/ventures/${id}`) {
        return Promise.resolve(jsonResponse(makeVenture({ id, name })));
      }
      if (method === 'GET' && url === `/api/v1/ventures/${id}/notebook`)
        return Promise.resolve(jsonResponse(notebook));
      if (method === 'POST' && url === `/api/v1/ventures/${id}/documents`) {
        // Uploading: nothing comes back until the request is aborted.
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
    }
    return Promise.resolve(
      jsonResponse({ type: 'about:blank', title: 'Not found', status: 404, code: 'not_found' }, 404),
    );
  });
  return calls;
}

function renderNewChat(ventureId: string) {
  const root = createRootRoute({ component: Outlet });
  const venture = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId',
    component: Outlet,
  });
  const index = createRoute({ getParentRoute: () => venture, path: '/', component: NewChatPage });
  const conversation = createRoute({
    getParentRoute: () => venture,
    path: 'c/$sessionId',
    component: () => <p>Conversation</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([venture.addChildren([index, conversation])]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${ventureId}`] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(meQueryOptions().queryKey, ME);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

function composer() {
  return screen.getByRole('textbox', { name: /^Message / });
}

async function attach(name: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  await userEvent.setup().upload(input, new File(['# notes'], name, { type: 'text/markdown' }));
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('New chat', () => {
  it('greets with the server’s checked opener only, never one that names the EIR', async () => {
    const calls = stubApi();
    const router = renderNewChat(A);
    expect(await screen.findByText('What should we work on for QuietQuad today?')).toBeVisible();
    // Once the notebook has loaded too, the opener that names the EIR is still not shown.
    await waitFor(() => {
      expect(calls.some((c) => c.url === `/api/v1/ventures/${A}/notebook`)).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('What should we work on for QuietQuad today?')).toBeVisible();
    expect(screen.queryByText(NAMED_OPENER)).toBeNull();
    await act(async () => {
      router.history.push(`/ain/app/v/${B}`);
      await router.invalidate();
    });
    expect(await screen.findByText(GREETING)).toBeVisible();
  });

  it('holds Send while files upload, because sending would leave the page and cancel them', async () => {
    const calls = stubApi();
    renderNewChat(A);
    await screen.findByText('What should we work on for QuietQuad today?');
    await attach('plan-a.md');
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/documents`)).toBe(
        true,
      );
    });
    const user = userEvent.setup();
    await user.type(composer(), 'What should we test first?{Enter}');
    expect(screen.getByText('Your files are still uploading. You can send when they’re done.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    // Nothing was created: no conversation to navigate to while the upload runs.
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions'))).toBe(false);
    expect(composer()).toHaveValue('What should we test first?');
  });

  it('keeps nothing across a venture switch: no draft, no queued upload sent to the other venture', async () => {
    const calls = stubApi();
    const router = renderNewChat(A);
    await screen.findByText('What should we work on for QuietQuad today?');
    await attach('plan-a.md');
    await attach('budget-a.md');
    await userEvent.setup().type(composer(), 'secret plan for A');
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/documents`)).toBe(
        true,
      );
    });
    const inFlight = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/documents`);

    await act(async () => {
      router.history.push(`/ain/app/v/${B}`);
      await router.invalidate();
    });
    expect(await screen.findByText(GREETING)).toBeVisible();
    expect(composer()).toHaveValue('');
    expect(screen.queryByRole('list', { name: 'Documents being added' })).toBeNull();
    // A's upload was cancelled, and neither of A's files went to B.
    expect(inFlight?.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${B}/documents`)).toEqual(
      [],
    );
  });
});
