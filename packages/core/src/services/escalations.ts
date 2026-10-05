import {
  CreateEscalationRequest,
  EscalationAction,
  type CoachResponse,
  type EscalationCategory,
  type EscalationPriority,
  type EscalationView,
  type EvidenceItem,
} from '@foundry/contracts';
import { assignmentsRepo, escalationsRepo, memoryRepo, turnsRepo, type SqlExecutor } from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { toEscalationView } from '../internal/views.js';
import { assemblePacket, dueAtFor } from './escalation-packet.js';

type RequestedRoleValue = escalationsRepo.EscalationRecord['requestedRole'];

export interface EscalationsService {
  /** Escalations of a venture (founder/team). */
  list(ctx: RequestContext, ventureId: string): Promise<EscalationView[]>;
  /**
   * Founder-initiated escalation (`awaiting_consent`), optionally from a turn of the venture. The packet
   * carries the founder question verbatim, no venture facts until the founder selects them.
   */
  create(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof CreateEscalationRequest>,
  ): Promise<EscalationView>;
  /**
   * Founder/team: `approve_sharing` (consent + confirmed memory facts + routing to the assigned EIR or the
   * program-lead queue with a due date by priority), `edit`, `withdraw`.
   * Assignee (after consent only): `acknowledge`, `resolve`, `decline`.
   */
  act(
    ctx: RequestContext,
    escalationId: string,
    action: z.input<typeof EscalationAction>,
  ): Promise<EscalationView>;
  /** Consented escalations assigned to the caller (open ones). */
  inbox(ctx: RequestContext): Promise<EscalationView[]>;
}

/** Creates an AI-drafted escalation for a turn (crisis path, forced high-risk escalation). */
export async function createDraftEscalation(
  scope: RequestScope,
  args: {
    readonly ventureId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly founderText: string;
    readonly category: EscalationCategory;
    readonly priority: EscalationPriority;
    readonly requestedRole: RequestedRoleValue;
    readonly response: CoachResponse | null;
    readonly evidence: readonly EvidenceItem[];
    readonly reason: string | null;
  },
): Promise<escalationsRepo.EscalationRecord> {
  const packet = assemblePacket({
    founderQuestion: args.founderText,
    desiredDecision: null,
    category: args.category,
    priority: args.priority,
    turn: { response: args.response, evidence: args.evidence },
    reason: args.reason,
  });
  const record = await escalationsRepo.createEscalation(scope.tx, {
    tenantId: scope.ctx.tenantId,
    ventureId: args.ventureId,
    sessionId: args.sessionId,
    turnId: args.turnId,
    category: args.category,
    priority: args.priority,
    requestedRole: args.requestedRole,
    packet,
    createdBy: scope.ctx.principalId,
    status: 'draft',
  });
  await audit(scope, {
    action: 'escalation.drafted',
    outcome: 'succeeded',
    ventureId: args.ventureId,
    objectType: 'escalation',
    objectId: record.id,
    metadata: {
      category: args.category,
      priority: args.priority,
      turnId: args.turnId,
      requestedRole: args.requestedRole,
    },
  });
  return record;
}

async function loadTurnForVenture(
  tx: SqlExecutor,
  turnId: string,
  ventureId: string,
): Promise<{ turn: turnsRepo.TurnRecord; evidence: EvidenceItem[] }> {
  const turn = await turnsRepo.getTurn(tx, turnId);
  if (turn?.ventureId !== ventureId) throw fail.validation('The turn does not belong to this venture');
  const evidence = (await turnsRepo.listTurnEvidence(tx, [turnId])).get(turnId) ?? [];
  return { turn, evidence };
}

