import {
  UpdateVentureRequest,
  type VentureDetail,
  type VentureOverview,
  type VentureSummary,
} from '@foundry/contracts';
import {
  assignmentsRepo,
  escalationsRepo,
  memoryRepo,
  sessionsRepo,
  venturesRepo,
  type SqlExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess, type VentureAccessDecision } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { audit, requireId, type Kit } from '../internal/kit.js';
import { assertDistinctiveVentureName, ventureNameConflict } from '../internal/venture-names.js';
import { toMemoryView, toPersonaSummary } from '../internal/views.js';

export interface VenturesService {
  /** Ventures where the caller is a member or the assigned EIR, with card counts. */
  list(ctx: RequestContext): Promise<VentureSummary[]>;
  /** Venture detail with the resolved persona and assigned EIR (read access). */
  get(ctx: RequestContext, ventureId: string): Promise<VentureDetail>;
  /**
   * Updates name / one-liner / stage / domain / current goal (founder or team). A new name must be
   * distinctive and unique in the tenant (`assertDistinctiveVentureName`; duplicates → 409 conflict).
   * Program staff rename through `ProgramService.renameVenture`.
   */
  update(
    ctx: RequestContext,
    ventureId: string,
    patch: z.input<typeof UpdateVentureRequest>,
  ): Promise<VentureDetail>;
  /** "Since last session" brief (read access; RLS filters memory visibility per viewer). */
  overview(ctx: RequestContext, ventureId: string): Promise<VentureOverview>;
}

/** Builds the contract VentureDetail inside an authorized transaction. */
export async function loadVentureDetail(
  tx: SqlExecutor,
  ctx: RequestContext,
  decision: Pick<VentureAccessDecision, 'ventureId'>,
): Promise<VentureDetail> {
  const summary = await venturesRepo.getVentureSummary(tx, {
    ventureId: decision.ventureId,
    principalId: ctx.principalId,
  });
  const venture = await venturesRepo.getVenture(tx, decision.ventureId);
  if (summary === null || venture === null) throw fail.notFound('Venture');
  const resolved = await assignmentsRepo.resolveActiveAssignment(tx, decision.ventureId);
  return {
    ...summary,
    cohort: venture.cohort,
    classification: venture.classification,
    currentGoal: venture.currentGoal,
    persona: toPersonaSummary(resolved),
    assignedEir: resolved?.eir
      ? { id: resolved.eir.id, displayName: resolved.eir.displayName, synthetic: resolved.eir.synthetic }
      : null,
    createdAt: venture.createdAt,
  };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createVenturesService(kit: Kit, directory: DirectoryCache): VenturesService {
  return {
    list: (ctx) =>
      kit.inRequest(ctx, ({ tx }) =>
        venturesRepo.listVentureSummaries(tx, {
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
          scope: 'member',
        }),
      ),

    get: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        const decision = await requireVentureAccess(scope, ventureId, 'read');
        return loadVentureDetail(scope.tx, ctx, decision);
      });
    },

    update: async (ctx, rawVentureId, rawPatch) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const patch = parseInput(UpdateVentureRequest, rawPatch);
      if (patch.name !== undefined) assertDistinctiveVentureName(patch.name);
      return await kit.inRequest(ctx, async (scope) => {
        const decision = await requireVentureAccess(scope, ventureId, 'write');
        const updated = await venturesRepo.updateVenture(scope.tx, ventureId, patch).catch((err: unknown) => {
          throw ventureNameConflict(err);
        });
        if (updated === null) throw fail.notFound('Venture');
        await audit(scope, {
          action: 'venture.updated',
          outcome: 'succeeded',
          ventureId,
          objectType: 'venture',
          objectId: ventureId,
          metadata: { fields: Object.keys(patch).sort() },
        });
        if (patch.name !== undefined) directory.invalidate(ctx.tenantId);
        return loadVentureDetail(scope.tx, ctx, decision);
      });
    },

    overview: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        const decision = await requireVentureAccess(scope, ventureId, 'read');
        const { tx } = scope;
        const venture = await loadVentureDetail(tx, ctx, decision);
        const today = isoDay(kit.now());
        const lastSessionAt = await sessionsRepo.lastSessionAt(tx, { ventureId });
        const since = lastSessionAt ?? undefined;
        const newEvidence = since
          ? await memoryRepo.listMemory(tx, { ventureId, type: 'evidence', createdSince: since, limit: 10 })
          : [];
        const newIds = new Set(newEvidence.map((m) => m.id));
        const changedMemory = since
          ? (await memoryRepo.listMemory(tx, { ventureId, updatedSince: since, limit: 20 }))
              .filter((m) => !newIds.has(m.id))
              .slice(0, 10)
          : [];
        const verifiedDecisions = await memoryRepo.listMemory(tx, {
          ventureId,
          type: 'decision',
          status: 'confirmed',
          limit: 10,
        });
        const openAssumptions = await memoryRepo.listMemory(tx, {
          ventureId,
          type: 'hypothesis',
          openOnly: true,
          limit: 10,
        });
        const overdueActions = await memoryRepo.listMemory(tx, {
          ventureId,
          type: 'action',
          statuses: ['confirmed', 'disputed'],
          openOnly: true,
          dueBefore: today,
          orderBy: 'due',
          limit: 10,
        });
        const upcomingMilestones = await memoryRepo.listMemory(tx, {
          ventureId,
          type: 'milestone',
          openOnly: true,
          dueOnOrAfter: today,
          orderBy: 'due',
          limit: 5,
        });
        const pendingMemoryCount = await memoryRepo.countPendingMemory(tx, ventureId);
        const openEscalations = await escalationsRepo.countOpenEscalations(tx, ventureId);
        // Session recaps are founder/team material; assigned EIRs only review sampled turns.
        const recentSessions = decision.canWrite
          ? await sessionsRepo.listSessionViews(tx, { ventureId, limit: 5 })
          : [];
        return {
          venture,
          sinceLastSession: {
            lastSessionAt,
            newEvidence: newEvidence.map(toMemoryView),
            changedMemory: changedMemory.map(toMemoryView),
          },
          currentGoal: venture.currentGoal,
          verifiedDecisions: verifiedDecisions.map(toMemoryView),
          openAssumptions: openAssumptions.map(toMemoryView),
          overdueActions: overdueActions.map(toMemoryView),
          upcomingMilestones: upcomingMilestones.map(toMemoryView),
          pendingMemoryCount,
          openEscalations,
          recentSessions,
        };
      });
    },
  };
}
