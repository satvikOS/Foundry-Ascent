import type { RecordingView } from '@foundry/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { testQueryClient } from '@/features/knowledge/test-utils';
import { IDS } from '@/features/knowledge/testing';

import { RecordingViewerPage } from './recording-viewer-page';

const OTHER_VENTURE = '99999999-9999-4999-8999-999999999999';

const RECORDING: RecordingView = {
  id: '55555555-5555-4555-8555-555555555555',
  callId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  ventureId: IDS.venture,
  conversationTitle: 'Pilot pricing',
  mimeType: 'video/mp4',
  kind: 'video',
  bytes: 3_250_000,
  durationMs: 125_000,
  hasCaptions: false,
  status: 'ready',
  createdAt: '2026-11-06T12:00:00.000Z',
  startedAt: '2026-11-06T11:57:55.000Z',
  completedAt: '2026-11-06T12:00:05.000Z',
};

/** The viewer in a memory router at `ventureId`'s path (its route id, path and params are the app's). */
async function renderViewer(ventureId: string) {
  const root = createRootRoute();
  const venture = createRoute({ getParentRoute: () => root, path: '/$tenant/app/v/$ventureId' });
  // As the generated route tree has it: its own id (out of Recordings' layout), at Recordings' path.
  const viewer = createRoute({
    getParentRoute: () => venture,
    path: '/recordings/$recordingId',
    component: RecordingViewerPage,
  }).update({ id: '/recordings_/$recordingId' } as never);
  const router = createRouter({
    routeTree: root.addChildren([venture.addChildren([viewer])]),
    history: createMemoryHistory({
      initialEntries: [`/ain/app/v/${ventureId}/recordings/${RECORDING.id}`],
    }),
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
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecordingViewerPage', () => {
  it('shows a recording under its own venture: a path of another venture moves there, and its links are its own', async () => {
    stubFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          recording: RECORDING,
          media: { url: 'https://recordings.test/call.mp4?sig=1', expiresAt: '2026-11-06T13:00:00.000Z' },
          captions: null,
        }),
      ),
    );
    const router = await renderViewer(OTHER_VENTURE);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/ain/app/v/${IDS.venture}/recordings/${RECORDING.id}`);
    });
    expect(await screen.findByRole('link', { name: 'Open conversation' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/c/${RECORDING.sessionId}`,
    );
    expect(screen.getByRole('link', { name: 'Recordings' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/recordings`,
    );
  });
});
