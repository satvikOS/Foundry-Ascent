import {
  CreateVentureRequest,
  type EscalationAssignee,
  type EscalationQueueItem,
  type EscalationStatus,
  type ProgramVentureRow,
  RenameVentureRequest,
  ResourceFilter,
  RouteEscalationRequest,
  UpdateResourceRequest,
  UpsertResourceRequest,
  type PortfolioSummary,
  type ResourceView,
} from '@foundry/contracts';
import {
  assignmentsRepo,
  escalationsRepo,
  personasRepo,
  portfolioRepo,
  principalsRepo,
  resourcesRepo,
  venturesRepo,
} from '@foundry/db';
import type { z } from 'zod';

import { hasAnyRole, requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { assertDistinctiveVentureName, ventureNameConflict } from '../internal/venture-names.js';
import { toResourceView } from '../internal/views.js';
import { dueAtFor } from './escalation-packet.js';

type ProgramVentureRowValue = z.infer<typeof ProgramVentureRow>;
type EscalationQueueItemValue = z.infer<typeof EscalationQueueItem>;

/** States a consented escalation can be routed (or re-routed) from (system design §6.2). */
const ROUTABLE_STATUSES: ReadonlySet<EscalationStatus> = new Set([
  'awaiting_assignment',
  'routed',
  'acknowledged',
]);

/** PATCH /program/resources/:id body and GET /program/resources query (now in @foundry/contracts). */
export { ResourceFilter, UpdateResourceRequest };

export interface ProgramService {
  /** k-anonymous portfolio aggregates (program lead or platform admin). */
  portfolio(ctx: RequestContext): Promise<PortfolioSummary>;
  /** Venture metadata for the program console (program lead). */
  listVentures(ctx: RequestContext): Promise<ProgramVentureRowValue[]>;
  /**
   * Enrols a venture and assigns the tenant's mentor persona ({@link personasRepo.findMentorPersona}: Thomas, ADR-0021),
   * with the EIR it is built from as the venture's reviewer, as every EIR persona is assigned; without one, the tenant's
   * active neutral Foundry Guide and no reviewer (program lead).
   */
  createVenture(
    ctx: RequestContext,
    input: z.input<typeof CreateVentureRequest>,
  ): Promise<ProgramVentureRowValue>;
  /**
   * Renames any venture of the caller's tenant (program lead or platform admin, membership not needed),
   * e.g. to undo a rename by the venture's team. Same name rules as `VenturesService.update`.
   */
  renameVenture(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof RenameVentureRequest>,
  ): Promise<ProgramVentureRowValue>;
  /** Program resources (any signed-in principal of the tenant). */
  listResources(ctx: RequestContext, filter?: z.input<typeof ResourceFilter>): Promise<ResourceView[]>;
  createResource(ctx: RequestContext, input: z.input<typeof UpsertResourceRequest>): Promise<ResourceView>;
  updateResource(
    ctx: RequestContext,
    resourceId: string,
    patch: z.input<typeof UpdateResourceRequest>,
  ): Promise<ResourceView>;
  /** Escalation metadata queue via app.escalation_queue() (program lead or platform admin). */
  escalationQueue(ctx: RequestContext): Promise<EscalationQueueItemValue[]>;
  /**
   * People an escalation can be routed to: active EIRs and program leads of the caller's tenant, by name
   * (program lead or platform admin).
   */
  listAssignees(ctx: RequestContext): Promise<EscalationAssignee[]>;
  /**
   * Routes a consented escalation (`awaiting_assignment`, or re-routes a `routed` / `acknowledged` one) to
   * an active EIR or program lead of the tenant; it becomes `routed` (program lead or platform admin).
   */
  routeEscalation(
    ctx: RequestContext,
    escalationId: string,
    input: z.input<typeof RouteEscalationRequest>,
  ): Promise<EscalationQueueItemValue>;
}

/** Who coaches a new venture: the tenant's mentor, else its neutral guide (null: the tenant has neither). */
async function newVentureCoach(
  scope: RequestScope,
  tenantId: string,
): Promise<Pick<
  assignmentsRepo.CreateAssignmentInput,
  'personaId' | 'eirProfileId' | 'allowedModes'
> | null> {
  const mentor = await personasRepo.findMentorPersona(scope.tx, { tenantId });
  if (mentor !== null) {
    return {
      personaId: mentor.id,
      eirProfileId: mentor.eirProfileId,
      allowedModes: mentor.allowedModes,
    };
  }
  const guide = (await personasRepo.listPersonaViews(scope.tx, tenantId)).find(
    (p) => p.kind === 'neutral_guide' && p.status === 'active' && p.activeRelease !== null,
  );
  return guide === undefined ? null : { personaId: guide.id };
}

export function createProgramService(kit: Kit, directory: DirectoryCache): ProgramService {
  const timeZone = kit.config.escalations.businessTimeZone;

  return {
    portfolio: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead', 'platform_admin'], { objectType: 'portfolio' });
        return portfolioRepo.getPortfolioSummary(scope.tx);
      }),

    listVentures: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'venture' });
        return venturesRepo.listProgramVentures(scope.tx, ctx.tenantId);
      }),

    createVenture: async (ctx, rawInput) => {
      const input = parseInput(CreateVentureRequest, rawInput);
      assertDistinctiveVentureName(input.name);
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'venture' });
        const venture = await venturesRepo
          .createVenture(scope.tx, {
            tenantId: ctx.tenantId,
            name: input.name,
            oneLiner: input.oneLiner,
            stage: input.stage,
            domain: input.domain,
            cohort: input.cohort,
            classification: 'synthetic',
          })
          .catch((err: unknown) => {
            throw ventureNameConflict(err);
          });
        const coach = await newVentureCoach(scope, ctx.tenantId);
        let assignmentId: string | null = null;
        if (coach !== null) {
          const assignment = await assignmentsRepo.createAssignment(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId: venture.id,
            ...coach,
            createdBy: ctx.principalId,
          });
          assignmentId = assignment.id;
        }
        await audit(scope, {
          action: 'venture.created',
          outcome: 'succeeded',
          ventureId: venture.id,
          objectType: 'venture',
          objectId: venture.id,
          metadata: {
            assignmentId,
            personaId: coach?.personaId ?? null,
            eirProfileId: coach?.eirProfileId ?? null,
            stage: venture.stage,
          },
        });
        directory.invalidate(ctx.tenantId);
        const row = (await venturesRepo.listProgramVentures(scope.tx, ctx.tenantId)).find(
          (v) => v.id === venture.id,
        );
        if (!row) throw fail.notFound('Venture');
        return row;
      });
    },

    renameVenture: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(RenameVentureRequest, rawInput);
      assertDistinctiveVentureName(input.name);
      await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead', 'platform_admin'], {
          objectType: 'venture',
          objectId: ventureId,
        });
        const renamed = await venturesRepo
          .renameVentureAsStaff(scope.tx, { ventureId, name: input.name })
          .catch((err: unknown) => {
            throw ventureNameConflict(err);
          });
        if (!renamed) throw fail.notFound('Venture');
        await audit(scope, {
          action: 'venture.renamed',
          outcome: 'succeeded',
          ventureId,
          objectType: 'venture',
          objectId: ventureId,
          metadata: { by: 'program_staff' },
        });
      });
      directory.invalidate(ctx.tenantId);
      // Read after the rename committed, with the owner role: a platform admin without program_lead sees
      // no ventures under RLS. Only the renamed venture of the caller's tenant is returned (metadata only).
      const row = (
        await kit.system((sx) => venturesRepo.listProgramVentures(sx, ctx.tenantId), { transaction: false })
      ).find((v) => v.id === ventureId);
      if (!row) throw fail.notFound('Venture');
      return row;
    },

    listResources: async (ctx, rawFilter = {}) => {
      const filter = parseInput(ResourceFilter, rawFilter);
      return await kit.inRequest(ctx, async ({ tx }) => {
        const items = await resourcesRepo.listResources(tx, {
          tenantId: ctx.tenantId,
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          ...(filter.stage === undefined ? {} : { stage: filter.stage }),
          ...(filter.tag === undefined ? {} : { tag: filter.tag }),
          ...(filter.q === undefined || filter.q === '' ? {} : { q: filter.q }),
        });
        return items.map(toResourceView);
      });
    },

    createResource: async (ctx, rawInput) => {
      const input = parseInput(UpsertResourceRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'resource' });
        const created = await resourcesRepo.createResource(scope.tx, { ...input, tenantId: ctx.tenantId });
        await audit(scope, {
          action: 'resource.created',
          outcome: 'succeeded',
          objectType: 'resource',
          objectId: created.id,
          metadata: { kind: created.kind },
        });
        return toResourceView(created);
      });
    },

    updateResource: async (ctx, rawResourceId, rawPatch) => {
      const resourceId = requireId(rawResourceId, 'Resource');
      const patch = parseInput(UpdateResourceRequest, rawPatch);
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'resource', objectId: resourceId });
        const existing = await resourcesRepo.getResource(scope.tx, resourceId);
        if (existing?.tenantId !== ctx.tenantId) throw fail.notFound('Resource');
        const updated = await resourcesRepo.updateResource(scope.tx, resourceId, patch);
        if (updated === null) throw fail.notFound('Resource');
        await audit(scope, {
          action: 'resource.updated',
          outcome: 'succeeded',
          objectType: 'resource',
          objectId: resourceId,
          metadata: { fields: Object.keys(patch).sort() },
        });
        return toResourceView(updated);
      });
    },

    escalationQueue: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead', 'platform_admin'], { objectType: 'escalation' });
        return escalationsRepo.escalationQueue(scope.tx);
      }),

    listAssignees: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead', 'platform_admin'], { objectType: 'principal' });
        const rows = await principalsRepo.listEscalationAssignees(scope.tx, ctx.tenantId);
        return rows.map((row) => ({
          principal: principalsRepo.toPrincipalView(row.principal),
          roles: row.roles,
          expertiseTags: row.expertiseTags,
        }));
      }),

    routeEscalation: async (ctx, rawEscalationId, rawInput) => {
      const escalationId = requireId(rawEscalationId, 'Escalation');
      const input = parseInput(RouteEscalationRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead', 'platform_admin'], {
          objectType: 'escalation',
          objectId: escalationId,
        });
        const before = (await escalationsRepo.escalationQueue(scope.tx)).find((e) => e.id === escalationId);
        if (!before) throw fail.notFound('Escalation');
        if (!before.shared)
          throw fail.conflict('The founder has not agreed to share this escalation', 'consent_missing');
        if (!ROUTABLE_STATUSES.has(before.status))
          throw fail.conflict('This escalation is closed and cannot be routed', 'invalid_transition');
        // Packets only go to program staff or EIRs of the tenant, never to another venture's members.
        const assigneeRoles = await principalsRepo.listActiveRoles(scope.tx, {
          principalId: input.assigneeId,
          tenantId: ctx.tenantId,
        });
        if (!hasAnyRole(assigneeRoles, ['eir', 'program_lead'])) {
          scope.deferAudit({
            action: 'escalation.route_denied',
            outcome: 'denied',
            ventureId: before.ventureId,
            objectType: 'escalation',
            objectId: escalationId,
            policyReason: 'assignee_not_staff',
          });
          throw fail.validation('Escalations can only be routed to an EIR or program lead', [
            { path: 'assigneeId', message: 'Must be an EIR or program lead of this tenant' },
          ]);
        }
        const dueAt = input.dueAt ?? dueAtFor(before.priority, kit.now(), timeZone);
        const routed = await escalationsRepo.routeEscalation(scope.tx, {
          escalationId,
          assigneeId: input.assigneeId,
          dueAt,
        });
        if (!routed) throw fail.notFound('Escalation');
        await audit(scope, {
          action: 'escalation.routed',
          outcome: 'succeeded',
          ventureId: before.ventureId,
          objectType: 'escalation',
          objectId: escalationId,
          metadata: { assigneeId: input.assigneeId, priority: before.priority },
        });
        const after = (await escalationsRepo.escalationQueue(scope.tx)).find((e) => e.id === escalationId);
        if (!after) throw fail.notFound('Escalation');
        return after;
      });
    },
  };
}
