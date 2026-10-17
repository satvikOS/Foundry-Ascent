import type { Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { conversationOrigin } from '@/features/documents/upload-queue';
import { VentureUploadsProvider } from '@/features/documents/venture-uploads';
import { makeSession, makeVenture } from '@/features/knowledge/testing';
import { meQueryOptions } from '@/lib/api/hooks/auth';

import { AttachmentTray, useComposerAttachments } from './attachments';
import { NewChatPage } from './new-chat-page';
import { startPrivacy, takeChoiceInView } from './privacy-choice';

const A = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01';
const B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c02';
const SESSION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c03';
/** BenchTally picks up its last conversation; QuietQuad has nothing to pick up. */
const OPENER = 'Welcome back. Last time we were on per-library pricing. How did the facilities call go?';
const OPENER_LINE = 'Last time we were on per-library pricing. How did the facilities call go?';
const OPENER_AT = '2026-10-16T18:59:58.000Z';
const TIME_OF_DAY = /^Good (?:morning|afternoon|evening), Maya$/;

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
  body: unknown;
}

function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === 'string') return JSON.parse(body) as unknown;
  if (body && ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body)) as unknown;
  return undefined;
}

/**
 * The API as New chat reads it: each venture, how its vEIR would open a conversation now (`opener`: a held
 * promise to answer late), and an upload that stays in flight until aborted.
 */
