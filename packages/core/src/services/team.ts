import { type AccessCodeIssued, InviteMemberRequest, type TeamResponse } from '@foundry/contracts';
import { principalsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { decideVentureAccess, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { expiryAfterDays, issueAndAuditAccessCode } from '../internal/access-codes.js';
import { audit, requireId, type Kit } from '../internal/kit.js';

type TeamResponseValue = z.infer<typeof TeamResponse>;
type AccessCodeIssuedValue = z.infer<typeof AccessCodeIssued>;

export interface TeamService {
  /**
   * Active members and the venture's name (read access, or a program lead or platform admin of the tenant, who
   * see the name without reading the venture itself).
   */
  list(ctx: RequestContext, ventureId: string): Promise<TeamResponseValue>;
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
      const items = await kit.inRequest(ctx, async (scope) => {
        const access = await venturesRepo.getVentureAccess(scope.tx, {
          ventureId,
          principalId: ctx.principalId,
        });
        const decision = decideVentureAccess(access, ctx, 'read');
        if (!decision.allowed) {
          // Those who may invite to the team see it too, without reading the venture itself.
          const roles = await loadPrincipalRoles(scope.tx, ctx);
          const staff =
            hasAnyRole(roles, ['program_lead', 'platform_admin']) &&
            (await venturesRepo.ventureInCurrentTenant(scope.tx, ventureId));
          if (!staff) await requireVentureAccess(scope, ventureId, 'read', { objectType: 'team' });
        }
        return venturesRepo.listTeam(scope.tx, ventureId);
      });
      // Allowed above (a reader of the venture, or staff of its tenant): its name only, read as the owner because
      // a platform admin cannot read the venture row under RLS.
      const venture = await kit.system((sx) => venturesRepo.getVenture(sx, ventureId), {
        transaction: false,
      });
      return { venture: venture ? { id: venture.id, name: venture.name } : null, items };
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
