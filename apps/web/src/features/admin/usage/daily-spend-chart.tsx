import { useId, useState, type KeyboardEvent } from 'react';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { VizView } from '@/features/program/viz/view-toggle';
import { formatNumber, formatPercent, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

import { formatDay, niceCeil, type DayPoint } from './usage-model';

interface DailySpendChartProps {
  points: readonly DayPoint[];
  /** Daily platform cap in USD (drawn as a reference line). */
  capUsd: number;
  view: VizView;
}

const PLOT_HEIGHT = 'h-40';

/**
 * Daily AI spend: one series → one accent colour, columns ≤ 24 px with 4 px rounded tops on a
 * single baseline, hairline grid, and the daily cap as a labelled reference line. Hover or
 * keyboard (←/→ on the focused plot) shows the same readout; the table view lists every value.
 */
export function DailySpendChart({ points, capUsd, view }: DailySpendChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const n = points.length;
  const maxUsd = points.reduce((max, p) => Math.max(max, p.usd), 0);
  const scaleMax = niceCeil(Math.max(maxUsd, capUsd) * 1.05);
  const ticks = [0, scaleMax / 2, scaleMax];
  const labelEvery = n > 14 ? 7 : 1;
  const today = new Date().toISOString().slice(0, 10);

  if (view === 'table') {
    return (
      <Table>
        <TableCaption className="px-1 text-left">
          Daily AI spend (UTC days), newest first. Platform cap {formatUsd(capUsd)} per day.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Day</TableHead>
            <TableHead scope="col" className="text-right">
              Spend
            </TableHead>
            <TableHead scope="col" className="text-right">
              Turns
            </TableHead>
            <TableHead scope="col" className="text-right">
              Share of cap
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...points].reverse().map((p) => (
            <TableRow key={p.day}>
              <TableHead scope="row" className="font-normal text-foreground">
                <time dateTime={p.day}>{formatDay(p.day, 'long')}</time>
              </TableHead>
              <TableCell className="tabular text-right">{formatUsd(p.usd)}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(p.turns)}</TableCell>
              <TableCell className="tabular text-right">
                {capUsd > 0 ? formatPercent(p.usd / capUsd) : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  const current = active === null ? null : points[active];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = n - 1;
    let next: number;
    if (event.key === 'ArrowRight') next = active === null ? last : Math.min(last, active + 1);
    else if (event.key === 'ArrowLeft') next = active === null ? last : Math.max(0, active - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Escape') {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
    setActive(next);
  };
  const pct = (usd: number) => `${Math.min(100, (usd / scaleMax) * 100).toFixed(3)}%`;

  return (
    <figure aria-labelledby={titleId} className="grid gap-2">
      <figcaption id={titleId} className="sr-only">
        Daily AI spend for the last {n} days. Use the left and right arrow keys on the chart to read each day,
        or switch to the table view.
      </figcaption>
      <div className="grid grid-cols-[3.25rem_1fr] gap-2">
        {/* Y axis labels */}
        <div aria-hidden className={cn('relative', PLOT_HEIGHT)}>
          {ticks.map((tick) => (
            <span
              key={tick}
              className="tabular absolute right-0 translate-y-1/2 text-[11px] text-muted-foreground"
              style={{ bottom: pct(tick) }}
            >
              {formatUsd(tick, Number.isInteger(tick) ? 0 : 2)}
            </span>
          ))}
        </div>
        <div className="min-w-0">
          <div
            role="group"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={() => {
              setActive(null);
            }}
            onPointerLeave={() => {
              setActive(null);
            }}
            className={cn(
              'relative rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring',
              PLOT_HEIGHT,
            )}
          >
            {/* Hairline grid */}
            {ticks.map((tick) => (
              <span
                key={tick}
                aria-hidden
                className="absolute inset-x-0 h-px bg-border"
                style={{ bottom: pct(tick) }}
              />
            ))}
            {/* Columns */}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {points.map((p, i) => (
                <div
                  key={p.day}
                  aria-hidden
                  data-active={active === i || undefined}
                  className="flex h-full min-w-0 flex-1 items-end justify-center rounded-sm data-[active]:bg-accent/60"
                  onPointerEnter={() => {
                    setActive(i);
                  }}
                >
                  {p.usd > 0 ? (
                    <span
                      data-slot="bar"
                      className={cn(
                        'block w-full max-w-6 rounded-t-[4px] bg-chart-2 transition-opacity',
                        active !== null && active !== i && 'opacity-60',
                      )}
                      style={{ height: pct(p.usd), minHeight: '2px' }}
                    />
                  ) : null}
                </div>
              ))}
            </div>
            {/* Daily cap reference line (dashed = threshold, labelled) */}
            {capUsd > 0 ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0"
                style={{ bottom: pct(capUsd) }}
              >
                <span className="block border-t border-dashed border-foreground/60" />
                <span className="absolute right-0 bottom-1 rounded-sm bg-card px-1 text-[11px] font-medium text-foreground">
                  Daily cap {formatUsd(capUsd)}
                </span>
              </div>
            ) : null}
            {/* Readout (hover / keyboard) */}
            {current && active !== null ? (
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md',
                  active > n / 2 ? '-translate-x-full' : '',
                )}
                style={{ left: `${((active + (active > n / 2 ? 0 : 1)) / n) * 100}%` }}
              >
                <p className="tabular text-sm font-semibold text-foreground">{formatUsd(current.usd)}</p>
                <p className="text-muted-foreground">{formatDay(current.day, 'long')}</p>
                <p className="tabular text-muted-foreground">{formatNumber(current.turns)} turns</p>
              </div>
            ) : null}
          </div>
          {/* X axis labels: every 7th day counted back from today, so today is always labelled */}
          <div aria-hidden className="relative mt-1.5 h-4">
            {points.map((p, i) =>
              (n - 1 - i) % labelEvery === 0 ? (
                <span
                  key={p.day}
                  className="absolute -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground"
                  style={{ left: `${((i + 0.5) / n) * 100}%` }}
                >
                  {p.day === today ? 'Today' : formatDay(p.day)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {current
          ? `${formatDay(current.day, 'long')}: ${formatUsd(current.usd)}, ${current.turns} turns`
          : ''}
      </p>
    </figure>
  );
}
