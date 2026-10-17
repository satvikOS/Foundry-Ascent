import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InspectorProvider } from '@/components/shell/inspector';
import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { IDS, makeSession } from '../coach/testing';
import { ConversationHeader } from './conversation-header';

async function renderHeader(privacy: 'standard' | 'ephemeral') {
  const session = makeSession({ privacy, status: 'active', endedAt: null });
  const ui = (
    <InspectorProvider>
      <ConversationHeader
        tenant="ain"
        ventureId={IDS.venture}
        session={session}
        title="Pricing per library"
        veir={{
          name: 'Corin · vEIR',
          shortName: 'Corin',
          badge: 'vEIR',
          kind: 'eir_persona',
          eirFirstName: 'Corin',
          firstPerson: true,
          eirSeesWork: true,
        }}
        canEdit
        onAction={vi.fn()}
      />
    </InspectorProvider>
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  return screen.findByRole('heading', { level: 1, name: 'Pricing per library' });
}

describe('ConversationHeader', () => {
  it('says quietly that a private conversation is private, on wide screens and phones', async () => {
    await renderHeader('ephemeral');
    expect(screen.getByTestId('private-indicator')).toHaveTextContent('Private');
    expect(screen.getByText('· Private')).toBeInTheDocument();
    expect(screen.queryByText(/Temporary/)).toBeNull();
  });

  it('shows no indicator for a remembered conversation', async () => {
    await renderHeader('standard');
    expect(screen.queryByTestId('private-indicator')).toBeNull();
    expect(screen.queryByText(/Private/)).toBeNull();
  });

  it('shows the vEIR as its name with a badge that explains it, and no disclaimer line', async () => {
    await renderHeader('standard');
    const badges = screen.getAllByRole('button', { name: 'vEIR: what is Corin · vEIR?' });
    expect(badges.length).toBeGreaterThan(0);
    expect(screen.queryByRole('note', { name: 'AI disclosure' })).toBeNull();
    const [badge] = badges;
    if (!badge) throw new Error('no vEIR badge');
    await userEvent.setup().click(badge);
    const about = await screen.findByRole('dialog', { name: 'About Corin · vEIR' });
    expect(about).toHaveTextContent(
      'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches. Corin sees what you work on here.',
    );
    expect(about).toHaveTextContent(
      'It isn’t Corin in person, and Corin doesn’t write or approve its replies.',
    );
  });

  it('sits on the shared glass surface', async () => {
    const heading = await renderHeader('standard');
    expect(heading.closest('header')).toHaveClass('glass');
  });
});
