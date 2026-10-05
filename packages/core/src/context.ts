import { type PlatformRole } from '@foundry/contracts';
import { isUuid, type DbContext } from '@foundry/db';

/**
 * Identity of the caller, resolved server-side for every request (system design §4.3). It is produced by
 * `auth.verifySession` from the signed session cookie and never from browser-supplied identifiers.
 *
 * `roles` are the principal's active platform/tenant roles at verification time. They are a hint for
 * UI and cheap pre-checks only: every authorization decision re-derives roles, memberships and
 * assignments from the database (`requireRole`, `requireVentureAccess`), and RLS applies underneath.
 */
export interface RequestContext {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly PlatformRole[];
  /** Correlates logs, audit events and usage ledger rows (≤ 128 chars). */
  readonly requestId: string;
}

/** Builds a RequestContext after validating identifier shapes. */
export function createRequestContext(input: {
  principalId: string;
  tenantId: string;
  roles?: readonly PlatformRole[];
  requestId: string;
}): RequestContext {
  if (!isUuid(input.principalId) || !isUuid(input.tenantId)) {
    throw new TypeError('RequestContext requires UUID principalId and tenantId');
  }
  return {
    principalId: input.principalId.toLowerCase(),
    tenantId: input.tenantId.toLowerCase(),
    roles: [...new Set(input.roles ?? [])],
    requestId: input.requestId.slice(0, 128),
  };
}

/** The database transaction context for a request (RLS identity). */
export function toDbContext(ctx: RequestContext): DbContext {
  return { principalId: ctx.principalId, tenantId: ctx.tenantId, requestId: ctx.requestId };
}
