import type { Me } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json, renderWithRouter, stubFetch } from '@/features/knowledge/test-utils';
import { IDS, makeSession, makeVenture } from '@/features/knowledge/testing';

import { CommandPalette, type PaletteScope } from './command-palette';

// Signing out and the call settings are not what these tests are about.
vi.mock('./account-menu', () => ({ useSignOutAndRedirect: () => ({ signOut: vi.fn() }) }));
vi.mock('@/features/calls/call-entry', () => ({
  useCallEntry: () => ({
    callable: true,
    name: 'Thomas',
    video: { available: false, reason: 'Video isn’t available for you yet. Voice works.' },
  }),
}));

const founder: Me = {
  principal: { id: IDS.principal, displayName: 'Maya', title: null, synthetic: true },
  tenant: { id: '44444444-4444-4444-8444-444444444444', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: IDS.venture, ventureName: 'QuietQuad', role: 'founder' }],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
};

const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

beforeEach(() => {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input) => {
    const url = urlOf(input);
    if (url.startsWith('/api/v1/sessions?')) {
      return Promise.resolve(
        json({
          items: [
            makeSession(),
            makeSession({ id: IDS.session2, title: 'Pricing the pilot', status: 'active', endedAt: null }),
          ],
          nextCursor: null,
        }),
      );
    }
    if (url.startsWith('/api/v1/ventures')) return Promise.resolve(json({ items: [makeVenture()] }));
    return Promise.resolve(json({ items: [] }));
  });
});

function Palette({
  initialScope = 'all',
  onToggleSidebar = vi.fn(),
}: {
  initialScope?: PaletteScope;
  onToggleSidebar?: () => void;
}) {
  const [scope, setScope] = useState<PaletteScope>(initialScope);
  return (
    <CommandPalette
      me={founder}
      workspace={{ kind: 'venture', ventureId: IDS.venture }}
      open
      onOpenChange={vi.fn()}
      onOpenShortcuts={vi.fn()}
      onToggleSidebar={onToggleSidebar}
      scope={scope}
      onScopeChange={setScope}
    />
  );
}

describe('CommandPalette', () => {
  it('lists every action of the venture with its shortcut where it has one', async () => {
    await renderWithRouter(<Palette />);
    const dialog = await screen.findByRole('dialog');
    const voice = await within(dialog).findByRole('option', { name: /^Voice call with Thomas/ });
    expect(voice).toHaveTextContent(/GV$/);
    // Video is listed, disabled, with why.
    const video = within(dialog).getByRole('option', { name: /^Video call with Thomas/ });
    expect(video).toHaveAttribute('aria-disabled', 'true');
    expect(video).toHaveTextContent('Video isn’t available for you yet.');
    expect(within(dialog).getByRole('option', { name: /^New chat/ })).toHaveTextContent(/GN$/);
    expect(within(dialog).getByRole('option', { name: /^Venture/ })).toHaveTextContent(/GS$/);
    expect(within(dialog).getByRole('option', { name: /^Toggle sidebar/ })).toHaveTextContent(/\[$/);
    for (const name of ['Add a memory', 'Ask a person', 'Export learning']) {
      expect(within(dialog).getByRole('option', { name })).toBeInTheDocument();
    }
    // The latest ended conversation of this venture has a summary to open.
    expect(
      await within(dialog).findByRole('option', { name: 'Open the latest session summary' }),
    ).toBeInTheDocument();
    // "Venture settings" is the Venture page now: one entry, not two.
    expect(within(dialog).queryByRole('option', { name: 'Venture settings' })).toBeNull();
  });

  it('toggles the side panel from its action', async () => {
    const toggle = vi.fn();
    await renderWithRouter(<Palette onToggleSidebar={toggle} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('option', { name: /^Toggle sidebar/ }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('opened from "View all", lists only conversations, and Backspace in the empty field widens it', async () => {
    await renderWithRouter(<Palette initialScope="conversations" />);
    const input = await screen.findByRole('combobox', { name: 'Search conversations' });
    await screen.findByRole('option', { name: 'Pricing the pilot' });
    expect(
      screen.getByRole('option', { name: 'Is exam-week demand strong enough for a pilot?' }),
    ).toBeVisible();
    expect(screen.queryByRole('option', { name: /^New chat/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /^Toggle sidebar/ })).toBeNull();

    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard('{Backspace}');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Search conversations, pages and actions' })).toBeVisible();
    });
    expect(screen.getByRole('option', { name: /^New chat/ })).toBeInTheDocument();
  });
});
