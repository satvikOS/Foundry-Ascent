import { DEFAULT_DISCLOSURE, type AccountNotice, type Me } from '@foundry/contracts';
import { authRepo, principalsRepo, settingsRepo, tenantsRepo } from '@foundry/db';

import { loadPrincipalRoles } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { type Kit } from '../internal/kit.js';

export interface MeService {
  /**
   * The caller's identity, roles, memberships, assigned ventures, disclosure, AI kill-switch state and
   * account notices. With `sessionId` (a verified session), `notices` lists access codes someone else
   * issued for this account since the caller's previous sign-in.
   */
  get(ctx: RequestContext & { readonly sessionId?: string }): Promise<Me>;
}

export function createMeService(kit: Kit): MeService {
  return {
    get: async (ctx) => {
      const me = await kit.inRequest(ctx, async ({ tx }) => {
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
      });
      // Credential tables are closed to app_rls: read the caller's own code history with the owner role,
      // for the caller's principal and session only.
      const sessionId = ctx.sessionId;
      const issued =
        sessionId === undefined
          ? []
          : await kit.system(
              (sx) =>
                authRepo.reissuedCodesSincePreviousSignIn(sx, {
                  principalId: ctx.principalId,
                  currentSessionId: sessionId,
                }),
              { transaction: false },
            );
      const notices: AccountNotice[] = issued.map((at) => ({ kind: 'access_code_issued', at }));
      return { ...me, notices };
    },
  };
}
