import type { Me } from '@foundry/contracts';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';
import { queryKeys } from '@/lib/api/query-keys';
import type { VeirDisplay } from '@/lib/veir';

import { VeirWelcomeDialog } from './veir-welcome';
import { useVeirWelcome, welcomeSeen } from './welcome';

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
  name: 'Thomas',
  shortName: 'Thomas',
  kind: 'eir_persona',
  presentation: 'mentor',
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
  it('says what the mentor is in two short sentences, once, and any way of closing it counts as read', async () => {
    const onAcknowledge = vi.fn();
    renderWithProviders(<VeirWelcomeDialog veir={CORIN} open onAcknowledge={onAcknowledge} />);
    const dialog = await screen.findByRole('dialog', { name: 'Meet Thomas' });
    // A mentor (ADR-0021): the program wrote and approved his approach; no EIR is said to have written or reviewed it.
    expect(dialog).toHaveAccessibleDescription(
      'Thomas is an AI mentor, not a person. The program wrote and approved the coaching approach Thomas follows; no person writes or approves individual replies. Corin, your entrepreneur-in-residence, sees what you work on here, and a person from the program is there when you need one.',
    );
    // Calm: one button, no close cross.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Continue']);
    expect(dialog).not.toHaveTextContent(/consent|their review|No human wrote|vEIR/);
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

describe('welcomeSeen', () => {
  const twin = `${CORIN.personaId}:twin`;
  const mentor = `${CORIN.personaId}:mentor`;

  it('introduces each mentor once, and again when the same persona is presented differently', () => {
    const read = { ...ME, veirWelcomeAcknowledgedAt: AT };
    // Someone who read "Meet Corin's vEIR" (the persona as a twin) meets Thomas (the same persona, a mentor).
    expect(welcomeSeen({ ...read, veirWelcomeIntroductions: [twin] }, CORIN)).toBe(false);
    expect(welcomeSeen({ ...read, veirWelcomeIntroductions: [twin, mentor] }, CORIN)).toBe(true);
    expect(
      welcomeSeen({ ...read, veirWelcomeIntroductions: [twin] }, { ...CORIN, presentation: 'twin' }),
    ).toBe(true);
    // Another venture's mentor is introduced on its own.
    expect(
      welcomeSeen({ ...read, veirWelcomeIntroductions: [mentor] }, { ...CORIN, personaId: ME.tenant.id }),
    ).toBe(false);
  });

  it('has nothing to introduce without a mentor, and falls back to the one acknowledgement of an older API', () => {
    expect(welcomeSeen(ME, null)).toBe(true);
    expect(welcomeSeen(ME, CORIN)).toBe(false);
    expect(welcomeSeen({ ...ME, veirWelcomeAcknowledgedAt: AT }, CORIN)).toBe(true);
    expect(welcomeSeen({ ...ME, veirWelcomeIntroductions: [] }, CORIN)).toBe(false);
    // A placeholder without a persona id: only the one acknowledgement says.
    const placeholder = { presentation: 'mentor' } as const;
    expect(welcomeSeen({ ...ME, veirWelcomeIntroductions: [] }, placeholder)).toBe(false);
    expect(
      welcomeSeen({ ...ME, veirWelcomeAcknowledgedAt: AT, veirWelcomeIntroductions: [] }, placeholder),
    ).toBe(true);
  });
});

describe('useVeirWelcome', () => {
  function setup(me: Me) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.me(), me);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, ...renderHook(() => useVeirWelcome(me, CORIN), { wrapper }) };
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
    // This mentor's introduction, by persona.
    expect(sentJson(init)).toEqual({ personaId: CORIN.personaId });
    // Already read: nothing more is sent.
    act(() => {
      result.current[1]();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the introductions the server reports, so Thomas is introduced once to someone who met the twin', async () => {
    const fetchMock = stubFetch();
    const introductions = [`${CORIN.personaId}:twin`, `${CORIN.personaId}:mentor`];
    fetchMock.mockResolvedValue(jsonResponse({ acknowledgedAt: AT, introductions }));
    const { client, result } = setup({
      ...ME,
      veirWelcomeAcknowledgedAt: AT,
      veirWelcomeIntroductions: [`${CORIN.personaId}:twin`],
    });
    expect(result.current[0]).toBe(false);
    act(() => {
      result.current[1]();
    });
    await waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
    await waitFor(() => {
      expect(client.getQueryData<Me>(queryKeys.me())?.veirWelcomeIntroductions).toEqual(introductions);
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
