import { type assignmentsRepo, type venturesRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import { hasAnyRole } from './roles.js';
import { checkAssignment, decideVentureAccess, type VentureAction } from './venture-access.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const VENTURE = '55555555-5555-4555-8555-555555555555';

function access(
  membershipRole: venturesRepo.VentureAccess['membershipRole'],
  isAssignedEir = false,
  ventureStatus: venturesRepo.VentureAccess['ventureStatus'] = 'active',
  tenantId = TENANT,
): venturesRepo.VentureAccess {
  return { ventureId: VENTURE, tenantId, ventureStatus, membershipRole, isAssignedEir };
}

const ACTIONS: readonly VentureAction[] = ['read', 'write', 'review'];

describe('decideVentureAccess', () => {
  const cases: [string, venturesRepo.VentureAccess | null, Record<VentureAction, string>][] = [
    ['founder', access('founder'), { read: 'allow', write: 'allow', review: 'forbidden' }],
    ['team', access('team'), { read: 'allow', write: 'allow', review: 'forbidden' }],
    ['advisor', access('advisor'), { read: 'allow', write: 'forbidden', review: 'forbidden' }],
    ['assigned EIR', access(null, true), { read: 'allow', write: 'forbidden', review: 'allow' }],
    ['founder + assigned EIR', access('founder', true), { read: 'allow', write: 'allow', review: 'allow' }],
    ['no relationship', access(null), { read: 'not_found', write: 'not_found', review: 'not_found' }],
    ['not visible', null, { read: 'not_found', write: 'not_found', review: 'not_found' }],
    [
      'other tenant',
      access('founder', false, 'active', OTHER),
      { read: 'not_found', write: 'not_found', review: 'not_found' },
    ],
    [
      'archived venture founder',
      access('founder', false, 'archived'),
      { read: 'allow', write: 'forbidden', review: 'forbidden' },
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      for (const action of ACTIONS) {
        const decision = decideVentureAccess(input, { tenantId: TENANT }, action);
        const outcome = decision.allowed ? 'allow' : decision.code;
        expect(outcome, `${name} / ${action}`).toBe(expected[action]);
      }
    });
  }

  it('reports the relation and write capability', () => {
    const d = decideVentureAccess(access('team'), { tenantId: TENANT }, 'read');
    expect(d).toMatchObject({ allowed: true, relation: 'team', canWrite: true });
    const eir = decideVentureAccess(access(null, true), { tenantId: TENANT }, 'read');
    expect(eir).toMatchObject({ allowed: true, relation: 'assigned_eir', canWrite: false });
    const archived = decideVentureAccess(access('team', false, 'archived'), { tenantId: TENANT }, 'write');
    expect(archived).toMatchObject({ allowed: false, reason: 'venture_archived' });
  });
});

describe('checkAssignment', () => {
  const base = (overrides: {
    persona?: Partial<assignmentsRepo.ResolvedAssignment['persona']>;
    release?: null;
    assignmentModes?: assignmentsRepo.AssignmentRecord['allowedModes'];
  }): assignmentsRepo.ResolvedAssignment =>
    ({
      assignment: { id: 'a', allowedModes: overrides.assignmentModes ?? ['diagnose', 'coach', 'rehearse'] },
      persona: {
        id: 'p',
        name: 'Foundry Guide',
        kind: 'neutral_guide',
        status: 'active',
        suspendedReason: null,
        ...overrides.persona,
      },
      release: overrides.release === null ? null : { id: 'r', allowedModes: ['diagnose', 'coach', 'teach'] },
      eir: null,
    }) as unknown as assignmentsRepo.ResolvedAssignment;

  it('requires an assignment, an active persona and an approved release', () => {
    expect(checkAssignment(null)).toMatchObject({ code: 'assignment_inactive' });
    expect(checkAssignment(base({ persona: { status: 'suspended' } }))).toMatchObject({
      code: 'persona_suspended',
    });
    expect(checkAssignment(base({ persona: { status: 'retired' } }))).toMatchObject({
      code: 'assignment_inactive',
    });
    expect(checkAssignment(base({ release: null }))).toMatchObject({ code: 'assignment_inactive' });
    expect(checkAssignment(base({}))).not.toBeInstanceOf(DomainError);
  });

  it('allows only modes enabled by both the assignment and the release', () => {
    const active = checkAssignment(base({}));
    if (active instanceof DomainError) throw active;
    expect(active.allowedModes).toEqual(['diagnose', 'coach']);
  });
});

describe('roles', () => {
  it('hasAnyRole', () => {
    expect(hasAnyRole(['eir'], ['program_lead', 'eir'])).toBe(true);
    expect(hasAnyRole([], ['platform_admin'])).toBe(false);
  });
});
