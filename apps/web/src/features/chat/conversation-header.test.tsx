import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen } from '@testing-library/react';
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
        personaName="Corin’s vEIR"
        personaKind="eir_persona"
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
    expect(screen.getByText(/· AI · Private$/)).toBeInTheDocument();
    expect(screen.queryByText(/Temporary/)).toBeNull();
  });

  it('shows no indicator for a remembered conversation', async () => {
    await renderHeader('standard');
    expect(screen.queryByTestId('private-indicator')).toBeNull();
    expect(screen.queryByText(/Private/)).toBeNull();
  });

  it('sits on the shared glass surface', async () => {
    const heading = await renderHeader('standard');
    expect(heading.closest('header')).toHaveClass('glass');
  });
});
