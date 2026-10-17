import type { Me } from '@foundry/contracts';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';
import { lesson } from '@/features/eir/personas/test-fixtures';
import { IDS, makeVenture } from '@/features/knowledge/testing';

import type { Workspace } from './nav';
import { SidebarContent } from './sidebar';

// The account menu (sign-out, theme, calls) is not what these tests are about.
vi.mock('./account-menu', () => ({ AccountMenu: () => null }));

const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

function me(roles: Me['roles']): Me {
  return {
    principal: {
      id: '33333333-3333-4333-8333-333333333333',
      displayName: 'Corin',
      title: null,
      synthetic: true,
    },
    tenant: { id: '44444444-4444-4444-8444-444444444444', slug: 'ain', name: 'AIN', kind: 'home' },
    roles,
    memberships: [],
    assignedVentureIds: [],
    disclosure: 'AI',
    aiEnabled: true,
    notices: [],
  };
}

function renderSidebar(person: Me, workspace: Workspace, total: number) {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input) => {
    const url = urlOf(input);
    if (url.startsWith('/api/v1/lessons?')) {
      return Promise.resolve(jsonResponse({ items: total > 0 ? [lesson()] : [], total }));
    }
    return Promise.resolve(jsonResponse({ items: [] }));
  });
  const noop = () => undefined;
  const rootRoute = createRootRoute({
    component: () => (
      <nav aria-label="Main">
        <SidebarContent
          me={person}
          workspace={workspace}
          onOpenSearch={noop}
          onOpenShortcuts={noop}
          onOpenDataUse={noop}
          onOpenReportProblem={noop}
        />
      </nav>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  return fetchMock;
}

describe('SidebarContent: Lessons to review', () => {
  it('counts the lessons waiting in every vEIR the person curates', async () => {
    const fetchMock = renderSidebar(me(['eir']), { kind: 'eir' }, 140);
    const link = await screen.findByRole('link', { name: /^Lessons to review/ });
    await waitFor(() => {
      expect(link).toHaveTextContent('Lessons to review140 to review');
    });
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toContain(
      '/api/v1/lessons?status=draft%2Cin_review',
    );
    // An EIR does not add EIRs.
    expect(screen.queryByRole('link', { name: 'EIRs' })).toBeNull();
  });

  it('shows no count when nothing waits, and EIRs to a program lead', async () => {
    renderSidebar(me(['program_lead']), { kind: 'eir' }, 0);
    expect(await screen.findByRole('link', { name: 'EIRs' })).toHaveAttribute('href', '/ain/app/eir/eirs');
    const link = screen.getByRole('link', { name: 'Lessons to review' });
    await waitFor(() => {
      expect(link).toHaveTextContent(/^Lessons to review$/);
    });
  });

  it('asks for nothing outside the EIR studio', async () => {
    const fetchMock = renderSidebar(me(['program_lead']), { kind: 'program' }, 3);
    await screen.findByRole('link', { name: 'Portfolio' });
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input)).some((url) => url.includes('/lessons'))).toBe(
      false,
    );
  });
});

describe('SidebarContent: venture destinations', () => {
  it('never counts memory to review on Knowledge (memory is kept automatically), only open help', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        urlOf(input) === `/api/v1/ventures/${IDS.venture}`
          ? jsonResponse(makeVenture({ pendingMemory: 3, openEscalations: 2 }))
          : jsonResponse({ items: [] }),
      ),
    );
    const founder: Me = {
      ...me([]),
      memberships: [{ ventureId: IDS.venture, ventureName: 'QuietQuad', role: 'founder' }],
    };
    const noop = () => undefined;
    const rootRoute = createRootRoute({
      component: () => (
        <nav aria-label="Main">
          <SidebarContent
            me={founder}
            workspace={{ kind: 'venture', ventureId: IDS.venture }}
            onOpenSearch={noop}
            onOpenShortcuts={noop}
            onOpenDataUse={noop}
            onOpenReportProblem={noop}
          />
        </nav>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    renderWithProviders(<RouterProvider router={router} />);
    const help = await screen.findByRole('link', { name: /^Human help/ });
    await waitFor(() => {
      expect(help).toHaveTextContent('2 open');
    });
    expect(screen.getByRole('link', { name: /^Knowledge/ })).toHaveTextContent(/^Knowledge$/);
    expect(screen.queryByText(/to review/)).toBeNull();
  });
  it('says nothing about conversations before the first one (New chat is right there)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        urlOf(input) === `/api/v1/ventures/${IDS.venture}`
          ? jsonResponse(makeVenture({ openEscalations: 0 }))
          : jsonResponse({ items: [] }),
      ),
    );
    const founder: Me = {
      ...me([]),
      memberships: [{ ventureId: IDS.venture, ventureName: 'QuietQuad', role: 'founder' }],
    };
    const noop = () => undefined;
    const rootRoute = createRootRoute({
      component: () => (
        <nav aria-label="Main">
          <SidebarContent
            me={founder}
            workspace={{ kind: 'venture', ventureId: IDS.venture }}
            onOpenSearch={noop}
            onOpenShortcuts={noop}
            onOpenDataUse={noop}
            onOpenReportProblem={noop}
          />
        </nav>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    renderWithProviders(<RouterProvider router={router} />);
    await screen.findByRole('link', { name: 'New chat' });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => urlOf(input).startsWith('/api/v1/sessions?'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Loading conversations/)).toBeNull();
    });
    expect(screen.queryByText(/conversations yet/i)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Recent conversations' })).toBeNull();
  });
});
