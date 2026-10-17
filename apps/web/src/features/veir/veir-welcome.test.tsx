import type { Me } from '@foundry/contracts';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';
import { queryKeys } from '@/lib/api/query-keys';
import type { VeirDisplay } from '@/lib/veir';

import { VeirWelcomeDialog } from './veir-welcome';
import { useVeirWelcome } from './welcome';

const AT = '2026-10-17T10:00:00.000Z';

const ME: Me = {
  principal: {
    id: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
    displayName: 'Maya Example',
    title: null,
    synthetic: true,
  },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
  veirWelcomeAcknowledgedAt: null,
};

const CORIN: VeirDisplay = {
  personaId: '7c8d9e0f-1a2b-4c3d-8e4f-6a7b8c9d0e08',
  name: 'Corin · vEIR',
  shortName: 'Corin',
  badge: 'vEIR',
  kind: 'eir_persona',
  eirFirstName: 'Corin',
  firstPerson: true,
  eirSeesWork: true,
  disclosure: 'AI',
  portraitUrl: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VeirWelcomeDialog', () => {
  it('says what a vEIR is in two short sentences, once, and any way of closing it counts as read', async () => {
    const onAcknowledge = vi.fn();
    renderWithProviders(<VeirWelcomeDialog veir={CORIN} open onAcknowledge={onAcknowledge} />);
    const dialog = await screen.findByRole('dialog', { name: 'Meet Corin’s vEIR' });
    expect(dialog).toHaveAccessibleDescription(
      'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches. Corin sees what you work on here.',
    );
    // Calm: one button, no close cross, no legal sentence.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Continue']);
    expect(dialog).not.toHaveTextContent(/not a person|No human wrote/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue' }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('counts Escape as read too', async () => {
    const onAcknowledge = vi.fn();
    renderWithProviders(<VeirWelcomeDialog veir={CORIN} open onAcknowledge={onAcknowledge} />);
    await screen.findByRole('dialog');
    await userEvent.setup().keyboard('{Escape}');
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });
});

describe('useVeirWelcome', () => {
  function setup(me: Me) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.me(), me);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, ...renderHook(() => useVeirWelcome(me), { wrapper }) };
  }

  it('stores the welcome with the person on the server and closes it at once', async () => {
    const fetchMock = stubFetch();
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    const { client, result } = setup(ME);
    expect(result.current[0]).toBe(false);
    act(() => {
      result.current[1]();
    });
    // Closed before the server answers.
    await waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
    answer(jsonResponse({ acknowledgedAt: AT }));
    await waitFor(() => {
      expect(client.getQueryData<Me>(queryKeys.me())?.veirWelcomeAcknowledgedAt).toBe(AT);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof Request ? url.url : url?.toString()).toBe('/api/v1/me/veir-welcome/acknowledge');
    expect(init?.method).toBe('POST');
    // Already read: nothing more is sent.
    act(() => {
      result.current[1]();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts a person an older API did not report as having read it', () => {
    const { veirWelcomeAcknowledgedAt: _omitted, ...older } = ME;
    stubFetch();
    const { result } = setup(older);
    expect(result.current[0]).toBe(true);
  });
});
