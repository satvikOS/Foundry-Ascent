import type { EscalationView } from '@foundry/contracts';
import { Ban, CircleCheck, CircleDashed, CircleDot, Undo2, type LucideIcon } from 'lucide-react';

import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

export type TimelineState = 'done' | 'current' | 'upcoming' | 'withdrawn' | 'declined';

export interface TimelineStep {
  id: string;
  label: string;
  detail: string | null;
  at: string | null;
  state: TimelineState;
}

/** The happy path of the escalation state machine (system design §6.2); withdrawn/declined end it early. */
const ORDER = [
  'draft',
  'awaiting_consent',
  'awaiting_assignment',
  'routed',
  'acknowledged',
  'resolved',
] as const;

/** Derive the human-readable lifecycle of an escalation from its status and timestamps. */
export function escalationTimeline(e: EscalationView): TimelineStep[] {
  const role = REQUESTED_ROLE_LABELS[e.requestedRole] ?? 'a person';
  const reached = (status: (typeof ORDER)[number]) => {
    const index = ORDER.indexOf(status);
    const current = (ORDER as readonly string[]).indexOf(e.status);
    return current >= index;
  };
  // The database guarantees consent for every state from `awaiting_assignment` on.
  const consented = e.sharingConsentAt !== null;
  const steps: TimelineStep[] = [
    {
      id: 'drafted',
      label: 'Request drafted',
      detail: 'Foundry Guide (AI) drafted the packet from your request.',
      at: e.createdAt,
      state: 'done',
    },
    {
      id: 'consent',
      label: 'Your consent',
      detail: consented
        ? 'You chose what to share.'
        : 'Waiting for you to review the packet and choose what to share.',
      at: e.sharingConsentAt,
      state: consented ? 'done' : 'current',
    },
    {
      id: 'routed',
      label: `Shared with ${role}`,
      detail: e.assignee
        ? `Assigned to ${e.assignee.displayName}.`
        : 'Waiting for the program team to assign someone.',
      at: null,
      // `awaiting_assignment`: consented and waiting in the program team's routing queue.
      state: reached('routed')
        ? e.status === 'routed'
          ? 'current'
          : 'done'
        : e.status === 'awaiting_assignment'
          ? 'current'
          : 'upcoming',
    },
    {
      id: 'acknowledged',
      label: 'Picked up',
      detail: e.assignee ? `${e.assignee.displayName} is working on it.` : null,
      at: null,
      state: reached('acknowledged') ? (e.status === 'acknowledged' ? 'current' : 'done') : 'upcoming',
    },
    {
      id: 'resolved',
      label: 'Resolved',
      detail: e.resolution?.summary ?? null,
      at: e.status === 'resolved' ? e.updatedAt : null,
      state: e.status === 'resolved' ? 'done' : 'upcoming',
    },
  ];

  if (e.status === 'withdrawn' || e.status === 'declined') {
    const terminal: TimelineStep = {
      id: e.status,
      label: e.status === 'withdrawn' ? 'Withdrawn' : 'Declined',
      detail:
        e.status === 'withdrawn'
          ? 'You withdrew this request. Nothing further is shared.'
          : 'The assignee declined. The program team can route it to someone else, or you can make a new request.',
      at: e.updatedAt,
      state: e.status,
    };
    const kept = steps.filter((s) => s.state === 'done' && s.id !== 'resolved');
    return [...kept, terminal];
  }
  return steps;
}

const ICONS: Record<TimelineState, LucideIcon> = {
  done: CircleCheck,
  current: CircleDot,
  upcoming: CircleDashed,
  withdrawn: Undo2,
  declined: Ban,
};

const STATE_TEXT: Record<TimelineState, string> = {
  done: 'done',
  current: 'current step',
  upcoming: 'not yet',
  withdrawn: 'withdrawn',
  declined: 'declined',
};

export function EscalationTimeline({ escalation }: { escalation: EscalationView }) {
  const steps = escalationTimeline(escalation);
  return (
    <ol className="grid gap-0" aria-label="Status timeline">
      {steps.map((step, index) => {
        const Icon = ICONS[step.state];
        const last = index === steps.length - 1;
        return (
          <li
            key={step.id}
            className="relative flex gap-3 pb-4 last:pb-0"
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  'absolute top-6 bottom-0 left-[9px] w-px',
                  step.state === 'done' ? 'bg-foreground/40' : 'bg-border',
                )}
              />
            ) : null}
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-[19px] shrink-0',
                step.state === 'done' && 'text-foreground',
                step.state === 'current' && 'text-info',
                step.state === 'upcoming' && 'text-subtle-foreground',
                (step.state === 'withdrawn' || step.state === 'declined') && 'text-muted-foreground',
              )}
            />
            <div className="min-w-0">
              <p
                className={cn('text-sm', step.state === 'upcoming' ? 'text-muted-foreground' : 'font-medium')}
              >
                {step.label}
                <span className="sr-only"> ({STATE_TEXT[step.state]})</span>
              </p>
              {step.detail ? (
                <p className="text-[13px] leading-5 text-muted-foreground">{step.detail}</p>
              ) : null}
              {step.at ? (
                <time
                  dateTime={isoString(step.at)}
                  title={formatDateTime(step.at)}
                  className="text-xs text-subtle-foreground"
                >
                  {formatRelative(step.at)}
                </time>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
