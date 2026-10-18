import type { Me, PersonaSummary } from '@foundry/contracts';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { VeirWelcomeGate } from './veir-welcome';
import { inlineWelcome } from './welcome';

const VENTURE = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c05';

const ME: Me = {
  principal: {
    id: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
    displayName: 'Maya Example',
    title: null,
    synthetic: true,
  },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: VENTURE, ventureName: 'QuietQuad', role: 'founder' }],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
  veirWelcomeAcknowledgedAt: null,
};

const PERSONA: Omit<PersonaSummary, 'name' | 'kind'> = {
  personaId: '7c8d9e0f-1a2b-4c3d-8e4f-6a7b8c9d0e08',
  releaseId: '8d9e0f1a-2b3c-4d4e-9f5a-7b8c9d0e1f09',
  version: 1,
  status: 'active',
  disclosure: 'AI',
  allowedModes: ['coach'],
};

let persona: PersonaSummary | null = null;

vi.mock('@/lib/auth/use-me', () => ({ useRequiredMe: () => ME }));
vi.mock('@/features/calls/call-context', () => ({ useCall: () => ({ route: null }) }));
vi.mock('@/lib/api/hooks/ventures', () => ({
  ventureQueryOptions: (id: string) => ({
    queryKey: ['venture', id],
    queryFn: () => Promise.resolve({ persona }),
  }),
}));

afterEach(() => {
  persona = null;
});

describe('VeirWelcomeGate', () => {
  it('welcomes the founders of a venture coached by the program’s neutral guide too, once', async () => {
    persona = { ...PERSONA, name: 'Foundry Guide', kind: 'neutral_guide', eirFirstName: null };
    renderWithProviders(<VeirWelcomeGate ventureId={VENTURE} />);
    const dialog = await screen.findByRole('dialog', { name: 'Meet Foundry Guide' });
    expect(dialog).toHaveAccessibleDescription(
      'The program’s AI coach, built on its coaching doctrine. It isn’t a person.',
    );
  });

  it('welcomes them to an EIR’s vEIR as its digital twin', async () => {
    persona = {
      ...PERSONA,
      name: "Corin's vEIR",
      kind: 'eir_persona',
      eirFirstName: 'Corin',
      firstPerson: true,
      eirSeesWork: true,
    };
    renderWithProviders(<VeirWelcomeGate ventureId={VENTURE} />);
    expect(await screen.findByRole('dialog', { name: 'Meet Corin’s vEIR' })).toHaveAccessibleDescription(
      'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches. Corin sees what you work on here.',
    );
  });
});

describe('inlineWelcome (a call opened before the welcome was read)', () => {
  const guide = {
    kind: 'neutral_guide',
    name: 'Foundry Guide',
    eirFirstName: null,
    eirSeesWork: false,
  } as const;

  it('says the neutral guide’s welcome too, and nothing once read, without the coach or for staff', () => {
    expect(inlineWelcome(false, true, guide)).toEqual({
      title: 'Meet Foundry Guide',
      lines: ['The program’s AI coach, built on its coaching doctrine.', 'It isn’t a person.'],
    });
    expect(inlineWelcome(true, true, guide)).toBeNull();
    expect(inlineWelcome(false, false, guide)).toBeNull();
    expect(inlineWelcome(false, true, null)).toBeNull();
  });
});
