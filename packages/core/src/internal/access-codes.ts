import { type AccessCodeIssued } from '@foundry/contracts';
import { auditRepo, principalsRepo } from '@foundry/db';
import { type z } from 'zod';

import { issueCodeForPrincipal } from '../auth/codes.js';
import { type RequestContext } from '../context.js';
import { type Kit } from './kit.js';

type AccessCodeIssuedValue = z.infer<typeof AccessCodeIssued>;

/** When a code or membership issued at `now` for `expiresInDays` expires (null: never). */
export function expiryAfterDays(now: Date, expiresInDays: number | null): Date | null {
  return expiresInDays === null ? null : new Date(now.getTime() + expiresInDays * 86_400_000);
}

/**
 * Issues a one-time access code for a principal the caller is already authorized to issue for, audits it
 * (`access_code.issued`, or `access_code.reissued` when the principal had a code before; ids and counts
 * only) and returns the plaintext exactly once. Runs with the owner role: `access_codes` grants nothing to
 * app_rls.
 */
export async function issueAndAuditAccessCode(
  kit: Kit,
  ctx: RequestContext,
  args: {
    readonly principal: Pick<principalsRepo.PrincipalRecord, 'id' | 'displayName' | 'title' | 'synthetic'>;
    readonly label: string;
    readonly expiresAt: Date | null;
    readonly reissue?: boolean;
    readonly ventureId?: string | null;
    readonly metadata?: Readonly<Record<string, auditRepo.AuditMetadataValue>>;
  },
): Promise<AccessCodeIssuedValue> {
  const issued = await kit.system(async (sx) => {
    const result = await issueCodeForPrincipal(sx, {
      principalId: args.principal.id,
      label: args.label,
      createdBy: ctx.principalId,
      expiresAt: args.expiresAt,
    });
    await auditRepo.appendAudit(sx, {
      action: args.reissue === true ? 'access_code.reissued' : 'access_code.issued',
      outcome: 'succeeded',
      tenantId: ctx.tenantId,
      actorId: ctx.principalId,
      requestId: ctx.requestId,
      ventureId: args.ventureId ?? null,
      objectType: 'access_code',
      objectId: result.record.id,
      metadata: { principalId: args.principal.id, ...args.metadata },
    });
    return result;
  });
  return {
    accessCodeId: issued.record.id,
    principal: principalsRepo.toPrincipalView(args.principal),
    accessCode: issued.code,
    expiresAt: issued.record.expiresAt,
  };
}
