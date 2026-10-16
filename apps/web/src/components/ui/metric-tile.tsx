import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Skeleton } from './skeleton';

interface MetricTileProps {
  label: string;
  /** Pre-formatted value; `null` renders "—" with an explanation (e.g. k-anonymity suppression). */
  value: ReactNode;
  hint?: ReactNode;
  /** Optional delta; direction is shown with an arrow icon and a sign, not colour alone. */
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; positive?: boolean };
  /** Shown when value is null. */
  suppressedReason?: string;
  loading?: boolean;
  /** Makes the whole tile a link/button target via a child element. */
  footer?: ReactNode;
  className?: string;
}

/** One figure of a stat row: a label, the number, an optional note. Sits on a hairline, not in a box. */
export function MetricTile({
  label,
  value,
  hint,
  delta,
  suppressedReason = 'Hidden to protect small groups',
  loading = false,
  footer,
  className,
}: MetricTileProps) {
  const DeltaIcon =
    delta?.direction === 'up' ? ArrowUpRight : delta?.direction === 'down' ? ArrowDownRight : Minus;
  return (
    <div
      data-slot="metric-tile"
      className={cn('flex min-w-0 flex-col gap-1.5 border-t border-border pt-4', className)}
    >
      <span className="text-small text-muted-foreground">{label}</span>
      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="tabular text-[28px] leading-8 font-semibold tracking-tight">
            {value === null ? (
              <>
                <span aria-hidden>—</span>
                <span className="sr-only">Not shown. {suppressedReason}</span>
              </>
            ) : (
              value
            )}
          </span>
          {delta ? (
            <span
              className={cn(
                'tabular inline-flex items-center gap-0.5 text-xs font-medium',
                delta.positive === undefined
                  ? 'text-muted-foreground'
                  : delta.positive
                    ? 'text-success'
                    : 'text-destructive',
              )}
            >
              <DeltaIcon aria-hidden className="size-3.5" />
              {delta.value}
            </span>
          ) : null}
        </div>
      )}
      {value === null && !loading ? (
        <p className="text-xs text-muted-foreground">{suppressedReason}</p>
      ) : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {footer ? <div className="mt-auto pt-1">{footer}</div> : null}
    </div>
  );
}
