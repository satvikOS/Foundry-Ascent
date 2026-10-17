import type { Me } from '@foundry/contracts';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { DataUseDialog } from './account-dialogs';

const me: Me = {
  principal: {
    id: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
    displayName: 'Ari Example',
    title: null,
    synthetic: true,
  },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [],
  assignedVentureIds: [],
  disclosure: "You are talking with Corin's vEIR, an AI coach. It is not a person.",
  aiEnabled: true,
  notices: [],
};

describe('DataUseDialog', () => {
  it('names every reader of a venture and states only what ships', () => {
    renderWithProviders(<DataUseDialog me={me} open onOpenChange={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Data use & privacy' });
    const readers = within(dialog).getByRole('heading', { name: 'Who can see your venture' }).parentElement;
    if (!readers) throw new Error('section missing');
    expect(readers).toHaveTextContent('team sees conversations, memory and documents');
    expect(readers).toHaveTextContent('Advisors see only the memory and documents shared with them');
    expect(readers).toHaveTextContent('a sample of answers');
    expect(readers).toHaveTextContent('Program staff see totals');
    expect(dialog).toHaveTextContent('erased when they end, or after 24 hours idle');
    expect(dialog).toHaveTextContent("You are talking with Corin's vEIR");
  });
});
