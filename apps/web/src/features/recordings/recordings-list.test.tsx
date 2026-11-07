import type { RecordingView } from '@foundry/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { testQueryClient } from '@/features/knowledge/test-utils';
import { IDS } from '@/features/knowledge/testing';

import { RecordingsList } from './recordings-list';

const RECORDING: RecordingView = {
  id: '55555555-5555-4555-8555-555555555555',
  callId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  ventureId: IDS.venture,
  conversationTitle: 'Pilot pricing',
  mimeType: 'video/webm',
  kind: 'video',
  bytes: 3_250_000,
  durationMs: 125_000,
  hasCaptions: true,
  status: 'ready',
  createdAt: '2026-11-06T12:00:00.000Z',
  completedAt: '2026-11-06T12:00:05.000Z',
};

/** `ui` on the venture's Recordings page of a memory router (its links and params are the app's). */
async function renderOnRecordings(ui: ReactElement) {
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: '/$tenant/app/v/$ventureId/recordings',
    component: () => ui,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${IDS.venture}/recordings`] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={testQueryClient()}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RecordingsList', () => {
  it('lists each recording with when, its conversation, length, kind and size, and Watch opens its viewer', async () => {
    await renderOnRecordings(<RecordingsList items={[RECORDING]} showConversation label="Your recordings" />);
    const row = within(await screen.findByRole('list', { name: 'Your recordings' })).getByRole('listitem');
    expect(row).toHaveTextContent('Pilot pricing');
    expect(row).toHaveTextContent('2:05');
    expect(row).toHaveTextContent('Video');
    expect(row).toHaveTextContent('3.1 MB');
    expect(within(row).getByRole('link', { name: /^Watch the recording from / })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/recordings/${RECORDING.id}`,
    );
  });

  it('downloads the recording or its transcript through a link signed when it is asked for', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        jsonResponse({
          url: `https://recordings.test/${urlOf(input).includes('file=transcript') ? 'captions.vtt' : 'call.webm'}?sig=1`,
          expiresAt: '2026-11-06T12:05:00.000Z',
          filename: 'Thomas call 2026-11-06 12-00.webm',
        }),
      ),
    );
    const followed: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      followed.push(this.href);
    });
    const user = userEvent.setup();
    await renderOnRecordings(<RecordingsList items={[RECORDING]} label="Recordings of this conversation" />);
    // Nothing is signed before someone asks.
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Download the recording from / }));
    await user.click(await screen.findByRole('menuitem', { name: /^Recording/ }));
    await waitFor(() => {
      expect(followed).toEqual(['https://recordings.test/call.webm?sig=1']);
    });
    const asked = new URL(urlOf(fetchMock.mock.calls[0]?.[0] ?? ''), 'http://localhost');
    expect(asked.pathname).toBe(`/api/v1/recordings/${RECORDING.id}/download`);
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      file: 'recording',
      name: 'Thomas',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    await user.click(screen.getByRole('button', { name: /^Download the recording from / }));
    await user.click(await screen.findByRole('menuitem', { name: /^Transcript/ }));
    await waitFor(() => {
      expect(followed).toHaveLength(2);
    });
    expect(followed[1]).toBe('https://recordings.test/captions.vtt?sig=1');
    expect(urlOf(fetchMock.mock.calls[1]?.[0] ?? '')).toContain('file=transcript');
  });

  it('a recording without a transcript downloads at once', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({
        url: 'https://recordings.test/call.webm?sig=1',
        expiresAt: '2026-11-06T12:05:00.000Z',
        filename: 'Call.webm',
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    await renderOnRecordings(
      <RecordingsList
        items={[{ ...RECORDING, hasCaptions: false }]}
        label="Recordings of this conversation"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Download the recording from / }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('deletes a recording after confirming', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    await renderOnRecordings(<RecordingsList items={[RECORDING]} label="Recordings of this conversation" />);
    await user.click(screen.getByRole('button', { name: /^Delete the recording from / }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this recording?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete recording' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input === undefined ? '' : urlOf(input)).toContain(`/recordings/${RECORDING.id}`);
    expect(init?.method).toBe('DELETE');
  });
});
