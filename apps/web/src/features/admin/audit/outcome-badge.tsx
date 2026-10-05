import {
  Ban,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  OctagonAlert,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/** Outcomes allowed by the audit_events CHECK constraint (packages/db/migrations/0001_init.sql). */
export const AUDIT_OUTCOMES = ['allowed', 'denied', 'succeeded', 'failed', 'blocked'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(value);
}

const OUTCOMES: Record<
  AuditOutcome,
  { label: string; icon: LucideIcon; className: string; description: string }
> = {
  allowed: {
    label: 'Allowed',
    icon: ShieldCheck,
    className: 'border-solid border-success/45 bg-success/10 text-success',
    description: 'An authorization check passed.',
  },
  succeeded: {
    label: 'Succeeded',
    icon: CircleCheck,
    className: 'border-solid border-success/45 bg-success/10 text-success',
    description: 'The action completed.',
  },
  denied: {
    label: 'Denied',
    icon: Ban,
    className: 'border-solid border-destructive/45 bg-destructive/10 text-destructive',
    description: 'An authorization check refused the request.',
  },
  blocked: {
    label: 'Blocked',
    icon: OctagonAlert,
    className: 'border-dashed border-warning/45 bg-warning/10 text-warning',
    description: 'A safety control (kill switch, validator, spend cap or rate limit) stopped the action.',
  },
  failed: {
    label: 'Failed',
    icon: CircleX,
    className: 'border-dotted border-destructive/45 bg-destructive/10 text-destructive',
    description: 'The action was attempted and failed.',
  },
};

export function outcomeLabel(outcome: string): string {
  return isAuditOutcome(outcome) ? OUTCOMES[outcome].label : outcome;
}

/** Icon + label + border shape (+ colour), like StatusBadge, for audit outcomes. */
export function OutcomeBadge({ outcome, className }: { outcome: string; className?: string }) {
  const def = isAuditOutcome(outcome)
    ? OUTCOMES[outcome]
    : {
        label: outcome,
        icon: CircleQuestionMark,
        className: 'border-dashed border-border-strong text-muted-foreground',
        description: 'Unrecognised outcome.',
      };
  const Icon = def.icon;
  return (
    <span
      data-slot="outcome-badge"
      data-outcome={outcome}
      title={def.description}
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap',
        def.className,
        className,
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
      {def.label}
    </span>
  );
}
