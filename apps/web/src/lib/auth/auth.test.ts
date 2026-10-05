import type { Me } from '@foundry/contracts';
import { ACCESS_CODE_PATTERN } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import {
  accessCodeSymbols,
  caretAfterMask,
  fullAccessCode,
  isCompleteAccessCode,
  maskAccessCodeInput,
} from './access-code';
import { homePath, safeRedirectPath } from './guards';
import { canAccessVenture, canWrite, describeRoles, hasAnyRole, hasRole, isFounder, isMember } from './roles';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const V3 = '33333333-3333-4333-8333-333333333333';

function me(overrides: Partial<Me> = {}): Me {
  return {
    principal: {
      id: '44444444-4444-4444-8444-444444444444',
      displayName: 'Sam Synthetic',
      title: null,
      synthetic: true,
    },
    tenant: { id: '55555555-5555-4555-8555-555555555555', slug: 'ain', name: 'Ain Foundry', kind: 'home' },
    roles: [],
    memberships: [
      { ventureId: V1, ventureName: 'Helio Grid', role: 'founder' },
      { ventureId: V2, ventureName: 'Tidepool', role: 'advisor' },
    ],
    assignedVentureIds: [],
    disclosure: 'AI coach',
    aiEnabled: true,
    ...overrides,
  };
}

describe('access code mask', () => {
  it.each([
    ['FA-ABCDE-FGHJK-MNPQR-STVWX', 'ABCDE-FGHJK-MNPQR-STVWX'],
    ['fa-abcde-fghjk-mnpqr-stvwx', 'ABCDE-FGHJK-MNPQR-STVWX'],
    ['FA ABCDE FGHJK MNPQR STVWX', 'ABCDE-FGHJK-MNPQR-STVWX'],
    ['FAABCDEFGHJKMNPQRSTVWX', 'ABCDE-FGHJK-MNPQR-STVWX'],
    ['ABCDEFGHJKMNPQRSTVWX', 'ABCDE-FGHJK-MNPQR-STVWX'],
    ['FA–ABCDE–FGHJK', 'ABCDE-FGHJK'],
    ['ABCDE-FGHJK-MNPQR-STVWX-EXTRA', 'ABCDE-FGHJK-MNPQR-STVWX'],
    ['oOiIlL', '00111-1'],
    ['u!@#', ''],
    ['', ''],
    ['FA-', ''],
  ])('%j → %j', (raw, masked) => {
    expect(maskAccessCodeInput(raw)).toBe(masked);
  });

  it('keeps a code that genuinely starts with "FA"', () => {
    // 20 symbols starting with FA and no separator: FA is part of the code, not a prefix.
    expect(accessCodeSymbols('FAB12CDE34FGH56JKM78')).toBe('FAB12CDE34FGH56JKM78');
    expect(maskAccessCodeInput('FAB12')).toBe('FAB12');
  });

  it('produces codes that satisfy the shared contract pattern', () => {
    const full = fullAccessCode('abcde fghjk mnpqr stvwx');
    expect(full).toBe('FA-ABCDE-FGHJK-MNPQR-STVWX');
    expect(ACCESS_CODE_PATTERN.test(full)).toBe(true);
    expect(fullAccessCode('')).toBe('');
    expect(isCompleteAccessCode(full)).toBe(true);
    expect(isCompleteAccessCode('ABCDE')).toBe(false);
  });

  it('keeps the caret after the same symbol when editing in the middle', () => {
    // Typing "Z" after "ABC" in "ABCDE-FG": raw "ABCZDE-FG", caret 4 → after Z in "ABCZD-EFG".
    const raw = 'ABCZDE-FG';
    const masked = maskAccessCodeInput(raw);
    expect(masked).toBe('ABCZD-EFG');
    expect(caretAfterMask(raw, 4, masked)).toBe(4);
    // Typing the 6th symbol at the end jumps past the inserted dash.
    expect(caretAfterMask('ABCDEF', 6, maskAccessCodeInput('ABCDEF'))).toBe(7);
    expect(caretAfterMask('', 0, '')).toBe(0);
  });
});

describe('safeRedirectPath', () => {
  it.each([
    ['/ain/app/ventures', '/ain/app/ventures'],
    ['/ain/app?x=1#y', '/ain/app?x=1#y'],
    ['//evil.example/path', undefined],
    ['/\\evil.example', undefined],
    ['https://evil.example', undefined],
    ['javascript:alert(1)', undefined],
    ['/sign-in?redirect=/x', undefined],
    ['/ok\nnext', undefined],
    ['', undefined],
    [42, undefined],
  ])('%j → %j', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it('builds the tenant home path', () => {
    expect(homePath(me())).toBe('/ain/app');
  });
});

describe('role helpers', () => {
  it('reads platform roles', () => {
    const lead = me({ roles: ['program_lead'] });
    expect(hasRole(lead, 'program_lead')).toBe(true);
    expect(hasRole(lead, 'platform_admin')).toBe(false);
    expect(hasAnyRole(lead, ['eir', 'program_lead'])).toBe(true);
    expect(hasRole(null, 'eir')).toBe(false);
  });

  it('distinguishes members, writers and founders', () => {
    const person = me();
    expect(isMember(person, V1)).toBe(true);
    expect(isMember(person, V3)).toBe(false);
    expect(canWrite(person, V1)).toBe(true);
    expect(canWrite(person, V2)).toBe(false); // advisor is read-only
    expect(isFounder(person, V1)).toBe(true);
    expect(isMember(person, V2, ['founder', 'team'])).toBe(false);
  });

  it('lets assigned EIRs open but not edit a venture', () => {
    const eir = me({ roles: ['eir'], memberships: [], assignedVentureIds: [V3] });
    expect(canAccessVenture(eir, V3)).toBe(true);
    expect(canWrite(eir, V3)).toBe(false);
    expect(canAccessVenture(eir, V1)).toBe(false);
  });

  it('describes roles for the account menu', () => {
    expect(describeRoles(me({ roles: ['platform_admin', 'program_lead'] }))).toBe(
      'Platform admin · Program lead',
    );
    expect(describeRoles(me())).toBe('Founder · Advisor');
  });
});
