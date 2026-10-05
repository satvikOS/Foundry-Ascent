import { type AccessCodeIssued, InviteMemberRequest, type TeamMemberView } from '@foundry/contracts';
import { auditRepo, principalsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import { issueCodeForPrincipal } from '../auth/codes.js';
import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { decideVentureAccess, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit } from '../internal/kit.js';

type TeamMemberViewValue = z.infer<typeof TeamMemberView>;
type AccessCodeIssuedValue = z.infer<typeof AccessCodeIssued>;

export interface TeamService {
  /** Active members (read access, or a program lead of the tenant). */
  list(ctx: RequestContext, ventureId: string): Promise<TeamMemberViewValue[]>;
  /**
   * Program lead: creates a principal, an active membership (expiring after `expiresInDays`) and a
   * one-time access code. The plaintext code is in the result exactly once.
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
      const now = kit.now();
      const expiresAt =
        input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000);
      const principal = await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'venture', objectId: ventureId, ventureId });
        const venture = await venturesRepo.getVenture(scope.tx, ventureId);
        if (venture?.tenantId !== ctx.tenantId) throw fail.notFound('Venture');
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
          metadata: { role: input.role, expiresInDays: input.expiresInDays },
        });
        return created;
      });
      // access_codes grants nothing to app_rls: the code is issued with the owner role after the
      // program-lead check above, for the principal that transaction just created.
      const issued = await kit.system(async (sx) => {
        const result = await issueCodeForPrincipal(sx, {
          principalId: principal.id,
          label: `invitation (${input.role})`,
          createdBy: ctx.principalId,
          expiresAt,
        });
        await auditRepo.appendAudit(sx, {
          action: 'access_code.issued',
          outcome: 'succeeded',
          tenantId: ctx.tenantId,
          actorId: ctx.principalId,
          requestId: ctx.requestId,
          ventureId,
          objectType: 'access_code',
          objectId: result.record.id,
          metadata: { principalId: principal.id, via: 'invitation' },
        });
        return result;
      });
      onPrincipalChanged(principal.id);
      return {
        accessCodeId: issued.record.id,
        principal: principalsRepo.toPrincipalView(principal),
        accessCode: issued.code,
        expiresAt: issued.record.expiresAt,
      };
    },
  };
}
