import {
  type CoachResponse,
  type EscalationCategory,
  type EscalationPacket,
  type EscalationPriority,
  type EvidenceItem,
} from '@foundry/contracts';

const URGENCY: Readonly<Record<EscalationPriority, string>> = {
  P0: 'Immediate (P0): security, identity or safety exposure',
  P1: 'Within 1 business day (P1): consequential decision',
  P2: 'Within 5 days (P2): expert judgment',
  P3: 'When convenient (P3)',
};

/** Neutral default reason per category (no content). */
export function defaultReason(category: EscalationCategory): string {
  return `The founder asked for human input on a ${category.replace(/_/g, ' ')} question.`;
}

/** Evidence kinds that never contain venture content (safe to list before the founder selects facts). */
const SHARED_EVIDENCE_KINDS = new Set<EvidenceItem['kind']>(['doctrine', 'resource', 'pattern']);

export interface PacketInput {
  /** The founder's question, kept verbatim. */
  readonly founderQuestion: string;
  readonly desiredDecision: string | null;
  readonly category: EscalationCategory;
  readonly priority: EscalationPriority;
  /** The turn the escalation came from, if any. */
  readonly turn?: {
    readonly response: CoachResponse | null;
    readonly evidence: readonly EvidenceItem[];
  } | null;
  readonly reason?: string | null;
}

/**
 * Assembles an escalation packet (contract `EscalationPacket`). Privacy rules:
 *  - `founderQuestion` is verbatim; nothing else from the conversation is copied.
 *  - `sharedFacts` starts empty: only confirmed memory the founder selects at `approve_sharing` is shared.
 *  - `evidenceConsidered` lists only program/doctrine/pattern evidence the coach cited (no venture records).
 *  - `unknowns` (editable by the founder) come from the coach's stated uncertainty.
 *  - always labelled `aiGenerated: true`.
 */
export function assemblePacket(input: PacketInput): EscalationPacket {
  const response = input.turn?.response ?? null;
  const cited = new Set(response?.claims.flatMap((c) => c.evidence_ids) ?? []);
  const evidenceConsidered = (input.turn?.evidence ?? [])
    .filter((e) => SHARED_EVIDENCE_KINDS.has(e.kind) && (cited.size === 0 || cited.has(e.key)))
    .slice(0, 10)
    .map((e) => ({ key: e.key, title: e.title.slice(0, 200) }));
  const nonEmpty = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? null : trimmed;
  };
  const reason =
    nonEmpty(input.reason) ??
    (response?.escalation.required ? nonEmpty(response.escalation.reason) : null) ??
    defaultReason(input.category);
  return {
    founderQuestion: input.founderQuestion,
    desiredDecision: input.desiredDecision,
    sharedFacts: [],
    evidenceConsidered,
    conflictingSignals: [],
    unknowns: (response?.uncertainty ?? []).slice(0, 5).map((u) => u.item.slice(0, 500)),
    reason: reason.slice(0, 1000),
    urgency: URGENCY[input.priority],
    proposedNextStep: response?.next_actions[0]?.action.slice(0, 500) ?? null,
    sessionSummary: null,
    aiGenerated: true,
  };
}

const WEEKDAY_FORMAT = new Map<string, Intl.DateTimeFormat>();

function weekdayIn(date: Date, timeZone: string): string {
  let fmt = WEEKDAY_FORMAT.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    WEEKDAY_FORMAT.set(timeZone, fmt);
  }
  return fmt.format(date);
}

/**
 * Due date by priority: P0 immediately, P1 one business day (weekends skipped in `timeZone`),
 * P2 five calendar days, P3 none.
 */
export function dueAtFor(priority: EscalationPriority, now: Date, timeZone: string): Date | null {
  const day = 86_400_000;
  switch (priority) {
    case 'P0':
      return now;
    case 'P1': {
      let due = new Date(now.getTime() + day);
      for (let i = 0; i < 3 && ['Sat', 'Sun'].includes(weekdayIn(due, timeZone)); i += 1) {
        due = new Date(due.getTime() + day);
      }
      return due;
    }
    case 'P2':
      return new Date(now.getTime() + 5 * day);
    case 'P3':
      return null;
  }
}
