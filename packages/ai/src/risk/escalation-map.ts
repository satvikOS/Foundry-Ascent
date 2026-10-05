import type { EscalationCategory, EscalationPriority, RiskCategory } from '@foundry/contracts';

export type RequestedRoleValue = 'eir' | 'program_lead' | 'specialist' | 'university_support';

export interface RiskEscalation {
  category: EscalationCategory;
  priority: EscalationPriority;
  requestedRole: RequestedRoleValue;
}

/**
 * Pre-classifier category → escalation routing. P1 = consequential (IP, legal, securities,
 * medical/regulatory, safety, harassment); P0 = security/identity.
 */
export const RISK_ESCALATION_MAP: Readonly<Record<RiskCategory, RiskEscalation>> = {
  safety_wellbeing: { category: 'safety_wellbeing', priority: 'P1', requestedRole: 'university_support' },
  medical_regulatory: { category: 'medical_regulatory', priority: 'P1', requestedRole: 'specialist' },
  securities_investment: { category: 'securities_investment', priority: 'P1', requestedRole: 'specialist' },
  legal: { category: 'legal', priority: 'P1', requestedRole: 'specialist' },
  ip_licensing: { category: 'ip_licensing', priority: 'P1', requestedRole: 'specialist' },
  conflict_harassment: {
    category: 'conflict_harassment',
    priority: 'P1',
    requestedRole: 'university_support',
  },
  prompt_injection: { category: 'security_identity', priority: 'P0', requestedRole: 'program_lead' },
  cross_venture_request: { category: 'security_identity', priority: 'P0', requestedRole: 'program_lead' },
};

/**
 * Categories for which a human escalation is always forced (in precedence order: when several are
 * flagged, the first one becomes the escalation category). Prompt injection and cross-venture
 * requests are recorded and refused, but do not by themselves page a human: a curious founder
 * typing "ignore your instructions" is not a security incident.
 */
export const FORCED_ESCALATION_CATEGORIES: readonly RiskCategory[] = [
  'safety_wellbeing',
  'medical_regulatory',
  'securities_investment',
  'legal',
  'ip_licensing',
  'conflict_harassment',
];

const PRIORITY_RANK: Readonly<Record<EscalationPriority, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** The more urgent of two priorities (P0 is most urgent). */
export function morePressing(a: EscalationPriority, b: EscalationPriority): EscalationPriority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

/** The highest-precedence forced category among `categories`, or null. */
export function primaryForcedCategory(categories: readonly RiskCategory[]): RiskCategory | null {
  const set = new Set(categories);
  return FORCED_ESCALATION_CATEGORIES.find((c) => set.has(c)) ?? null;
}
