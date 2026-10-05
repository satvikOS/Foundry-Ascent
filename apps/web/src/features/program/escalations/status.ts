import { CLOSED_ESCALATION_STATUSES, type EscalationStatus, type EscalationView } from '@foundry/contracts';

const CLOSED_STATUSES: ReadonlySet<EscalationStatus> = new Set(CLOSED_ESCALATION_STATUSES);

/** Open = still needs a human (anything not resolved, declined or withdrawn). */
export function isOpenEscalation(entry: Pick<EscalationView, 'status'>): boolean {
  return !CLOSED_STATUSES.has(entry.status);
}

export function isOverdue(entry: Pick<EscalationView, 'status' | 'dueAt'>, now = Date.now()): boolean {
  return isOpenEscalation(entry) && entry.dueAt !== null && Date.parse(entry.dueAt) < now;
}

const ROUTABLE_STATUSES: ReadonlySet<EscalationStatus> = new Set([
  'awaiting_assignment',
  'routed',
  'acknowledged',
]);

/**
 * Whether a program lead can route (or re-route) the escalation: the founder consented and it is still
 * open (`awaiting_assignment`, `routed`, `acknowledged`), the states the API accepts.
 */
export function isRoutable(entry: Pick<EscalationView, 'status'>): boolean {
  return ROUTABLE_STATUSES.has(entry.status);
}

/**
 * True while the founder still has to review the packet and decide what to share (`draft` or
 * `awaiting_consent`). Once they consent the escalation is `awaiting_assignment` or `routed`.
 */
export function needsFounderConsent(entry: Pick<EscalationView, 'status'>): boolean {
  return entry.status === 'draft' || entry.status === 'awaiting_consent';
}

/** P0 first; used to sort queues by urgency. */
export const PRIORITY_RANK: Readonly<Record<string, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };
