import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inspector, InspectorProvider } from '@/components/shell/inspector';
import { ShellChromeContext } from '@/components/shell/shell-chrome';
import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { IDS, makeSession } from '../coach/testing';
import { ConversationHeader } from './conversation-header';

async function renderHeader(privacy: 'standard' | 'ephemeral', phone = false) {
  const session = makeSession({ privacy, status: 'active', endedAt: null });
  const header = (
    <InspectorProvider>
      <ConversationHeader
        tenant="ain"
        ventureId={IDS.venture}
        session={session}
        title="Pricing per library"
        veir={{
          name: 'Thomas',
          shortName: 'Thomas',
          kind: 'eir_persona',
          presentation: 'mentor',
          eirFirstName: 'Corin',
          firstPerson: true,
          eirSeesWork: true,
        }}
        canEdit
        onAction={vi.fn()}
        calls={
          <div role="group" aria-label="Call">
            <button type="button">Voice call with Thomas</button>
            <button type="button">Video call with Thomas</button>
          </div>
        }
      />
      <Inspector title="Context" label="context panel">
        <p>Stage</p>
      </Inspector>
    </InspectorProvider>
  );
  // On a phone the header is the only bar: the shell's chrome is there.
  const ui = phone ? (
    <ShellChromeContext.Provider
      value={{
        openNavigation: vi.fn(),
        claimMobileBar: () => () => undefined,
        claimBreathingGround: () => () => undefined,
      }}
    >
      {header}
    </ShellChromeContext.Provider>
  ) : (
    header
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  return screen.findByRole('heading', { level: 1, name: 'Pricing per library' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('shows the mentor by its name alone: no face, no vEIR badge, no disclaimer line', async () => {
    const heading = await renderHeader('standard');
    const header = heading.closest('header');
    if (!header) throw new Error('no header');
    expect(within(header).getAllByText('Thomas').length).toBeGreaterThan(0);
    expect(header).not.toHaveTextContent(/vEIR/);
    expect(header.querySelector('[data-slot="persona-avatar"], [data-slot="veir-badge"]')).toBeNull();
    expect(screen.queryByRole('note', { name: 'AI disclosure' })).toBeNull();
  });

  it('sits on the bars’ glass, dense enough for its text over the prose scrolling under it', async () => {
    const heading = await renderHeader('standard');
    expect(heading.closest('header')).toHaveClass('glass-bar');
  });

  it('keeps three icons after the title on a phone: Voice call, Video call and More (New chat and the panel in it)', async () => {
    // A phone: no width query matches.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const heading = await renderHeader('standard', true);
    const header = heading.closest('header');
    if (!header) throw new Error('no header');
    const trailing = header.querySelector('[data-slot="header-actions"]');
    if (!(trailing instanceof HTMLElement)) throw new Error('no trailing controls');
    expect(
      within(trailing)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['Voice call with Thomas', 'Video call with Thomas', 'Conversation options']);
    expect(within(header).queryByRole('link', { name: 'New chat' })).toBeNull();
    await userEvent.setup().click(within(header).getByRole('button', { name: 'Conversation options' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'New chat' })).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: 'Show context panel' })).toBeVisible();
  });
});
