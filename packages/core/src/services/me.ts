import { DEFAULT_DISCLOSURE, type Me } from '@foundry/contracts';
import { principalsRepo, settingsRepo, tenantsRepo } from '@foundry/db';

import { loadPrincipalRoles } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { type Kit } from '../internal/kit.js';

export interface MeService {
  /** The caller's identity, roles, memberships, assigned ventures, disclosure and AI kill-switch state. */
  get(ctx: RequestContext): Promise<Me>;
}

export function createMeService(kit: Kit): MeService {
  return {
    get: (ctx) =>
      kit.inRequest(ctx, async ({ tx }) => {
        const principal = await principalsRepo.getPrincipal(tx, ctx.principalId);
        const tenant = await tenantsRepo.getTenant(tx, ctx.tenantId);
        if (principal?.status !== 'active' || tenant === null) {
          throw new DomainError('unauthenticated', 'Please sign in again.', {
            reason: 'principal_unavailable',
          });
        }
        const roles = await loadPrincipalRoles(tx, ctx);
        const memberships = await principalsRepo.listMembershipsForPrincipals(tx, [ctx.principalId]);
        const assignedVentureIds = await principalsRepo.listAssignedVentureIds(tx, ctx.principalId);
        const settings = await settingsRepo.getPlatformSettings(tx);
        return {
          principal: principalsRepo.toPrincipalView(principal),
          tenant: tenantsRepo.toTenantView(tenant),
          roles,
          memberships: memberships.map((m) => ({
            ventureId: m.ventureId,
            ventureName: m.ventureName,
            role: m.role,
          })),
          assignedVentureIds,
          disclosure: DEFAULT_DISCLOSURE,
          aiEnabled: settings.aiEnabled,
        };
      }),
  };
}
