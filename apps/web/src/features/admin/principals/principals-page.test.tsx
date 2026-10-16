import type { Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
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
    ...rest,
  };
}

const ROWS: AdminPrincipal[] = [
  row({ id: ME_ID, name: 'Local Owner', roles: ['platform_admin'] }),
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

function renderPage() {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ items: ROWS })));
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
});
