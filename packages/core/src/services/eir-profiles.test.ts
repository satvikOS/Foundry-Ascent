import { DbError, SqlState } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { DomainError, toDomainError } from '../errors.js';
import { profileConflict } from './eir-profiles.js';

describe('profileConflict', () => {
  const field = { path: 'principalId', message: 'Noor Haddad already has an EIR profile.' };

  it('reports a second profile that got past the check as the check would, on pg and on the Data API', () => {
    for (const constraint of ['eir_profiles_principal_uq', null]) {
      // As the request transaction rethrows it (toDomainError keeps the database error as its cause).
      const err = toDomainError(new DbError('duplicate', { sqlState: SqlState.uniqueViolation, constraint }));
      const mapped = profileConflict(err, 'Noor Haddad');
      expect(mapped).toBeInstanceOf(DomainError);
      expect(mapped).toMatchObject({ code: 'conflict', reason: 'eir_profile_exists', errors: [field] });
    }
  });

  it('leaves every other error as it is', () => {
    const other = toDomainError(
      new DbError('duplicate', { sqlState: SqlState.uniqueViolation, constraint: 'audit_events_pkey' }),
    );
    expect(profileConflict(other, 'Noor Haddad')).toBe(other);
    const check = toDomainError(new DbError('check', { sqlState: SqlState.checkViolation }));
    expect(profileConflict(check, 'Noor Haddad')).toBe(check);
    const plain = new Error('boom');
    expect(profileConflict(plain, 'Noor Haddad')).toBe(plain);
  });
});
