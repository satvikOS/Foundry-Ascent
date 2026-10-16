import { type AccessCodeIssued, InviteMemberRequest, type TeamMemberView } from '@foundry/contracts';
import { principalsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { decideVentureAccess, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { expiryAfterDays, issueAndAuditAccessCode } from '../internal/access-codes.js';
import { audit, requireId, type Kit } from '../internal/kit.js';

type TeamMemberViewValue = z.infer<typeof TeamMemberView>;
type AccessCodeIssuedValue = z.infer<typeof AccessCodeIssued>;

export interface TeamService {
  /** Active members (read access, or a program lead of the tenant). */
  list(ctx: RequestContext, ventureId: string): Promise<TeamMemberViewValue[]>;
  /**
   * Program lead or platform admin of the tenant: creates a principal, an active membership (expiring after
   * `expiresInDays`) and a one-time access code. The plaintext code is in the result exactly once.
   */
  invite(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof InviteMemberRequest>,
  ): Promise<AccessCodeIssuedValue>;
}

export function createTeamService(kit: Kit, onPrincipalChanged: (principalId: string) => void): TeamService {
  return {
    list: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        const access = await venturesRepo.getVentureAccess(scope.tx, {
          ventureId,
          principalId: ctx.principalId,
        });
        const decision = decideVentureAccess(access, ctx, 'read');
        if (!decision.allowed) {
          const roles = await loadPrincipalRoles(scope.tx, ctx);
          const programLead = hasAnyRole(roles, ['program_lead']) && access?.tenantId === ctx.tenantId;
          if (!programLead) await requireVentureAccess(scope, ventureId, 'read', { objectType: 'team' });
        }
        return venturesRepo.listTeam(scope.tx, ventureId);
      });
    },

    invite: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(InviteMemberRequest, rawInput);
      const expiresAt = expiryAfterDays(kit.now(), input.expiresInDays);
      const principal = await kit.inRequest(ctx, async (scope) => {
        const decision = await requireRole(scope, ['program_lead', 'platform_admin'], {
          objectType: 'venture',
          objectId: ventureId,
          ventureId,
        });
        // A platform admin need not be able to read the venture, only to find it in the tenant.
        if (!(await venturesRepo.ventureInCurrentTenant(scope.tx, ventureId))) throw fail.notFound('Venture');
        const created = await principalsRepo.createPrincipal(scope.tx, {
          tenantId: ctx.tenantId,
          displayName: input.displayName,
          email: input.email,
          title: input.title,
          synthetic: false,
        });
        await venturesRepo.addMembership(scope.tx, {
          ventureId,
          principalId: created.id,
          role: input.role,
          grantedBy: ctx.principalId,
          expiresAt,
        });
        await audit(scope, {
          action: 'team.invited',
          outcome: 'succeeded',
          ventureId,
          objectType: 'principal',
          objectId: created.id,
          metadata: {
            role: input.role,
            expiresInDays: input.expiresInDays,
            inviterRoles: [...decision.matched],
          },
        });
        return created;
      });
      // Issued after the role check above, for the principal that transaction just created.
      const issued = await issueAndAuditAccessCode(kit, ctx, {
        principal,
        label: `invitation (${input.role})`,
        expiresAt,
        ventureId,
        metadata: { via: 'invitation' },
      });
      onPrincipalChanged(principal.id);
      return issued;
    },
  };
}
