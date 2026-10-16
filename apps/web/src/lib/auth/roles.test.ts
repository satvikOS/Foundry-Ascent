import type { Me } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { writesAnyVenture } from './roles';

const base: Me = {
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
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
};
const venture = '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01';

describe('writesAnyVenture', () => {
  it('is true for founders and team members, who hold conversations', () => {
    expect(
      writesAnyVenture({ ...base, memberships: [{ ventureId: venture, ventureName: 'Q', role: 'founder' }] }),
    ).toBe(true);
    expect(
      writesAnyVenture({ ...base, memberships: [{ ventureId: venture, ventureName: 'Q', role: 'team' }] }),
    ).toBe(true);
  });

  it('is false for read-only roles, so no conversation list is ever requested for them', () => {
    expect(
      writesAnyVenture({ ...base, memberships: [{ ventureId: venture, ventureName: 'Q', role: 'advisor' }] }),
    ).toBe(false);
    expect(writesAnyVenture({ ...base, roles: ['eir'], assignedVentureIds: [venture] })).toBe(false);
    expect(writesAnyVenture(null)).toBe(false);
  });
});
