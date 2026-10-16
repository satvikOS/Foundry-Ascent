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
import { conversationOrigin } from '@/features/documents/upload-queue';
import { FakeXhr } from '@/features/documents/upload-testing';
import { VentureUploadsProvider } from '@/features/documents/venture-uploads';
import { json, stubFetch, urlOf } from '@/features/knowledge/test-utils';
import { IDS, makeDocument } from '@/features/knowledge/testing';

import { AttachButton, AttachmentTray, useComposerAttachments } from './attachments';

const S1 = IDS.session;
const S2 = IDS.session2;
const BASE = `/ain/app/v/${IDS.venture}`;

function VentureLayout() {
  const { ventureId } = useParams({ strict: false });
  if (!ventureId) throw new Error('no venture');
  return (
    <VentureUploadsProvider ventureId={ventureId}>
      <Outlet />
    </VentureUploadsProvider>
  );
}

/** A conversation's composer, keyed by conversation as ConversationPage is (a switch remounts it). */
function Conversation() {
  const { sessionId } = useParams({ strict: false });
  if (!sessionId) throw new Error('no conversation');
  return <Composer key={sessionId} sessionId={sessionId} />;
}

function Composer({ sessionId }: { sessionId: string }) {
  const attachments = useComposerAttachments(IDS.venture, conversationOrigin(sessionId));
  return (
    <section aria-label={`Composer of ${sessionId}`}>
      <AttachmentTray
        items={attachments.items}
        onCancel={attachments.cancel}
        onRetry={attachments.retry}
        onDismiss={attachments.dismiss}
      />
      <AttachButton onFiles={attachments.attach} disabled={false} />
    </section>
  );
}

function renderConversations(sessionId: string) {
  const root = createRootRoute({ component: Outlet });
  const venture = createRoute({
    getParentRoute: () => root,
    path: 'ain/app/v/$ventureId',
    component: VentureLayout,
  });
  const conversation = createRoute({
    getParentRoute: () => venture,
    path: 'c/$sessionId',
    component: Conversation,
  });
  const router = createRouter({
    routeTree: root.addChildren([venture.addChildren([conversation])]),
    history: createMemoryHistory({ initialEntries: [`${BASE}/c/${sessionId}`] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const open = async (id: string) => {
    await act(async () => {
      router.history.push(`${BASE}/c/${id}`);
      await router.invalidate();
    });
    return screen.findByRole('region', { name: `Composer of ${id}` });
  };
  return { open };
}

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  FakeXhr.sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  stubFetch().mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'POST' && url.endsWith(`/ventures/${IDS.venture}/documents`)) {
      return Promise.resolve(
        json(
          {
            document: makeDocument({ filename: 'pilot-notes.md', status: 'pending_upload', chunkCount: 0 }),
            upload: {
              url: 'https://uploads.test/put',
              method: 'PUT',
              headers: { 'content-type': 'text/markdown' },
              expiresAt: '2026-10-01T12:05:00.000Z',
            },
          },
          201,
        ),
      );
    }
    if (method === 'POST' && url.endsWith(`/documents/${IDS.document}/complete`)) {
      return Promise.resolve(json(makeDocument({ status: 'processing' }), 202));
    }
    return Promise.resolve(json({ items: [] }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composer attachments', () => {
  it('keep uploading while the person opens another conversation, and show again on return', async () => {
    const { open } = renderConversations(S1);
    const first = await screen.findByRole('region', { name: `Composer of ${S1}` });
    const input = first.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('no file input');
    await userEvent
      .setup()
      .upload(input, new File(['# Pilot notes'], 'pilot-notes.md', { type: 'text/markdown' }));
    await waitFor(() => {
      expect(FakeXhr.sent).toHaveLength(1);
    });
    const put = FakeXhr.sent[0];
    if (!put) throw new Error('no PUT');

    // Another conversation: its composer has no uploads of its own, and the first one's goes on.
    const second = await open(S2);
    expect(within(second).queryByRole('list', { name: 'Documents being added' })).toBeNull();
    expect(put.aborted).toBe(false);
    expect(calls.some((c) => c.includes('/abandon') || c.startsWith('DELETE'))).toBe(false);

    // Back in the first conversation, the upload shows in its composer, and finishes there.
    const again = await open(S1);
    const tray = within(again).getByRole('list', { name: 'Documents being added' });
    expect(tray).toHaveTextContent('pilot-notes.md');
    act(() => {
      put.succeed();
    });
    await waitFor(() => {
      expect(tray).toHaveTextContent('Added to Documents');
    });
    expect(calls).toContain(`POST /api/v1/documents/${IDS.document}/complete`);
    expect(FakeXhr.sent).toHaveLength(1);
  });
});
