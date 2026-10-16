import type { EscalationCategory, EscalationPriority } from '@foundry/contracts';

import type { RequestedRoleValue } from '../risk/escalation-map.js';

export interface EscalationRoute {
  priority: EscalationPriority;
  requestedRole: RequestedRoleValue;
}

/**
 * Default priority and reviewer for every escalation category: the prompt's escalation rules are
 * written from this table, and the validator fills missing fields from it, so the two cannot drift.
 * The categories the pre-classifier forces (`RISK_ESCALATION_MAP`) route the same way.
 */
export const ESCALATION_ROUTES: Readonly<Record<EscalationCategory, EscalationRoute>> = {
  security_identity: { priority: 'P0', requestedRole: 'program_lead' },
  ip_licensing: { priority: 'P1', requestedRole: 'specialist' },
  legal: { priority: 'P1', requestedRole: 'specialist' },
  securities_investment: { priority: 'P1', requestedRole: 'specialist' },
  medical_regulatory: { priority: 'P1', requestedRole: 'specialist' },
  safety_wellbeing: { priority: 'P1', requestedRole: 'university_support' },
  conflict_harassment: { priority: 'P1', requestedRole: 'university_support' },
  expert_judgment: { priority: 'P2', requestedRole: 'eir' },
  low_grounding: { priority: 'P3', requestedRole: 'eir' },
  other: { priority: 'P3', requestedRole: 'program_lead' },
};

/** When a category applies, for the categories whose name does not say it. */
const WHEN: Readonly<Partial<Record<EscalationCategory, string>>> = {
  security_identity: 'signs of account compromise, data exposure or impersonation',
  expert_judgment: 'pivots, pricing strategy, fundraising readiness, major strategic bets',
  low_grounding: 'too little evidence to advise',
  other: 'routine program questions',
};

const PRIORITY_LABEL: Readonly<Record<EscalationPriority, string>> = {
  P0: 'urgent',
  P1: 'consequential',
  P2: 'expert judgment',
  P3: 'routine',
};

/**
 * One bullet per priority, generated from {@link ESCALATION_ROUTES}: categories with the same
 * reviewer are grouped, e.g. "- P1 consequential: ip_licensing, legal (requested_role specialist); …".
 */
export function escalationTierLines(): string[] {
  const priorities: EscalationPriority[] = ['P0', 'P1', 'P2', 'P3'];
  return priorities.map((priority) => {
    const categories = (Object.keys(ESCALATION_ROUTES) as EscalationCategory[]).filter(
      (c) => ESCALATION_ROUTES[c].priority === priority,
    );
    const roles = [...new Set(categories.map((c) => ESCALATION_ROUTES[c].requestedRole))];
    const groups = roles.map((role) => {
      const inRole = categories.filter((c) => ESCALATION_ROUTES[c].requestedRole === role);
      const names = inRole.map((c) => (WHEN[c] ? `${c} (${WHEN[c]})` : c)).join(', ');
      return `${names}: requested_role ${role}`;
    });
    return `- ${priority} ${PRIORITY_LABEL[priority]}: ${groups.join('; ')}.`;
  });
}
