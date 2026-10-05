import { EyeOff, Info } from 'lucide-react';

import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

import {
  formatAggregate,
  kAnonymityExplanation,
  suppressedLabel,
  visibleTotal,
  type AggregateDatum,
} from './k-anonymity';
import type { VizView } from './view-toggle';

interface AggregateBarChartProps {
  rows: readonly AggregateDatum[];
  /** Minimum group size (k). Suppressed rows render as "Fewer than k". */
  k: number;
  /** Accessible name of the chart, e.g. "Ventures by stage". */
  label: string;
  /** Column header for the category in the table view. */
  categoryHeader: string;
  /** Column header for the count in the table view, e.g. "Ventures". */
  valueHeader: string;
  /** Plural noun used in the k-anonymity explanation, e.g. "ventures". */
  unit: string;
  view: VizView;
  className?: string;
}

/** Room reserved after each bar for its direct label ("12" or "Fewer than 3" + info button). */
const LABEL_RESERVE = '8.5rem';

/**
 * Horizontal bar list for k-anonymous aggregates (one series → one accent colour, direct labels at
 * the bar tip, no legend). A suppressed group is drawn as a dashed, unfilled outline spanning the
 * possible range (up to k−1) and labelled "Fewer than k" — it never shows a number. The table view
 * is the accessible equivalent and carries the same wording.
 */
export function AggregateBarChart({
  rows,
  k,
  label,
  categoryHeader,
  valueHeader,
  unit,
  view,
  className,
}: AggregateBarChartProps) {
  const hasSuppressed = rows.some((row) => row.value === null);
  const explanation = kAnonymityExplanation(k, unit);

  if (view === 'table') {
    const { total, partial } = visibleTotal(rows);
    return (
      <div className={className}>
        <Table>
          {hasSuppressed ? <TableCaption className="px-1 text-left">{explanation}</TableCaption> : null}
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{categoryHeader}</TableHead>
              <TableHead scope="col" className="text-right">
                {valueHeader}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableHead
                  scope="row"
                  className="h-auto py-2.5 font-normal whitespace-normal text-foreground"
                >
                  {row.label}
                </TableHead>
                <TableCell
                  className={cn('tabular text-right', row.value === null && 'text-muted-foreground')}
                  data-suppressed={row.value === null || undefined}
                >
                  {formatAggregate(row.value, k)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableHead scope="row" className="font-medium text-foreground">
                {partial ? 'Total shown' : 'Total'}
              </TableHead>
              <TableCell className="tabular text-right">
                {partial ? `At least ${formatNumber(total)}` : formatNumber(total)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    );
  }

  const max = Math.max(1, hasSuppressed ? k - 1 : 0, ...rows.map((row) => row.value ?? 0));

  return (
    <figure className={cn('grid gap-3', className)}>
      <ul aria-label={label} className="grid gap-1">
        {rows.map((row) => {
          const ratio = Math.max(0, Math.min(1, (row.value ?? k - 1) / max)).toFixed(4);
          const width = `calc((100% - ${LABEL_RESERVE}) * ${ratio})`;
          return (
            <li
              key={row.key}
              data-suppressed={row.value === null || undefined}
              className="grid gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-accent/40 sm:grid-cols-[minmax(7rem,11rem)_1fr] sm:items-center sm:gap-3"
            >
              <span className="truncate text-[13px] text-muted-foreground" title={row.label}>
                {row.label}
                <span className="sr-only">:</span>
              </span>
              <span className="flex min-w-0 items-center gap-2 border-l border-border-strong pl-px">
                {row.value === null ? (
                  <>
                    <span
                      aria-hidden
                      data-slot="bar"
                      data-ratio={ratio}
                      className="h-3 shrink-0 rounded-r-[4px] border border-l-0 border-dashed border-border-strong"
                      style={{ width }}
                    />
                    <span className="inline-flex items-center gap-1 text-[13px] whitespace-nowrap text-muted-foreground">
                      <EyeOff aria-hidden className="size-3.5" />
                      {suppressedLabel(k)}
                    </span>
                    <SimpleTooltip content={explanation}>
                      <button
                        type="button"
                        aria-label={`Why is ${row.label} hidden?`}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Info aria-hidden className="size-3.5" />
                      </button>
                    </SimpleTooltip>
                  </>
                ) : (
                  <>
                    <span
                      aria-hidden
                      data-slot="bar"
                      data-ratio={ratio}
                      className={cn('h-3 shrink-0 rounded-r-[4px] bg-chart-2', row.value === 0 && 'w-px')}
                      style={row.value === 0 ? undefined : { width }}
                    />
                    <span className="text-[13px] font-medium text-foreground">{formatNumber(row.value)}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {hasSuppressed ? (
        <figcaption className="flex items-start gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[13px] text-muted-foreground">
          <EyeOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {explanation} The dashed outline marks the possible range (up to {k - 1}), not a value.
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
}
