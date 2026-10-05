import { CircleCheck, Clock, FileClock, CircleHelp, type LucideIcon } from 'lucide-react';

import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { cn } from '@/lib/utils';

export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'undated';

export const FRESH_DAYS = 30;
export const STALE_DAYS = 90;

const DEFS: Record<
  FreshnessLevel,
  { label: string; icon: LucideIcon; description: string; className: string }
> = {
  fresh: {
    label: 'Fresh',
    icon: CircleCheck,
    description: `Updated in the last ${FRESH_DAYS} days.`,
    className: 'border-success/40 text-success',
  },
  aging: {
    label: 'Aging',
    icon: Clock,
    description: `Last updated ${FRESH_DAYS}–${STALE_DAYS} days ago. Check it is still true.`,
    className: 'border-warning/45 text-warning border-dashed',
  },
  stale: {
    label: 'Stale',
    icon: FileClock,
    description: `Not updated for more than ${STALE_DAYS} days. Verify before relying on it.`,
    className: 'border-destructive/40 text-destructive border-dashed',
  },
  undated: {
    label: 'Undated',
    icon: CircleHelp,
    description: 'No date recorded for this source.',
    className: 'border-border-strong text-muted-foreground border-dotted',
  },
};

export function freshnessLevel(date: string | null | undefined, now: number = Date.now()): FreshnessLevel {
  if (!date) return 'undated';
  const time = Date.parse(date);
  if (Number.isNaN(time)) return 'undated';
  const days = (now - time) / 86_400_000;
  if (days <= FRESH_DAYS) return 'fresh';
  if (days <= STALE_DAYS) return 'aging';
  return 'stale';
}

/** Freshness as icon + label + border style (never colour alone), with the date for context. */
export function FreshnessBadge({
  date,
  showDate = true,
  className,
}: {
  date: string | null | undefined;
  showDate?: boolean;
  className?: string;
}) {
  const level = freshnessLevel(date);
  const def = DEFS[level];
  const Icon = def.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)} title={def.description}>
      <span
        className={cn(
          'inline-flex h-5 items-center gap-1 rounded-md border px-1.5 font-medium',
          def.className,
        )}
      >
        <Icon aria-hidden className="size-3" />
        {def.label}
      </span>
      {showDate && date ? (
        <time dateTime={isoString(date)} title={formatDateTime(date)} className="text-muted-foreground">
          {formatRelative(date)}
        </time>
      ) : null}
    </span>
  );
}
