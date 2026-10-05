import { ventureNameProblem, type VentureNameProblem } from '@foundry/ai';
import { DbError, SqlState } from '@foundry/db';

import { DomainError, fail, isDomainError } from '../errors.js';

/** Constraint name raised by the `ventures_name_unique` trigger (migration 0003). */
export const VENTURE_NAME_UNIQUE_CONSTRAINT = 'ventures_tenant_name_unique';

const MESSAGES: Readonly<Record<VentureNameProblem, string>> = {
  too_short: 'Venture names need at least three characters, and at least four letters for a single word.',
  common_word: 'Choose a more distinctive name: a single common word cannot be a venture name.',
  only_common_words:
    'Choose a more distinctive name: include at least one word that is not a common English word.',
};

/**
 * Venture names feed the cross-venture guard of every other venture of the tenant, so a name that is a
 * common word (or only common words) would block their coaching turns. Throws `validation_failed` on
 * `name` for such names (the contract already enforces 3–80 trimmed characters).
 */
export function assertDistinctiveVentureName(name: string): void {
  const problem = ventureNameProblem(name);
  if (problem === null) return;
  throw fail.validation(MESSAGES[problem], [{ path: 'name', message: MESSAGES[problem] }]);
}

/** Maps the tenant-wide name uniqueness violation to a `conflict` on `name`; other errors pass through. */
export function ventureNameConflict(err: unknown): unknown {
  const cause = isDomainError(err) ? err.cause : err;
  if (
    cause instanceof DbError &&
    cause.sqlState === SqlState.uniqueViolation &&
    cause.constraint === VENTURE_NAME_UNIQUE_CONSTRAINT
  ) {
    return new DomainError('conflict', 'Another venture in this program already uses this name.', {
      reason: 'venture_name_taken',
      errors: [{ path: 'name', message: 'Another venture in this program already uses this name.' }],
      cause,
    });
  }
  return err;
}
