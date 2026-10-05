import type { Me, MembershipRole, PlatformRole } from '@foundry/contracts';

/**
 * UI-side role helpers. They only decide what to SHOW; the API (service layer + RLS) is the authority
 * and re-derives access on every request (system-design §4.3). Never rely on these for security.
 */
export function hasRole(me: Me | null | undefined, role: PlatformRole): boolean {
  return Boolean(me?.roles.includes(role));
}

export function hasAnyRole(me: Me | null | undefined, roles: readonly PlatformRole[]): boolean {
  return roles.some((role) => hasRole(me, role));
}

export function membershipFor(me: Me | null | undefined, ventureId: string) {
  return me?.memberships.find((m) => m.ventureId === ventureId) ?? null;
}

/** Venture member (founder / team / advisor), optionally restricted to specific membership roles. */
export function isMember(
  me: Me | null | undefined,
  ventureId: string,
  roles?: readonly MembershipRole[],
): boolean {
  const membership = membershipFor(me, ventureId);
  if (!membership) return false;
  return roles ? roles.includes(membership.role) : true;
}

export function isAssignedEir(me: Me | null | undefined, ventureId: string): boolean {
  return hasRole(me, 'eir') && Boolean(me?.assignedVentureIds.includes(ventureId));
}

/** Can open the venture workspace at all (member or assigned EIR). */
export function canAccessVenture(me: Me | null | undefined, ventureId: string): boolean {
  return isMember(me, ventureId) || isAssignedEir(me, ventureId);
}

/**
 * Can change venture content (sessions, memory approvals, documents, escalations): founders and team.
 * Advisors and EIRs are read-only in the workspace.
 */
export function canWrite(me: Me | null | undefined, ventureId: string): boolean {
  return isMember(me, ventureId, ['founder', 'team']);
}

/** Founder-only actions (e.g. sharing consent on escalation packets). */
export function isFounder(me: Me | null | undefined, ventureId: string): boolean {
  return isMember(me, ventureId, ['founder']);
}

export function canUseEirStudio(me: Me | null | undefined): boolean {
  return hasAnyRole(me, ['eir', 'program_lead']);
}

export function canUseProgramConsole(me: Me | null | undefined): boolean {
  return hasRole(me, 'program_lead');
}

export function canUseAdminConsole(me: Me | null | undefined): boolean {
  return hasRole(me, 'platform_admin');
}

export const ROLE_LABELS: Record<PlatformRole | MembershipRole, string> = {
  platform_admin: 'Platform admin',
  program_lead: 'Program lead',
  eir: 'EIR',
  founder: 'Founder',
  team: 'Team',
  advisor: 'Advisor',
};

/** Short description of who the person is in this workspace, for the user menu. */
export function describeRoles(me: Me): string {
  const labels = me.roles.map((role) => ROLE_LABELS[role]);
  if (labels.length === 0 && me.memberships.length > 0) {
    const roles = new Set(me.memberships.map((m) => ROLE_LABELS[m.role]));
    return [...roles].join(' · ');
  }
  return labels.join(' · ') || 'Member';
}
