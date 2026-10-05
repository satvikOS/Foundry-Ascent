import { type CoachMode, type MembershipRole } from '@foundry/contracts';
import { assignmentsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import { type RequestContext } from '../context.js';
import { DomainError, fail } from '../errors.js';
import { type RequestScope } from '../internal/kit.js';

type CoachModeValue = z.infer<typeof CoachMode>;

/**
 * - `read`: view the venture workspace (members of any role, the assigned EIR).
 * - `write`: change venture content, run sessions (founder / team members of a non-archived venture).
 * - `review`: EIR calibration work on the venture (the EIR of the venture's active assignment).
 */
export type VentureAction = 'read' | 'write' | 'review';
export type VentureRelation = 'founder' | 'team' | 'advisor' | 'assigned_eir';

export interface VentureAccessDecision {
  readonly allowed: true;
  readonly action: VentureAction;
  readonly ventureId: string;
  readonly tenantId: string;
  readonly ventureStatus: venturesRepo.VentureAccess['ventureStatus'];
  readonly membershipRole: MembershipRole | null;
  readonly isAssignedEir: boolean;
  /** Strongest relationship of the caller to the venture. */
  readonly relation: VentureRelation;
  /** Founder/team of a non-archived venture. */
  readonly canWrite: boolean;
}

export interface VentureAccessDenial {
  readonly allowed: false;
  readonly action: VentureAction;
  /** `not_found` when the caller has no relationship at all (no existence leak), else `forbidden`. */
  readonly code: 'not_found' | 'forbidden';
  readonly reason: string;
}

/** Pure authorization rule over the database-derived relationship (unit tested). */
export function decideVentureAccess(
  access: venturesRepo.VentureAccess | null,
  ctx: Pick<RequestContext, 'tenantId'>,
  action: VentureAction,
): VentureAccessDecision | VentureAccessDenial {
  if (access === null) return { allowed: false, action, code: 'not_found', reason: 'venture_not_visible' };
  if (access.tenantId !== ctx.tenantId)
    return { allowed: false, action, code: 'not_found', reason: 'cross_tenant' };
  const role = access.membershipRole;
  const relation: VentureRelation | null = role ?? (access.isAssignedEir ? 'assigned_eir' : null);
  if (relation === null) return { allowed: false, action, code: 'not_found', reason: 'no_relationship' };
  const canWrite = (role === 'founder' || role === 'team') && access.ventureStatus !== 'archived';
  let allowed: boolean;
  switch (action) {
    case 'read':
      allowed = true;
      break;
    case 'write':
      allowed = canWrite;
      break;
    case 'review':
      allowed = access.isAssignedEir;
      break;
  }
  if (!allowed) {
    const reason =
      action === 'write' && (role === 'founder' || role === 'team')
        ? 'venture_archived'
        : `insufficient_relation:${relation}`;
    return { allowed: false, action, code: 'forbidden', reason };
  }
  return {
    allowed: true,
    action,
    ventureId: access.ventureId,
    tenantId: access.tenantId,
    ventureStatus: access.ventureStatus,
    membershipRole: role,
    isAssignedEir: access.isAssignedEir,
    relation,
    canWrite,
  };
}

export interface RequireVentureAccessOptions {
  readonly objectType?: string;
  readonly objectId?: string | null;
}

/**
 * Re-derives the caller's membership/assignment for `ventureId` from the database (inside the request's
 * RLS transaction) and enforces `action`. Browser-supplied ids are never trusted as authority. Denials
 * are audited (`venture.access` / denied) after the transaction and thrown as DomainErrors.
 */
export async function requireVentureAccess(
  scope: RequestScope,
  ventureId: string,
  action: VentureAction,
  options: RequireVentureAccessOptions = {},
): Promise<VentureAccessDecision> {
  const access = await venturesRepo.getVentureAccess(scope.tx, {
    ventureId,
    principalId: scope.ctx.principalId,
  });
  const decision = decideVentureAccess(access, scope.ctx, action);
  if (!decision.allowed) {
    scope.deferAudit({
      action: 'venture.access',
      outcome: 'denied',
      // Only reference the venture when it is visible to the caller (no existence leak via audit ids).
      ventureId: access?.tenantId === scope.ctx.tenantId ? ventureId : null,
      objectType: options.objectType ?? 'venture',
      objectId: options.objectId ?? ventureId,
      policyReason: `${action}:${decision.reason}`,
    });
    throw decision.code === 'not_found'
      ? fail.notFound(
          options.objectType === undefined ? 'Venture' : capitalize(options.objectType),
          decision.reason,
        )
      : fail.forbidden(decision.reason);
  }
  return decision;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

/** The coaching assignment a session or turn may run on (resolved server-side every time). */
export interface ActiveAssignment {
  readonly assignment: assignmentsRepo.AssignmentRecord;
  readonly persona: assignmentsRepo.ResolvedAssignment['persona'];
  readonly release: NonNullable<assignmentsRepo.ResolvedAssignment['release']>;
  readonly eir: assignmentsRepo.ResolvedAssignment['eir'];
  /** Modes allowed by both the assignment and the persona release. */
  readonly allowedModes: readonly CoachModeValue[];
}

/** Pure check (unit tested): assignment present, persona active, approved release present. */
export function checkAssignment(
  resolved: assignmentsRepo.ResolvedAssignment | null,
): ActiveAssignment | DomainError {
  if (resolved === null) {
    return new DomainError('assignment_inactive', 'This venture has no active coaching assignment', {
      reason: 'no_active_assignment',
    });
  }
  if (resolved.persona.status === 'suspended') {
    return new DomainError('persona_suspended', 'The coach for this venture is suspended', {
      reason: 'persona_suspended',
    });
  }
  if (resolved.persona.status !== 'active') {
    return new DomainError('assignment_inactive', 'The coach for this venture is not active', {
      reason: `persona_${resolved.persona.status}`,
    });
  }
  if (resolved.release === null) {
    return new DomainError('assignment_inactive', 'The coach for this venture has no approved release', {
      reason: 'no_approved_release',
    });
  }
  const releaseModes = new Set(resolved.release.allowedModes);
  return {
    assignment: resolved.assignment,
    persona: resolved.persona,
    release: resolved.release,
    eir: resolved.eir,
    allowedModes: resolved.assignment.allowedModes.filter((m) => releaseModes.has(m)),
  };
}

/**
 * Resolves the venture's active assignment, persona and approved release and requires all of them to
 * be usable (kill switches per persona and per assignment). Denials are audited (`assignment.blocked`).
 */
export async function requireAssignmentActive(
  scope: RequestScope,
  ventureId: string,
): Promise<ActiveAssignment> {
  const resolved = await assignmentsRepo.resolveActiveAssignment(scope.tx, ventureId);
  const checked = checkAssignment(resolved);
  if (checked instanceof DomainError) {
    scope.deferAudit({
      action: 'assignment.blocked',
      outcome: 'blocked',
      ventureId,
      objectType: 'assignment',
      objectId: resolved?.assignment.id ?? null,
      policyReason: checked.reason ?? checked.code,
      metadata: resolved ? { personaId: resolved.persona.id } : {},
    });
    throw checked;
  }
  return checked;
}

/** Requires `mode` to be allowed by the assignment and release. */
export function requireModeAllowed(active: ActiveAssignment, mode: CoachModeValue): void {
  if (!active.allowedModes.includes(mode)) {
    throw new DomainError('forbidden', `Mode "${mode}" is not enabled for this venture`, {
      reason: 'mode_not_allowed',
    });
  }
}