export function createEscalationsService(kit: Kit): EscalationsService {
  const timeZone = kit.config.escalations.businessTimeZone;

  async function loadVisible(
    scope: RequestScope,
    escalationId: string,
  ): Promise<escalationsRepo.EscalationRecord> {
    const record = await escalationsRepo.getEscalation(scope.tx, escalationId);
    if (record === null) {
      // Unknown, other tenant, or not yet consented for an assignee: indistinguishable on purpose.
      scope.deferAudit({
        action: 'escalation.access',
        outcome: 'denied',
        objectType: 'escalation',
        objectId: escalationId,
        policyReason: 'not_visible',
      });
      throw fail.notFound('Escalation');
    }
    return record;
  }

  return {
    list: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'escalation' });
        const items = await escalationsRepo.listVentureEscalations(scope.tx, { ventureId });
        return items.map((e) => toEscalationView(e));
      });
    },

    create: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(CreateEscalationRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'escalation' });
        const fromTurn = input.turnId ? await loadTurnForVenture(scope.tx, input.turnId, ventureId) : null;
        const packet = assemblePacket({
          founderQuestion: input.founderQuestion,
          desiredDecision: input.desiredDecision,
          category: input.category,
          priority: input.priority,
          turn: fromTurn ? { response: fromTurn.turn.response, evidence: fromTurn.evidence } : null,
        });
        const record = await escalationsRepo.createEscalation(scope.tx, {
          tenantId: ctx.tenantId,
          ventureId,
          sessionId: fromTurn?.turn.sessionId ?? null,
          turnId: fromTurn?.turn.id ?? null,
          category: input.category,
          priority: input.priority,
          requestedRole: input.requestedRole,
          packet,
          createdBy: ctx.principalId,
          status: 'awaiting_consent',
        });
        await audit(scope, {
          action: 'escalation.created',
          outcome: 'succeeded',
          ventureId,
          objectType: 'escalation',
          objectId: record.id,
          metadata: { category: input.category, priority: input.priority, fromTurn: fromTurn !== null },
        });
        return toEscalationView(record);
      });
    },

    act: async (ctx, rawEscalationId, rawAction) => {
      const escalationId = requireId(rawEscalationId, 'Escalation');
      const action = parseInput(EscalationAction, rawAction);
      return await kit.inRequest(ctx, async (scope) => {
        const { tx } = scope;
        const current = await loadVisible(scope, escalationId);
        let updated: escalationsRepo.EscalationRecord | null;
        const metadata: Record<string, string | number | boolean | null> = { from: current.status };

        if (action.action === 'approve_sharing' || action.action === 'edit' || action.action === 'withdraw') {
          await requireVentureAccess(scope, current.ventureId, 'write', {
            objectType: 'escalation',
            objectId: escalationId,
          });
          if (action.action === 'approve_sharing') {
            if (current.status !== 'draft' && current.status !== 'awaiting_consent') {
              throw fail.conflict('Sharing was already decided for this escalation', 'invalid_transition');
            }
            if (current.packet === null)
              throw fail.conflict('The escalation packet is unreadable', 'invalid_packet');
            const ids = [...new Set(action.sharedMemoryIds.map((id) => id.toLowerCase()))];
            const memory = await memoryRepo.getMemoryByIds(tx, ids);
            const byId = new Map(memory.map((m) => [m.id, m]));
            const invalid = ids.filter((id) => {
              const m = byId.get(id);
              return m?.ventureId !== current.ventureId || m.status !== 'confirmed';
            });
            if (invalid.length > 0) {
              throw fail.validation('Only confirmed memory of this venture can be shared', [
                {
                  path: 'sharedMemoryIds',
                  message: `${invalid.length} item(s) are not confirmed memory of this venture`,
                },
              ]);
            }
            const sharedFacts = ids.flatMap((id) => {
              const m = byId.get(id);
              return m ? [{ memoryId: m.id, text: `${m.title}: ${m.content}`.slice(0, 1000) }] : [];
            });
            const resolved = await assignmentsRepo.resolveActiveAssignment(tx, current.ventureId);
            const eirPrincipal =
              current.requestedRole === 'eir' && resolved?.eir?.status === 'active'
                ? resolved.eir.principalId
                : null;
            const dueAt = dueAtFor(current.priority, kit.now(), timeZone);
            updated = await escalationsRepo.recordSharingConsent(tx, {
              escalationId,
              consentBy: ctx.principalId,
              assigneeId: eirPrincipal,
              dueAt,
              packet: { ...current.packet, sharedFacts },
            });
            metadata.sharedFacts = sharedFacts.length;
            metadata.routedTo = eirPrincipal ? 'assigned_eir' : 'program_queue';
            metadata.priority = current.priority;
          } else if (action.action === 'edit') {
            if (current.packet === null)
              throw fail.conflict('The escalation packet is unreadable', 'invalid_packet');
            const patch = action.packet;
            updated = await escalationsRepo.updateEscalationPacket(tx, {
              escalationId,
              packet: {
                ...current.packet,
                ...(patch.founderQuestion === undefined ? {} : { founderQuestion: patch.founderQuestion }),
                ...(patch.desiredDecision === undefined ? {} : { desiredDecision: patch.desiredDecision }),
                ...(patch.unknowns === undefined ? {} : { unknowns: patch.unknowns.slice(0, 20) }),
                aiGenerated: true,
              },
            });
            metadata.fields = Object.keys(patch).length;
          } else {
            updated = await escalationsRepo.transitionEscalation(tx, {
              escalationId,
              action: 'withdraw',
              actorId: ctx.principalId,
            });
          }
        } else {
          if (current.assignee?.id !== ctx.principalId || current.sharingConsentAt === null) {
            scope.deferAudit({
              action: 'escalation.access',
              outcome: 'denied',
              ventureId: current.ventureId,
              objectType: 'escalation',
              objectId: escalationId,
              policyReason: `${action.action}:not_assignee`,
            });
            throw fail.forbidden('not_assignee', 'Only the assigned person can do this');
          }
          updated = await escalationsRepo.transitionEscalation(tx, {
            escalationId,
            action: action.action,
            actorId: ctx.principalId,
            resolution:
              action.action === 'resolve'
                ? action.resolution
                : action.action === 'decline'
                  ? { summary: action.reason, nextSteps: [] }
                  : null,
          });
        }
        if (updated === null)
          throw fail.conflict('The escalation cannot change in its current state', 'invalid_transition');
        metadata.to = updated.status;
        await audit(scope, {
          action: `escalation.${action.action}`,
          outcome: 'succeeded',
          ventureId: current.ventureId,
          objectType: 'escalation',
          objectId: escalationId,
          metadata,
        });
        return toEscalationView(updated);
      });
    },

    inbox: (ctx) =>
      kit.inRequest(ctx, async ({ tx }) => {
        const items = await escalationsRepo.listInboxEscalations(tx, { assigneeId: ctx.principalId });
        return items.map((e) => toEscalationView(e));
      }),
  };
}
