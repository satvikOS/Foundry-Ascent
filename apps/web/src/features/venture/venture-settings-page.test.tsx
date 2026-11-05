import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Me } from '@foundry/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bodyOf, json, renderWithRouter, stubFetch, testQueryClient } from '@/features/knowledge/test-utils';
import { IDS, makeVenture } from '@/features/knowledge/testing';
import { queryKeys } from '@/lib/api/query-keys';

import { VentureProfileCard, VentureSections } from './venture-settings-page';

function person(overrides: Partial<Me> = {}): Me {
  return {
    principal: { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true },
    tenant: { id: '44444444-4444-4444-8444-444444444444', slug: 'ain', name: 'AIN', kind: 'home' },
    roles: [],
    memberships: [],
    assignedVentureIds: [],
    disclosure: 'AI',
    aiEnabled: true,
    notices: [],
    ...overrides,
  };
}

let mockedMe: Me = person();
vi.mock('@/lib/auth/use-me', () => ({ useRequiredMe: () => mockedMe }));

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

function problem(status: number, code: string, detail: string, errors?: { path: string; message: string }[]) {
  return new Response(
    JSON.stringify({
      type: `urn:foundry-ascent:problem:${code}`,
      title: 'Conflict',
      status,
      code,
      detail,
      requestId: 'req-1',
      ...(errors ? { errors } : {}),
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const TAKEN = 'Another venture in this program already uses this name.';

async function rename(to: string) {
  await renderWithRouter(<VentureProfileCard venture={makeVenture()} editable />);
  const user = userEvent.setup();
  const name = screen.getByRole('textbox', { name: /Name/ });
  await user.clear(name);
  await user.type(name, to);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  return name;
}

describe('VentureProfileCard', () => {
  it('shows a name that is already taken on the Name field, not as a stale-page alert', async () => {
    fetchMock.mockResolvedValue(problem(409, 'conflict', TAKEN, [{ path: 'name', message: TAKEN }]));
    const name = await rename('SoleSignal');

    expect(await screen.findByText(TAKEN)).toBeVisible();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ name: 'SoleSignal' });
    // One message, on the field: nothing tells the founder to refresh (that would only drop the edit).
    expect(screen.queryByText(/Refresh and try again/)).toBeNull();
    expect(screen.queryByText('Couldn’t save the venture')).toBeNull();
  });

  it('keeps the form-level alert for a failure that names no field', async () => {
    fetchMock.mockResolvedValue(problem(409, 'conflict', 'The venture changed.'));
    await rename('QuietQuad Labs');

    expect(await screen.findByText('Couldn’t save the venture')).toBeVisible();
    expect(screen.getByText('This changed since you loaded it. Refresh and try again.')).toBeVisible();
  });

  it('clears the field-level refusal once a save goes through', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(409, 'conflict', TAKEN, [{ path: 'name', message: TAKEN }]))
      .mockResolvedValueOnce(json(makeVenture({ id: IDS.venture, name: 'QuietQuad Study' })));
    const name = await rename('SoleSignal');
    expect(await screen.findByText(TAKEN)).toBeVisible();

    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, 'QuietQuad Study');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(screen.queryByText(TAKEN)).toBeNull();
    });
    expect(screen.queryByText('Couldn’t save the venture')).toBeNull();
  });
});

describe('VentureSections: one page for the profile, the goal and the team', () => {
  const team = {
    venture: { id: IDS.venture, name: 'QuietQuad' },
    items: [
      {
        principal: { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true },
        role: 'founder',
        grantedAt: '2026-10-01T12:00:00.000Z',
        expiresAt: null,
      },
    ],
  };

  function answer(requests: string[]) {
    fetchMock.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push(url);
      if (url === `/api/v1/ventures/${IDS.venture}/team`) return Promise.resolve(json(team));
      return Promise.resolve(json({ items: [] }));
    });
  }

  it('shows a founder the profile, the current goal and the team, in that order', async () => {
    mockedMe = person({
      memberships: [{ ventureId: IDS.venture, ventureName: 'QuietQuad', role: 'founder' }],
    });
    answer([]);
    await renderWithRouter(<VentureSections ventureId={IDS.venture} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Venture' })).toBeVisible();
    await screen.findByRole('region', { name: 'Profile' });
    expect(screen.getAllByRole('region').map((region) => region.querySelector('h2')?.textContent)).toEqual([
      'Profile',
      'Current goal',
      'Team',
    ]);
    expect(await screen.findByRole('list', { name: 'Team members' })).toHaveTextContent(
      'Maya Okafor-Lindqvist',
    );
    expect(screen.getByRole('region', { name: 'Team' })).toHaveAttribute('id', 'team');
  });

  it('shows staff who are not on the venture its team only, and never asks for the venture', async () => {
    mockedMe = person({ roles: ['program_lead'] });
    const requests: string[] = [];
    answer(requests);
    const client = testQueryClient();
    client.removeQueries({ queryKey: queryKeys.venture.detail(IDS.venture) });
    await renderWithRouter(<VentureSections ventureId={IDS.venture} />, client);
    expect(await screen.findByRole('list', { name: 'Team members' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Profile' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Current goal' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeEnabled();
    expect(requests).not.toContain(`/api/v1/ventures/${IDS.venture}`);
    expect(screen.getByRole('button', { name: 'About Venture' })).toHaveAccessibleDescription(
      'Who is on QuietQuad and what each can see.',
    );
  });
});
