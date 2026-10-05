import { type PlatformRole } from '@foundry/contracts';
import { principalsRepo, type SqlExecutor } from '@foundry/db';

import { type RequestContext } from '../context.js';
import { fail } from '../errors.js';
import { type RequestScope } from '../internal/kit.js';

/** Active platform/tenant roles of the caller, re-derived from `role_grants` (never from the cookie). */
export function loadPrincipalRoles(
  ex: SqlExecutor,
  ctx: Pick<RequestContext, 'principalId' | 'tenantId'>,
): Promise<PlatformRole[]> {
  return principalsRepo.listActiveRoles(ex, { principalId: ctx.principalId, tenantId: ctx.tenantId });
}

export interface RoleDecision {
  readonly allowed: true;
  /** All active roles of the caller. */
  readonly roles: readonly PlatformRole[];
  /** The required roles the caller holds. */
  readonly matched: readonly PlatformRole[];
}

export interface RequireRoleOptions {
  /** Audit object type / id of the resource being accessed (identifiers only). */
  readonly objectType?: string;
  readonly objectId?: string | null;
  readonly ventureId?: string | null;
}

/**
 * Requires at least one of `anyOf`. Denials are audited (`authz.denied`) and reported as `forbidden`.
 * Roles are re-read inside the request transaction, so a revoked grant takes effect immediately.
 */
export async function requireRole(
  scope: RequestScope,
  anyOf: readonly PlatformRole[],
  options: RequireRoleOptions = {},
): Promise<RoleDecision> {
  const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
  const matched = anyOf.filter((r) => roles.includes(r));
  if (matched.length === 0) {
    const reason = `requires_role:${anyOf.join('|')}`;
    scope.deferAudit({
      action: 'authz.denied',
      outcome: 'denied',
      policyReason: reason,
      objectType: options.objectType ?? null,
      objectId: options.objectId ?? null,
      ventureId: options.ventureId ?? null,
    });
    throw fail.forbidden(reason);
  }
  return { allowed: true, roles, matched };
}

/** Pure check on a role list. */
export function hasAnyRole(roles: readonly PlatformRole[], anyOf: readonly PlatformRole[]): boolean {
  return anyOf.some((r) => roles.includes(r));
}
