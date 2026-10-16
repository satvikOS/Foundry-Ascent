import type { Me } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import {
  defaultLanding,
  STAFF_SECTIONS,
  staffWorkspaces,
  ventureDestinations,
  workspaceFromPath,
} from './nav';

const VENTURE_A = '11111111-1111-4111-8111-111111111111';
const VENTURE_B = '22222222-2222-4222-8222-222222222222';

function me(overrides: Partial<Me> = {}): Me {
  return {
    principal: {
      id: '33333333-3333-4333-8333-333333333333',
      displayName: 'Maya',
      title: null,
      synthetic: true,
    },
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

describe('workspaceFromPath', () => {
  it('finds the venture, staff workspace or nothing', () => {
    expect(workspaceFromPath(`/ain/app/v/${VENTURE_A}`)).toEqual({ kind: 'venture', ventureId: VENTURE_A });
    expect(workspaceFromPath(`/ain/app/v/${VENTURE_A}/c/x`)).toEqual({
      kind: 'venture',
      ventureId: VENTURE_A,
    });
    expect(workspaceFromPath('/ain/app/eir/personas')).toEqual({ kind: 'eir' });
    expect(workspaceFromPath('/ain/app/program')).toEqual({ kind: 'program' });
    expect(workspaceFromPath('/ain/app/admin/audit')).toEqual({ kind: 'admin' });
    expect(workspaceFromPath('/ain/app')).toEqual({ kind: 'none' });
    expect(workspaceFromPath('/sign-in')).toEqual({ kind: 'none' });
  });
});

describe('staffWorkspaces', () => {
  it('lists only the workspaces a role may open', () => {
    expect(staffWorkspaces(me()).map((w) => w.id)).toEqual([]);
    expect(staffWorkspaces(me({ roles: ['eir'] })).map((w) => w.id)).toEqual(['eir']);
    expect(staffWorkspaces(me({ roles: ['platform_admin', 'program_lead'] })).map((w) => w.id)).toEqual([
      'eir',
      'program',
      'admin',
    ]);
  });
});

describe('STAFF_SECTIONS', () => {
  it('gives lesson review a place in the EIR studio and assignments a place in Program', () => {
    expect(STAFF_SECTIONS.eir.map((s) => s.label)).toEqual([
      'Personas & knowledge',
      'Lessons to review',
      'Calibration reviews',
      'Inbox',
    ]);
    expect(STAFF_SECTIONS.program.map((s) => s.label)).toEqual([
      'Portfolio',
      'Ventures',
      'vEIRs & assignments',
      'Resources',
      'Escalations',
    ]);
  });
});

describe('defaultLanding', () => {
  const founder = me({
    memberships: [
      { ventureId: VENTURE_A, ventureName: 'QuietQuad', role: 'advisor' },
      { ventureId: VENTURE_B, ventureName: 'BenchTally', role: 'founder' },
    ],
  });

  it('opens the last venture when the person still belongs to it', () => {
    expect(defaultLanding(founder, VENTURE_A)).toEqual({ kind: 'venture', ventureId: VENTURE_A });
  });

  it('otherwise opens the first venture they can work in', () => {
    expect(defaultLanding(founder, null)).toEqual({ kind: 'venture', ventureId: VENTURE_B });
    expect(defaultLanding(founder, '55555555-5555-4555-8555-555555555555')).toEqual({
      kind: 'venture',
      ventureId: VENTURE_B,
    });
  });

  it('sends staff without ventures to their main workspace', () => {
    expect(defaultLanding(me({ roles: ['platform_admin', 'program_lead'] }), null)).toEqual({
      kind: 'program',
    });
    expect(defaultLanding(me({ roles: ['eir'], assignedVentureIds: [VENTURE_A] }), VENTURE_A)).toEqual({
      kind: 'eir',
    });
    expect(defaultLanding(me({ roles: ['platform_admin'] }), null)).toEqual({ kind: 'admin' });
  });

  it('has nowhere to go for someone with no venture and no staff role', () => {
    expect(defaultLanding(me(), null)).toBeNull();
  });
});

describe('ventureDestinations', () => {
  const ids = (person: Me) => ventureDestinations(person, VENTURE_A).map((d) => d.id);

  it('gives members and the assigned EIR every page of the venture', () => {
    const all = ['knowledge', 'documents', 'help', 'team'];
    for (const role of ['founder', 'team', 'advisor'] as const) {
      expect(ids(me({ memberships: [{ ventureId: VENTURE_A, ventureName: 'QuietQuad', role }] }))).toEqual(
        all,
      );
    }
    expect(ids(me({ roles: ['eir'], assignedVentureIds: [VENTURE_A] }))).toEqual(all);
    // Staff who are also members keep every page.
    expect(
      ids(
        me({
          roles: ['platform_admin'],
          memberships: [{ ventureId: VENTURE_A, ventureName: 'QuietQuad', role: 'founder' }],
        }),
      ),
    ).toEqual(all);
  });

  it('gives program leads and platform admins who are not members only the Team page (no dead links)', () => {
    expect(ids(me({ roles: ['platform_admin'] }))).toEqual(['team']);
    expect(ids(me({ roles: ['program_lead'] }))).toEqual(['team']);
    expect(ids(me({ roles: ['platform_admin', 'program_lead'] }))).toEqual(['team']);
    // A member of another venture is not a member of this one.
    expect(
      ids(
        me({
          roles: ['program_lead'],
          memberships: [{ ventureId: VENTURE_B, ventureName: 'BenchTally', role: 'founder' }],
        }),
      ),
    ).toEqual(['team']);
  });

  it('gives nothing to someone who cannot open the venture at all', () => {
    expect(ids(me())).toEqual([]);
    expect(ids(me({ roles: ['eir'], assignedVentureIds: [VENTURE_B] }))).toEqual([]);
  });
});
