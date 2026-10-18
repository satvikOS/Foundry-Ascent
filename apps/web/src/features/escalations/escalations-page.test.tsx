import type { EscalationView, Me } from '@foundry/contracts';
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
import { beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { json, stubFetch, testQueryClient } from '@/features/knowledge/test-utils';
import { IDS } from '@/features/knowledge/testing';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { ventureEscalationsQueryOptions } from '@/lib/api/hooks/escalations';

import { EscalationsPage } from './escalations-page';

const ME: Me = {
  principal: { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: IDS.venture, ventureName: 'QuietQuad', role: 'founder' }],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
};

const REQUEST: EscalationView = {
  id: IDS.escalation,
  ventureId: IDS.venture,
  ventureName: 'QuietQuad',
  sessionId: null,
  turnId: null,
  category: 'legal',
  priority: 'P2',
  status: 'routed',
  requestedRole: 'eir',
  packet: null,
  sharingConsentAt: '2026-10-01T12:05:00.000Z',
  assignee: null,
  dueAt: null,
  resolution: null,
  createdBy: { id: IDS.principal, displayName: 'Maya', title: null, synthetic: true },
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:05:00.000Z',
};

beforeEach(() => {
  stubFetch().mockImplementation(() => Promise.resolve(json({ items: [] })));
});

async function renderHelp(items: EscalationView[], search = '') {
  const client = testQueryClient();
  client.setQueryData(meQueryOptions().queryKey, ME);
  client.setQueryData(ventureEscalationsQueryOptions(IDS.venture).queryKey, { items });
  const root = createRootRoute({ component: Outlet });
  const venture = createRoute({ getParentRoute: () => root, path: '$tenant/app/v/$ventureId' });
  const help = createRoute({ getParentRoute: () => venture, path: 'help', component: EscalationsPage });
  const router = createRouter({
    routeTree: root.addChildren([venture.addChildren([help])]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${IDS.venture}/help${search}`] }),
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
}

describe('Human help', () => {
  it('shows no requests as one line and its one action, Ask a person', async () => {
    await renderHelp([]);
    const heading = await screen.findByRole('heading', { level: 2, name: 'No requests yet' });
    const empty = heading.closest<HTMLElement>('[data-slot="empty-state"]');
    if (!empty) throw new Error('no empty state');
    expect(within(empty).getByRole('button', { name: 'Ask a person' })).toBeVisible();
    // The header does not repeat it, and the consent line stays on the page.
    expect(screen.getAllByRole('button', { name: 'Ask a person' })).toHaveLength(1);
    expect(screen.getByText('Nothing is shared without your consent.')).toBeVisible();
  });

  it('keeps Ask a person in the header once there are requests', async () => {
    await renderHelp([REQUEST]);
    const header = (await screen.findByRole('heading', { level: 1, name: 'Human help' })).closest('header');
    if (!header) throw new Error('no header');
    expect(within(header).getByRole('button', { name: 'Ask a person' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Ask a person' })).toHaveLength(1);
  });

  it('a request that is not here: Back, named for where it goes', async () => {
    await renderHelp([REQUEST], '?id=0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e');
    expect(await screen.findByRole('heading', { name: 'Request not found' })).toBeVisible();
    const back = screen.getByRole('button', { name: 'Back to the list' });
    // Short on screen; the name starts with the words shown (speech input can say what it sees).
    expect(back).toHaveTextContent(/^Back$/);
  });
});
