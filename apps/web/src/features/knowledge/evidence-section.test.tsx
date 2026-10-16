import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import { queryKeys } from '@/lib/api/query-keys';

import { EvidenceSection } from './evidence-section';
import { testQueryClient } from './test-utils';
import { IDS, makeDocument, makeEvidence, makeSession, makeTurnWithEvidence } from './testing';

const DOC_SOURCE = '11111111-1111-4111-8111-111111111111';
const HANDBOOK = '22222222-2222-4222-8222-222222222222';
const LIBRARY = '33333333-3333-4333-8333-333333333333';

async function renderEvidence() {
  const client = testQueryClient();
  client.setQueryData(queryKeys.venture.documents(IDS.venture), {
    items: [makeDocument({ filename: 'exam-week-interviews.md', sourceId: DOC_SOURCE })],
  });
  client.setQueryData(memoryQueryOptions(IDS.venture, { status: 'confirmed' }).queryKey, {
    items: [],
    nextCursor: null,
  });
  client.setQueryData(queryKeys.venture.sessions(IDS.venture), { items: [makeSession()] });
  client.setQueryData(queryKeys.session.detail(IDS.session), {
    session: makeSession(),
    turns: [
      makeTurnWithEvidence([
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          title: 'Program handbook — Interviews',
          source: { id: HANDBOOK, scope: 'program' },
        }),
        makeEvidence({
          key: 'E2',
          kind: 'doctrine',
          title: 'Doctrine — Evidence standard',
          source: { id: LIBRARY, scope: 'persona' },
        }),
      ]),
    ],
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId/knowledge',
    component: () => (
      <EvidenceSection ventureId={IDS.venture} tenant="ain" veirName="Corin’s vEIR" canReadConversations />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${IDS.venture}/knowledge?view=evidence`] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
  return router;
}

describe('Knowledge › Evidence', () => {
  it('opens a document in the viewer over Evidence', async () => {
    const router = await renderEvidence();
    const sources = await screen.findByRole('list', { name: 'Sources' });
    await userEvent.setup().click(within(sources).getByRole('link', { name: 'exam-week-interviews.md' }));
    expect(router.state.location.pathname).toBe(`/ain/app/v/${IDS.venture}/knowledge`);
    expect(router.state.location.search).toEqual({ view: 'evidence', doc: IDS.document });
  });

  it('opens program material the vEIR cited in the viewer, and keeps a vEIR library row plain', async () => {
    const router = await renderEvidence();
    const sources = await screen.findByRole('list', { name: 'Sources' });
    await userEvent.setup().click(within(sources).getByRole('link', { name: 'Program handbook' }));
    expect(router.state.location.search).toEqual({ view: 'evidence', src: HANDBOOK });
    expect(within(sources).getByText('Doctrine')).toBeInTheDocument();
    expect(within(sources).queryByRole('link', { name: 'Doctrine' })).toBeNull();
  });
});
