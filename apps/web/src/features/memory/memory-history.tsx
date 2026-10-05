import type { MemoryEventAction } from '@foundry/contracts';
import {
  Ban,
  CircleCheck,
  CircleDashed,
  Clock,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { z } from 'zod';

import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useMemoryHistory } from '@/lib/api/hooks/memory';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';

type EventAction = z.infer<typeof MemoryEventAction>;

const EVENT_DEFS: Record<EventAction, { label: string; icon: LucideIcon }> = {
  proposed: { label: 'Proposed', icon: CircleDashed },
  created: { label: 'Created', icon: Plus },
  approved: { label: 'Approved', icon: CircleCheck },
  rejected: { label: 'Rejected', icon: Ban },
  corrected: { label: 'Corrected', icon: Pencil },
  superseded: { label: 'Superseded', icon: Undo2 },
  disputed: { label: 'Disputed', icon: TriangleAlert },
  pinned: { label: 'Pinned', icon: Pin },
  unpinned: { label: 'Unpinned', icon: PinOff },
  deleted: { label: 'Deleted', icon: Trash },
  expired: { label: 'Expired', icon: Clock },
};

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  content: 'details',
  attributes: 'attributes',
  visibility: 'visibility',
  confidence: 'confidence',
  status: 'status',
  pinned: 'pinned',
};

/** Changed fields in a diff, and a reason if one was recorded (values are not repeated here). */
export function summariseDiff(diff: Record<string, unknown>): { fields: string[]; reason: string | null } {
  const reason = typeof diff.reason === 'string' && diff.reason.trim() ? diff.reason.trim() : null;
  const fields = Object.keys(diff)
    .filter((key) => key !== 'reason')
    .map((key) => FIELD_LABELS[key] ?? key.replace(/_/g, ' '));
  return { fields, reason };
}

/** Append-only version history for one memory object, newest first. */
export function MemoryHistoryTimeline({ memoryId }: { memoryId: string }) {
  const history = useMemoryHistory(memoryId);

  if (history.isPending) {
    return (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only" role="status">
          Loading history…
        </span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (history.isError) {
    return (
      <ErrorState error={history.error} onRetry={() => void history.refetch()} size="sm" headingLevel={3} />
    );
  }
  const events = [...history.data].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (events.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No changes recorded yet.</p>;
  }
  return (
    <ol className="relative grid gap-4 border-l border-border pl-5" aria-label="Version history">
      {events.map((event) => {
        const def = EVENT_DEFS[event.action];
        const Icon = def.icon;
        const { fields, reason } = summariseDiff(event.diff);
        return (
          <li key={event.id} className="relative">
            <span className="absolute top-0.5 -left-[27px] flex size-[22px] items-center justify-center rounded-full border border-border bg-card">
              <Icon aria-hidden className="size-3 text-muted-foreground" />
            </span>
            <p className="text-[13px] leading-5">
              <span className="font-medium">{def.label}</span>{' '}
              <span className="text-muted-foreground">by {event.actor.displayName}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={isoString(event.at)} title={formatDateTime(event.at)}>
                {formatRelative(event.at)}
              </time>
              {fields.length > 0 && event.action === 'corrected' ? <> · changed {fields.join(', ')}</> : null}
            </p>
            {reason ? <p className="mt-1 text-[13px] text-muted-foreground">“{reason}”</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
