/** Outcomes allowed by the audit_events CHECK constraint (packages/db/migrations/0001_init.sql). */
export const AUDIT_OUTCOMES = ['allowed', 'denied', 'succeeded', 'failed', 'blocked'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(value);
}
