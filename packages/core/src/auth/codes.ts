import { authRepo, type SystemExecutor } from '@foundry/db';

import { DomainError } from '../errors.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from './access-code.js';

export interface IssuedCode {
  readonly record: authRepo.AccessCodeRecord;
  /** Plaintext code — returned to the issuer exactly once, never stored or logged. */
  readonly code: string;
}

const MAX_PREFIX_ATTEMPTS = 6;

/**
 * Generates a code, hashes it (scrypt) and stores only the hash. Retries on the (rare) public-prefix
 * collision. System executor: `access_codes` grants nothing to app_rls. The caller must have authorized
 * the issuer for `principalId` first.
 */
export async function issueCodeForPrincipal(
  sx: SystemExecutor,
  args: {
    readonly principalId: string;
    readonly label: string;
    readonly createdBy: string | null;
    readonly expiresAt: Date | null;
  },
): Promise<IssuedCode> {
  for (let attempt = 0; attempt < MAX_PREFIX_ATTEMPTS; attempt += 1) {
    const code = generateAccessCode();
    const prefix = accessCodePrefix(code);
    if (await authRepo.accessCodePrefixExists(sx, prefix)) continue;
    const hash = await hashAccessCode(code);
    const record = await authRepo.createAccessCode(sx, {
      principalId: args.principalId,
      prefix,
      hash,
      label: args.label,
      createdBy: args.createdBy,
      expiresAt: args.expiresAt,
    });
    return { record, code };
  }
  throw new DomainError('conflict', 'Could not allocate a unique access code; please retry', {
    reason: 'prefix_exhausted',
  });
}
