import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { BlockedPanel } from './blocked-panel';
import { IDS } from './testing';

/** The crisis path's support message as the API sends it (Markdown). */
const CRISIS = [
  'It sounds like you might be going through something really hard right now.',
  '',
  '- If you or anyone else is in immediate danger, call your local emergency number now (911 in the US).',
  '- In the US you can call or text **988** (Suicide & Crisis Lifeline) at any time, day or night.',
].join('\n');

async function renderInRouter(ui: ReactElement) {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  await screen.findByTestId('blocked-panel');
}

describe('BlockedPanel', () => {
  it('shows the crisis support message (as after a reload) with its resources and the drafted request', async () => {
    await renderInRouter(
      <BlockedPanel
        tenant="ain"
        ventureId={IDS.venture}
        supportMessage={CRISIS}
        reason="crisis_support"
        escalationId={IDS.ref}
        personaName="Corin"
      />,
    );
    expect(screen.getByRole('heading', { name: 'You deserve support from a person' })).toBeVisible();
    // Markdown, not raw text: list items and the emphasised crisis line.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('988').tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*988\*\*/)).toBeNull();
    const link = screen.getByRole('link', { name: 'View your request' });
    expect(link.getAttribute('href')).toContain(`id=${IDS.ref}`);
    expect(screen.getByText(/Nothing is shared until you consent/)).toBeVisible();
  });

  it('explains other reasons without blaming the founder and offers a human', async () => {
    const onRequestSupport = vi.fn();
    await renderInRouter(
      <BlockedPanel
        tenant="ain"
        ventureId={IDS.venture}
        supportMessage={null}
        reason="policy"
        escalationId={null}
        personaName="Corin"
        onRequestSupport={onRequestSupport}
      />,
    );
    expect(screen.getByRole('heading', { name: 'This answer was held back' })).toBeVisible();
    // The generic privacy wording never says the answer involved another venture.
    expect(screen.queryByText(/other venture/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Ask a person' }));
    expect(onRequestSupport).toHaveBeenCalledOnce();
  });

  it('adds emergency guidance for a safety reason that came without a message', async () => {
    await renderInRouter(
      <BlockedPanel
        tenant="ain"
        ventureId={IDS.venture}
        supportMessage={null}
        reason="safety_wellbeing"
        escalationId={null}
        personaName="Corin"
      />,
    );
    expect(screen.getByText(/contact your local emergency number/)).toBeVisible();
  });
});