function stubApi({
  calls: callsOn = false,
  opener,
}: { calls?: boolean; opener?: Promise<Response> } = {}): Call[] {
  const calls: Call[] = [];
  stubFetch().mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    calls.push({
      method,
      url,
      signal,
      body: method === 'POST' && !url.endsWith('/documents') ? bodyOf(init) : undefined,
    });
    // Call settings with calls on (the composer then offers Call).
    if (callsOn && method === 'GET' && url.endsWith('/call-config')) {
      return Promise.resolve(
        jsonResponse({
          veir: {
            personaId: SESSION,
            name: 'Corin’s vEIR',
            shortName: 'Corin',
            kind: 'eir_persona',
            eirDisplayName: 'Corin Halvorsen',
            tagline: null,
            disclosure: 'AI',
            embodiment: {
              provider: 'builtin',
              voiceId: null,
              portraitUrl: null,
              voiceConsented: false,
              likenessConsented: false,
            },
          },
          provider: 'builtin',
          maxMinutes: 20,
          remainingMinutesToday: 40,
          aiEnabled: true,
          callsEnabled: true,
          callNoticeAcknowledgedAt: null,
        }),
      );
    }
    for (const [id, name, preview] of [
      [A, 'QuietQuad', { opener: null, at: OPENER_AT, lastConversation: null }],
      [
        B,
        'BenchTally',
        {
          opener: OPENER,
          at: OPENER_AT,
          lastConversation: {
            sessionId: SESSION,
            lastActivityAt: '2026-10-16T18:50:00.000Z',
            channel: 'chat',
            title: 'Pricing and willingness to pay',
          },
        },
      ],
    ] as const) {
      if (method === 'GET' && url === `/api/v1/ventures/${id}`) {
        return Promise.resolve(jsonResponse(makeVenture({ id, name })));
      }
      if (method === 'GET' && url === `/api/v1/ventures/${id}/opener`) {
        return opener ?? Promise.resolve(jsonResponse(preview));
      }
      if (method === 'POST' && url === `/api/v1/ventures/${id}/sessions`) {
        return Promise.resolve(
          jsonResponse(makeSession({ id: SESSION, ventureId: id, status: 'active', endedAt: null }), 201),
        );
      }
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

/** The venture layout's part these tests need: the venture's uploads, above its pages. */
function VentureLayout() {
  const { ventureId } = useParams({ strict: false });
  if (!ventureId) throw new Error('no venture');
  return (
    <VentureUploadsProvider ventureId={ventureId}>
      <Outlet />
    </VentureUploadsProvider>
  );
}

/** A conversation's composer tray: the uploads started from that conversation. */
function ConversationTray() {
  const { ventureId, sessionId } = useParams({ strict: false });
  if (!ventureId || !sessionId) throw new Error('no conversation');
  const attachments = useComposerAttachments(ventureId, conversationOrigin(sessionId));
  return (
    <>
      <p>Conversation</p>
      <AttachmentTray
        items={attachments.items}
        onCancel={attachments.cancel}
        onRetry={attachments.retry}
        onDismiss={attachments.dismiss}
      />
    </>
  );
}

function renderNewChat(ventureId: string) {
  const root = createRootRoute({ component: Outlet });
  const venture = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId',
    component: VentureLayout,
  });
  const index = createRoute({ getParentRoute: () => venture, path: '/', component: NewChatPage });
  const conversation = createRoute({
    getParentRoute: () => venture,
    path: 'c/$sessionId',
    component: ConversationTray,
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
  it('greets with the vEIR’s opener when there is something to pick up, by the time of day when not', async () => {
    const calls = stubApi();
    const router = renderNewChat(A);
    // QuietQuad: nothing to pick up.
    expect(await screen.findByText('What should we work on today?')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TIME_OF_DAY);
    await act(async () => {
      router.history.push(`/ain/app/v/${B}`);
      await router.invalidate();
    });
    // BenchTally: the opener's own greeting with the name, then the line the conversation opens with.
    expect(await screen.findByText(OPENER_LINE)).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back, Maya' })).toBeInTheDocument();
    expect(screen.queryByText(/What should we work on/)).toBeNull();
    // The notebook is not what New chat greets with any more.
    expect(calls.some((c) => c.url.endsWith('/notebook'))).toBe(false);
  });

  it('opens the conversation with the line it greeted with', async () => {
    const calls = stubApi();
    renderNewChat(B);
    await screen.findByText(OPENER_LINE);
    await userEvent.setup().type(composer(), 'It went well, they have a budget.{Enter}');
    await screen.findByText('Conversation');
    const create = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${B}/sessions`);
    expect(create?.body).toMatchObject({ privacy: 'standard', openerShownAt: OPENER_AT });
  });

  it('opens with no line when it greeted with none', async () => {
    const calls = stubApi();
    renderNewChat(A);
    await screen.findByText('What should we work on today?');
    await userEvent.setup().type(composer(), 'What should we test first?{Enter}');
    await screen.findByText('Conversation');
    const create = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/sessions`);
    expect(create?.body).toMatchObject({ privacy: 'standard', openerShownAt: null });
  });

  it('greets by the time of day when Private is chosen (a private chat reads nothing)', async () => {
    stubApi();
    renderNewChat(B);
    await screen.findByText(OPENER_LINE);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Private, a one-off' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TIME_OF_DAY);
    expect(screen.getByText('What’s on your mind?')).toBeVisible();
    expect(screen.queryByText(OPENER_LINE)).toBeNull();
    // Back to Remember: the same opener as before.
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Remember this conversation' }));
    expect(screen.getByText(OPENER_LINE)).toBeVisible();
  });

  it('puts the cursor in the composer on a desktop once the greeting has arrived', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: fine'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    let answer: (response: Response) => void = () => undefined;
    stubApi({
      opener: new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    });
    renderNewChat(B);
    await new Promise((resolve) => setTimeout(resolve, 150));
    answer(jsonResponse({ opener: OPENER, at: OPENER_AT, lastConversation: null }));
    await screen.findByText(OPENER_LINE);
    await waitFor(() => {
      expect(composer()).toHaveFocus();
    });
  });

  it('greets without the opener when it is late, and never changes the greeting once shown', async () => {
    let answer: (response: Response) => void = () => undefined;
    const calls = stubApi({
      opener: new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    });
    renderNewChat(B);
    // Nothing shows while the greeting is unknown (it never changes in front of the founder)...
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // ...for at most OPENER_WAIT_MS: then the time of day, and the conversation opens without a line.
    expect(await screen.findByText('What should we work on today?', {}, { timeout: 4_000 })).toBeVisible();
    answer(jsonResponse({ opener: OPENER, at: OPENER_AT, lastConversation: null }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(OPENER_LINE)).toBeNull();
    await userEvent.setup().type(composer(), 'Hello{Enter}');
    await screen.findByText('Conversation');
    const create = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${B}/sessions`);
    expect(create?.body).toMatchObject({ openerShownAt: null });
  });

  it('sends while files upload: they keep uploading and show in the conversation it opened', async () => {
    const calls = stubApi();
    const router = renderNewChat(A);
    await screen.findByText('What should we work on today?');
    await attach('plan-a.md');
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/documents`)).toBe(
        true,
      );
    });
    const inFlight = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/documents`);
    await userEvent.setup().type(composer(), 'What should we test first?{Enter}');

    expect(await screen.findByText('Conversation')).toBeVisible();
    expect(router.state.location.pathname).toBe(`/ain/app/v/${A}/c/${SESSION}`);
    const tray = screen.getByRole('list', { name: 'Documents being added' });
    expect(tray).toHaveTextContent('plan-a.md');
    expect(inFlight?.signal?.aborted).toBe(false);
  });

  it('keeps nothing across a venture switch: no draft, no queued upload sent to the other venture', async () => {
    const calls = stubApi();
    const router = renderNewChat(A);
    await screen.findByText('What should we work on today?');
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
    expect(await screen.findByText(OPENER_LINE)).toBeVisible();
    expect(composer()).toHaveValue('');
    expect(screen.queryByRole('list', { name: 'Documents being added' })).toBeNull();
    // A's upload was cancelled, and neither of A's files went to B.
    expect(inFlight?.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${B}/documents`)).toEqual(
      [],
    );
  });

  it('starts remembered by default and sends the choice with the first message', async () => {
    const calls = stubApi();
    renderNewChat(A);
    await screen.findByText('What should we work on today?');
    const group = screen.getByRole('group', { name: 'Memory for this conversation' });
    expect(within(group).getByRole('radio', { name: 'Remember this conversation' })).toBeChecked();
    expect(group).toHaveAccessibleDescription('Remembered for next time.');
    await userEvent.setup().type(composer(), 'What should we test first?{Enter}');
    await screen.findByText('Conversation');
    const create = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/sessions`);
    expect(create?.body).toMatchObject({ privacy: 'standard' });
  });

  it('starts a private one-off when Private is chosen, with no attachments and nothing remembered', async () => {
    const calls = stubApi();
    renderNewChat(A);
    await screen.findByText('What should we work on today?');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Private, a one-off' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TIME_OF_DAY);
    expect(screen.getByRole('group', { name: 'Memory for this conversation' })).toHaveAccessibleDescription(
      'Not remembered. Erased when it ends.',
    );
    expect(screen.queryByRole('button', { name: /Attach/ })).toBeNull();
    await user.type(composer(), 'Something just for now{Enter}');
    await screen.findByText('Conversation');
    const create = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/ventures/${A}/sessions`);
    expect(create?.body).toMatchObject({ privacy: 'ephemeral' });
    expect(create?.body).not.toHaveProperty('openerShownAt');
  });

  it('starts a call at once from its own Call button, beside the choice (and only that opening)', async () => {
    stubApi({ calls: true });
    const router = renderNewChat(A);
    const call = await screen.findByRole('link', { name: /^Call / });
    expect(call).toHaveAttribute('href', `/ain/app/v/${A}?call=1`);
    expect(takeChoiceInView(A)).toBe(false);
    await userEvent.setup().click(call);
    await waitFor(() => {
      expect(router.state.location.searchStr).toBe('?call=1');
    });
    // The call screen takes the mark when it opens; it is good for that one opening only.
    expect(takeChoiceInView(A)).toBe(true);
    expect(takeChoiceInView(A)).toBe(false);
  });

  it('is back to Remember on every fresh New chat (the choice is never stored)', async () => {
    stubApi();
    const router = renderNewChat(A);
    await screen.findByText('What should we work on today?');
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Private, a one-off' }));
    expect(startPrivacy(A)).toBe('ephemeral');
    await act(async () => {
      router.history.push(`/ain/app/v/${B}`);
      await router.invalidate();
    });
    await act(async () => {
      router.history.push(`/ain/app/v/${A}`);
      await router.invalidate();
    });
    expect(await screen.findByRole('radio', { name: 'Remember this conversation' })).toBeChecked();
    expect(startPrivacy(A)).toBe('standard');
  });
});
