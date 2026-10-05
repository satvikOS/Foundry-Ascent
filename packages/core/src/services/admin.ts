import {
  type AccessCodeIssued,
  type AdminPrincipalRow,
  AuditQuery,
  CreatePrincipalRequest,
  IssueAccessCodeRequest,
  UpdateSettingsRequest,
  type UsageSummary,
  type PlatformSettingsView,
} from '@foundry/contracts';
import {
  SqlUsageError,
  auditRepo,
  authRepo,
  principalsRepo,
  settingsRepo,
  usageRepo,
  type SqlExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { issueCodeForPrincipal } from '../auth/codes.js';
import { hasAnyRole, requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit } from '../internal/kit.js';

type AdminPrincipalRowValue = z.infer<typeof AdminPrincipalRow>;
type AccessCodeIssuedValue = z.infer<typeof AccessCodeIssued>;
type UsageSummaryValue = z.infer<typeof UsageSummary>;

export interface AuditPage {
  readonly items: auditRepo.AuditPage['items'];
  readonly nextCursor: string | null;
}

export interface AdminService {
  /** Principals of the tenant with roles, memberships and active access codes (platform admin). */
  listPrincipals(ctx: RequestContext): Promise<AdminPrincipalRowValue[]>;
  /** Creates a principal with platform/tenant roles (platform admin). */
  createPrincipal(
    ctx: RequestContext,
    input: z.input<typeof CreatePrincipalRequest>,
  ): Promise<AdminPrincipalRowValue>;
  /**
   * Issues a one-time access code. Platform admins: any active principal of the tenant. Program leads:
   * principals without platform_admin / program_lead roles, and no re-issue for an existing founder or EIR
   * account (platform admin only). A re-issue is audited as `access_code.reissued` and shown to the
   * principal at their next sign-in (`Me.notices`).
   */
  issueAccessCode(
    ctx: RequestContext,
    principalId: string,
    input: z.input<typeof IssueAccessCodeRequest>,
  ): Promise<AccessCodeIssuedValue>;
  /** Revokes a code and every session signed in with it (same issuer rules as issueAccessCode). */
  revokeAccessCode(
    ctx: RequestContext,
    accessCodeId: string,
  ): Promise<{ accessCodeId: string; revokedAt: string }>;
  getSettings(ctx: RequestContext): Promise<PlatformSettingsView>;
  /** Kill switch, daily spend caps, thresholds (platform admin). */
  updateSettings(
    ctx: RequestContext,
    patch: z.input<typeof UpdateSettingsRequest>,
  ): Promise<PlatformSettingsView>;
  /** Platform-wide audit metadata, newest first, keyset cursor (platform admin). */
  listAudit(ctx: RequestContext, query?: z.input<typeof AuditQuery>): Promise<AuditPage>;
  /** Spend today / 30 days, by day and by model, with the global cap (platform admin). */
  usageSummary(ctx: RequestContext): Promise<UsageSummaryValue>;
}

async function buildRows(
  kit: Kit,
  principals: readonly principalsRepo.PrincipalRecord[],
  roles: readonly principalsRepo.RoleGrantRow[],
): Promise<AdminPrincipalRowValue[]> {
  const ids = principals.map((p) => p.id);
  if (ids.length === 0) return [];
  // Memberships and credential metadata: owner role, scoped to principals already listed under RLS.
  const { memberships, codes } = await kit.system(
    async (sx) => ({
      memberships: await principalsRepo.listMembershipsForPrincipals(sx, ids),
      codes: await authRepo.listActiveAccessCodes(sx, ids),
    }),
    { transaction: false },
  );
  return principals.map((p) => ({
    principal: principalsRepo.toPrincipalView(p),
    email: p.email,
    status: p.status,
    roles: roles.filter((r) => r.principalId === p.id).map((r) => r.role),
    memberships: memberships
      .filter((m) => m.principalId === p.id)
      .map((m) => ({ ventureId: m.ventureId, ventureName: m.ventureName, role: m.role })),
    activeAccessCodes: codes
      .filter((c) => c.principalId === p.id)
      .map((c) => ({
        id: c.id,
        prefix: c.codePrefix,
        label: c.label,
        createdAt: c.createdAt,
        expiresAt: c.expiresAt,
        lastUsedAt: c.lastUsedAt,
      })),
  }));
}

export function createAdminService(
  kit: Kit,
  onPrincipalChanged: (principalId: string) => void,
): AdminService {
  /**
   * Issuer rules for codes of `targetId` (read with the owner role after the caller's own role check:
   * program leads cannot see tenant-less platform_admin grants under RLS). Runs in autocommit mode so the
   * denial audit is never rolled back.
   *  - Platform admins: any principal of their tenant.
   *  - Program leads: never principals holding platform_admin / program_lead; and a *re-issue* (the
   *    principal already holds or held a code) for a principal who is a venture founder or an EIR is
   *    platform-admin only, because a new code for an existing account is an account takeover path.
   *    New principals and invitations (no code yet) stay with program leads; revocation stays allowed.
   * Returns the target and whether issuing now would be a re-issue.
   */
  async function authorizeIssuer(
    ctx: RequestContext,
    callerRoles: readonly string[],
    targetId: string,
    operation: 'issue' | 'revoke',
  ): Promise<{ target: principalsRepo.PrincipalRecord; reissue: boolean }> {
    const decision = await kit.system(
      async (sx) => {
        const target = await principalsRepo.getPrincipal(sx, targetId);
        if (target?.tenantId !== ctx.tenantId) return { target: null, denied: null, reissue: false };
        const reissue = await authRepo.principalHasAccessCode(sx, targetId);
        if (callerRoles.includes('platform_admin') || targetId === ctx.principalId)
          return { target, denied: null, reissue };
        const targetRoles = await principalsRepo.listActiveRoles(sx, {
          principalId: targetId,
          tenantId: ctx.tenantId,
        });
        let denied: string | null = null;
        if (hasAnyRole(targetRoles, ['platform_admin', 'program_lead'])) {
          denied = 'program_lead_cannot_manage_privileged_codes';
        } else if (operation === 'issue' && reissue) {
          // A new code for someone who already has one is an account takeover path: for venture members
          // (founders, team, advisors) and EIRs only a platform admin may do it. First codes (new
          // principals, invitations) stay with program leads.
          const member = (await principalsRepo.listMembershipsForPrincipals(sx, [targetId])).length > 0;
          if (member || targetRoles.includes('eir')) denied = 'reissue_requires_platform_admin';
        }
        if (denied === null) return { target, denied, reissue };
        await auditRepo.appendAudit(sx, {
          action: 'authz.denied',
          outcome: 'denied',
          tenantId: ctx.tenantId,
          actorId: ctx.principalId,
          requestId: ctx.requestId,
          objectType: 'principal',
          objectId: targetId,
          policyReason: denied,
        });
        return { target, denied, reissue };
      },
      { transaction: false },
    );
    if (decision.target === null) throw fail.notFound('Principal');
    if (decision.denied !== null) {
      throw fail.forbidden(
        decision.denied,
        decision.denied === 'reissue_requires_platform_admin'
          ? 'Only a platform administrator can issue a new access code for an existing venture member or EIR account.'
          : undefined,
      );
    }
    return { target: decision.target, reissue: decision.reissue };
  }

  async function callerRoles(ctx: RequestContext): Promise<readonly string[]> {
    return kit.inRequest(
      ctx,
      async (scope) => (await requireRole(scope, ['platform_admin', 'program_lead'])).roles,
    );
  }

  async function settingsFor(ex: SqlExecutor): Promise<PlatformSettingsView> {
    return settingsRepo.getPlatformSettings(ex);
  }

  return {
    listPrincipals: async (ctx) => {
      const { principals, roles } = await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['platform_admin'], { objectType: 'principal' });
        const list = await principalsRepo.listPrincipals(scope.tx, { tenantId: ctx.tenantId });
        const grants =
          list.length === 0
            ? []
            : await principalsRepo.listRoleGrants(scope.tx, {
                principalIds: list.map((p) => p.id),
                tenantId: ctx.tenantId,
              });
        return { principals: list, roles: grants };
      });
      return buildRows(kit, principals, roles);
    },

    createPrincipal: async (ctx, rawInput) => {
      const input = parseInput(CreatePrincipalRequest, rawInput);
      const { principal, roles } = await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['platform_admin'], { objectType: 'principal' });
        const created = await principalsRepo.createPrincipal(scope.tx, {
          tenantId: ctx.tenantId,
          displayName: input.displayName,
          email: input.email,
          title: input.title,
        });
        for (const role of new Set(input.roles)) {
          await principalsRepo.grantRole(scope.tx, {
            principalId: created.id,
            tenantId: ctx.tenantId,
            role,
            grantedBy: ctx.principalId,
          });
        }
        await audit(scope, {
          action: 'principal.created',
          outcome: 'succeeded',
          objectType: 'principal',
          objectId: created.id,
          metadata: { roles: [...new Set(input.roles)].sort() },
        });
        const grants = await principalsRepo.listRoleGrants(scope.tx, {
          principalIds: [created.id],
          tenantId: ctx.tenantId,
        });
        return { principal: created, roles: grants };
      });
      const [row] = await buildRows(kit, [principal], roles);
      if (!row) throw fail.notFound('Principal');
      return row;
    },

    issueAccessCode: async (ctx, rawPrincipalId, rawInput) => {
      const principalId = requireId(rawPrincipalId, 'Principal');
      const input = parseInput(IssueAccessCodeRequest, rawInput);
      const roles = await callerRoles(ctx);
      const expiresAt =
        input.expiresInDays === null
          ? null
          : new Date(kit.now().getTime() + input.expiresInDays * 86_400_000);
      const { target: principal, reissue } = await authorizeIssuer(ctx, roles, principalId, 'issue');
      if (principal.status !== 'active')
        throw fail.conflict('The principal is disabled', 'principal_disabled');
      const issued = await kit.system(async (sx) => {
        const result = await issueCodeForPrincipal(sx, {
          principalId,
          label: input.label,
          createdBy: ctx.principalId,
          expiresAt,
        });
        // A re-issue is audited as its own action; the principal sees a notice at the next sign-in.
        await auditRepo.appendAudit(sx, {
          action: reissue ? 'access_code.reissued' : 'access_code.issued',
          outcome: 'succeeded',
          tenantId: ctx.tenantId,
          actorId: ctx.principalId,
          requestId: ctx.requestId,
          objectType: 'access_code',
          objectId: result.record.id,
          metadata: { principalId, expiresInDays: input.expiresInDays, reissue },
        });
        return result;
      });
      return {
        accessCodeId: issued.record.id,
        principal: principalsRepo.toPrincipalView(principal),
        accessCode: issued.code,
        expiresAt: issued.record.expiresAt,
      };
    },

    revokeAccessCode: async (ctx, rawAccessCodeId) => {
      const accessCodeId = requireId(rawAccessCodeId, 'Access code');
      const roles = await callerRoles(ctx);
      const code = await kit.system((sx) => authRepo.getAccessCode(sx, accessCodeId), { transaction: false });
      if (code === null) throw fail.notFound('Access code');
      await authorizeIssuer(ctx, roles, code.principalId, 'revoke');
      const revoked = await kit.system(async (sx) => {
        const result = await authRepo.revokeAccessCode(sx, accessCodeId);
        if (result?.revokedAt == null) throw fail.notFound('Access code');
        await auditRepo.appendAudit(sx, {
          action: 'access_code.revoked',
          outcome: 'succeeded',
          tenantId: ctx.tenantId,
          actorId: ctx.principalId,
          requestId: ctx.requestId,
          objectType: 'access_code',
          objectId: accessCodeId,
          metadata: { principalId: code.principalId },
        });
        return { principalId: code.principalId, revokedAt: result.revokedAt };
      });
      onPrincipalChanged(revoked.principalId);
      return { accessCodeId, revokedAt: revoked.revokedAt };
    },

    getSettings: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['platform_admin'], { objectType: 'settings' });
        return settingsFor(scope.tx);
      }),

    updateSettings: async (ctx, rawPatch) => {
      const patch = parseInput(UpdateSettingsRequest, rawPatch);
      const before = await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['platform_admin'], { objectType: 'settings' });
        return settingsFor(scope.tx);
      });
      return kit.system(async (sx) => {
        const after = await settingsRepo.updatePlatformSettings(sx, patch, ctx.principalId);
        const fields = Object.keys(patch).sort();
        await auditRepo.appendAudit(sx, {
          action: 'settings.updated',
          outcome: 'succeeded',
          tenantId: ctx.tenantId,
          actorId: ctx.principalId,
          requestId: ctx.requestId,
          objectType: 'platform_settings',
          metadata: { fields },
        });
        if (before.aiEnabled !== after.aiEnabled) {
          await auditRepo.appendAudit(sx, {
            action: after.aiEnabled ? 'kill_switch.released' : 'kill_switch.engaged',
            outcome: 'succeeded',
            tenantId: ctx.tenantId,
            actorId: ctx.principalId,
            requestId: ctx.requestId,
            objectType: 'platform_settings',
            objectId: 'ai_enabled',
          });
        }
        return after;
      });
    },

    listAudit: async (ctx, rawQuery = {}) => {
      const query = parseInput(AuditQuery, rawQuery);
      await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['platform_admin'], { objectType: 'audit' });
      });
      try {
        return await kit.system(
          (sx) =>
            auditRepo.listAuditEvents(sx, {
              ...(query.action === undefined ? {} : { action: query.action }),
              ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
              cursor: query.cursor ?? null,
              limit: query.limit,
            }),
          { transaction: false },
        );
      } catch (err) {
        if (err instanceof SqlUsageError)
          throw fail.validation('Invalid cursor', [{ path: 'cursor', message: 'Invalid cursor' }]);
        throw err;
      }
    },

    usageSummary: async (ctx) => {
      const settings = await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['platform_admin'], { objectType: 'usage' });
        return settingsFor(scope.tx);
      });
      const summary = await kit.system((sx) => usageRepo.getUsageSummary(sx, 30), { transaction: false });
      return {
        todayUsd: summary.todayUsd,
        last30DaysUsd: summary.last30DaysUsd,
        capGlobalUsd: settings.dailyUsdCapGlobal,
        byDay: summary.byDay.map((d) => ({ day: d.day, usd: d.usd, turns: d.turns })),
        byModel: summary.byModel.map((m) => ({
          modelId: m.modelId,
          usd: m.usd,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        })),
      };
    },
  };
}
