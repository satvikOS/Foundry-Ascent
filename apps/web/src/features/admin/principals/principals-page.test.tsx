import type { Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, sentJson, stubFetch } from '@/features/admin/shared/test-utils';
import type { AdminPrincipal } from '@/lib/api/hooks/admin';
import { queryKeys } from '@/lib/api/query-keys';

import { PrincipalsPage } from './principals-page';

const ME_ID = '33333333-3333-4333-8333-333333333333';

const ME: Me = {
  principal: { id: ME_ID, displayName: 'Local Owner', title: null, synthetic: true },
  tenant: { id: '44444444-4444-4444-8444-444444444444', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: ['platform_admin'],
  memberships: [],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
};

function row(overrides: Partial<AdminPrincipal> & { name: string; id: string }): AdminPrincipal {
  const { name, id, ...rest } = overrides;
  return {
    principal: { id, displayName: name, title: null, synthetic: true },
    email: null,
    status: 'active',
    roles: [],
    memberships: [],
    activeAccessCodes: [],
    faceAccess: false,
    ...rest,
  };
}

const ROWS: AdminPrincipal[] = [
  row({ id: ME_ID, name: 'Local Owner', roles: ['platform_admin'], faceAccess: true }),
  row({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Maya Okafor-Lindqvist',
    memberships: [
      { ventureId: '66666666-6666-4666-8666-666666666666', ventureName: 'QuietQuad', role: 'founder' },
    ],
  }),
  row({ id: '77777777-7777-4777-8777-777777777777', name: 'Former Member', status: 'disabled' }),
  row({
    id: '88888888-8888-4888-8888-888888888888',
    name: 'Corin Halvorsen',
    roles: ['eir'],
    activeAccessCodes: [
      {
        id: '99999999-9999-4999-8999-999999999991',
        prefix: 'FA-ABCDE',
        label: 'Laptop',
        expiresAt: null,
        lastUsedAt: null,
        createdAt: '2026-10-01T12:00:00.000Z',
      },
      {
        id: '99999999-9999-4999-8999-999999999992',
        prefix: 'FA-FGHJK',
        label: 'Phone',
        expiresAt: null,
        lastUsedAt: null,
        createdAt: '2026-10-02T12:00:00.000Z',
      },
    ],
  }),
];

function urlOf(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return '';
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function renderPage() {
  const fetchMock = stubFetch();
  let rows = ROWS;
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    const patched = /\/admin\/principals\/([0-9a-f-]{36})$/.exec(url);
    if (init?.method === 'PATCH' && patched) {
      const body = sentJson(init) as { faceAccess: boolean };
      rows = rows.map((r) => (r.principal.id === patched[1] ? { ...r, faceAccess: body.faceAccess } : r));
      return Promise.resolve(jsonResponse(rows.find((r) => r.principal.id === patched[1])));
    }
    return Promise.resolve(jsonResponse({ items: rows }));
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(queryKeys.me(), ME);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PrincipalsPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

function rowOf(name: string): HTMLElement {
  const cell = screen.getByText(name, { selector: 'span' });
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`No row for ${name}`);
  return tr;
}

describe('PrincipalsPage (Admin → People & access)', () => {
  it('marks only disabled accounts, with no status column for everyone else', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByText('Active', { exact: true })).not.toBeInTheDocument();

    const disabled = rowOf('Former Member');
    expect(within(disabled).getByText('Disabled')).toBeInTheDocument();
    expect(within(rowOf('Maya Okafor-Lindqvist')).queryByText('Disabled')).not.toBeInTheDocument();

    // A disabled account cannot be issued a code.
    await userEvent.click(within(disabled).getByRole('button', { name: 'Actions for Former Member' }));
    expect(await screen.findByRole('menuitem', { name: 'Issue access code…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows empty cells as a dash that still reads as words to assistive technology', async () => {
    renderPage();
    await screen.findByRole('table');
    const maya = rowOf('Maya Okafor-Lindqvist');
    // No platform roles and no codes: a quiet dash, the meaning kept for screen readers.
    expect(within(maya).getByText('Venture access only')).toHaveClass('sr-only');
    expect(within(maya).getByText('No active codes')).toHaveClass('sr-only');
    expect(within(maya).getAllByText('—')).toHaveLength(2);
    expect(within(maya).getByText('QuietQuad')).toBeVisible();
  });

  it('keeps each row’s actions in one menu: issue a code, or revoke one of its active codes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const corin = rowOf('Corin Halvorsen');
    // No inline action buttons: one menu button per row, named for the person.
    expect(within(corin).getAllByRole('button')).toHaveLength(1);
    expect(within(corin).getByText('Laptop')).toBeInTheDocument();

    await user.click(within(corin).getByRole('button', { name: 'Actions for Corin Halvorsen' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Issue access code…' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Issue access code…', 'Revoke “Laptop”…', 'Revoke “Phone”…']);

    // Revoking asks first and names the code.
    await user.click(within(menu).getByRole('menuitem', { name: 'Revoke “Phone”…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke this access code?' });
    expect(confirm).toHaveTextContent('FA-FGHJK-•••••-•••••-•••••');
    expect(confirm).toHaveTextContent('Corin Halvorsen');

    // A person without codes gets only the issue action.
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await user.click(
      within(rowOf('Maya Okafor-Lindqvist')).getByRole('button', {
        name: 'Actions for Maya Okafor-Lindqvist',
      }),
    );
    const mayaMenu = await screen.findByRole('menu');
    expect(
      within(mayaMenu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Issue access code…']);
  });

  it('gives one person the video face with a switch, asking only when turning it on', async () => {
    const user = userEvent.setup();
    const fetchMock = renderPage();
    await screen.findByRole('table');
    expect(screen.getByRole('columnheader', { name: 'Video face' })).toBeInTheDocument();
    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

    // Label in name: the visible column header starts each switch's name.
    const maya = within(rowOf('Maya Okafor-Lindqvist')).getByRole('switch', {
      name: 'Video face for Maya Okafor-Lindqvist',
    });
    expect(maya).not.toBeChecked();
    expect(
      within(rowOf('Local Owner')).getByRole('switch', { name: 'Video face for Local Owner' }),
    ).toBeChecked();

    // Turning it on asks first; Cancel changes nothing.
    await user.click(maya);
    let confirm = await screen.findByRole('alertdialog', { name: 'Turn on video face?' });
    expect(confirm).toHaveTextContent('Maya Okafor-Lindqvist');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(patches()).toHaveLength(0);
    expect(maya).not.toBeChecked();

    await user.click(maya);
    confirm = await screen.findByRole('alertdialog', { name: 'Turn on video face?' });
    await user.click(within(confirm).getByRole('button', { name: 'Turn on' }));
    await vi.waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    const [url, init] = patches()[0] ?? [];
    expect(urlOf(url)).toMatch(/\/admin\/principals\/55555555-5555-4555-8555-555555555555$/);
    expect(sentJson(init)).toEqual({ faceAccess: true });
    expect(
      await within(rowOf('Maya Okafor-Lindqvist')).findByRole('switch', { checked: true }),
    ).toBeInTheDocument();

    // Turning it off needs no confirmation.
    await user.click(within(rowOf('Maya Okafor-Lindqvist')).getByRole('switch'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(patches()).toHaveLength(2);
    });
    expect(sentJson(patches()[1]?.[1])).toEqual({ faceAccess: false });
    expect(
      await within(rowOf('Maya Okafor-Lindqvist')).findByRole('switch', { checked: false }),
    ).toBeInTheDocument();
  });
});
