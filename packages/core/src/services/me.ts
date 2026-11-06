import {
  DEFAULT_DISCLOSURE,
  VeirWelcomeAcknowledgeRequest,
  veirIntroductionKey,
  type AccountNotice,
  type Me,
  type VeirWelcomeAcknowledgement,
} from '@foundry/contracts';
import {
  assignmentsRepo,
  authRepo,
  personasRepo,
  principalsRepo,
  settingsRepo,
  tenantsRepo,
  type SqlExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { loadPrincipalRoles } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError, parseInput } from '../errors.js';
import { audit, type Kit } from '../internal/kit.js';

export interface MeService {
  /**
   * The caller's identity, roles, memberships, assigned ventures, disclosure, AI kill-switch state, account
   * notices and when they acknowledged the vEIR welcome. With `sessionId` (a verified session), `notices` lists
   * access codes someone else issued for this account since the caller's previous sign-in.
   */
  get(ctx: RequestContext & { readonly sessionId?: string }): Promise<Me>;
  /**
   * The caller read the welcome that introduces their mentor (what it is, once per mentor and presentation, before
   * their first conversation with it): stored with the person (migrations 0016 and 0029), idempotent (a repeat
   * returns the first time), audited only when an introduction is new. With `personaId`, that mentor's
   * introduction, when it is the mentor of one of the caller's ventures; without, every mentor the caller meets
   * in their ventures today (older web builds and scripts).
   */
  acknowledgeVeirWelcome(
    ctx: RequestContext,
    input?: z.input<typeof VeirWelcomeAcknowledgeRequest>,
  ): Promise<VeirWelcomeAcknowledgement>;
}

/**
 * The introductions of the mentors the caller meets today: the persona of each venture they found or work on (the
 * people the welcome is for), keyed by how it presents itself (`veirIntroductionKey`).
 */
async function currentIntroductions(tx: SqlExecutor, ctx: RequestContext): Promise<Map<string, string>> {
  const memberships = await principalsRepo.listMembershipsForPrincipals(tx, [ctx.principalId]);
  const byPersona = new Map<string, string>();
  for (const membership of memberships) {
    if (membership.role !== 'founder' && membership.role !== 'team') continue;
    const resolved = await assignmentsRepo.resolveActiveAssignment(tx, membership.ventureId);
    if (resolved?.release == null || byPersona.has(resolved.persona.id)) continue;
    const mentor =
      resolved.persona.kind === 'eir_persona' &&
      (
        await personasRepo.getPersonaPresence(tx, {
          personaId: resolved.persona.id,
          assignedEirProfileId: null,
        })
      ).mentor;
    byPersona.set(resolved.persona.id, veirIntroductionKey(resolved.persona.id, mentor ? 'mentor' : 'twin'));
  }
  return byPersona;
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
          veirWelcomeAcknowledgedAt: await principalsRepo.veirWelcomeAcknowledgedAt(tx),
          veirWelcomeIntroductions: await principalsRepo.veirWelcomeIntroductions(tx),
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

    acknowledgeVeirWelcome: async (ctx, input = {}) =>
      kit.inRequest(ctx, async (scope) => {
        const { personaId } = parseInput(VeirWelcomeAcknowledgeRequest, input);
        const current = await currentIntroductions(scope.tx, ctx);
        // A persona that is not the caller's mentor (or no longer is) adds nothing: the 0016 acknowledgement only.
        const keys =
          personaId === undefined
            ? [...current.values()]
            : [current.get(personaId)].filter((key): key is string => key !== undefined);
        const acknowledged = await principalsRepo.acknowledgeVeirIntroductions(scope.tx, keys.slice(0, 20));
        if (acknowledged === null) {
          throw new DomainError('unauthenticated', 'Please sign in again.', {
            reason: 'principal_unavailable',
          });
        }
        if (acknowledged.firstTime) {
          await audit(scope, {
            action: 'veir.welcome_acknowledged',
            outcome: 'succeeded',
            objectType: 'principal',
            objectId: ctx.principalId,
          });
        }
        return {
          acknowledgedAt: acknowledged.acknowledgedAt,
          introductions: await principalsRepo.veirWelcomeIntroductions(scope.tx),
        };
      }),
  };
}
