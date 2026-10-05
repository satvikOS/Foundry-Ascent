import { Link } from '@tanstack/react-router';
import {
  CalendarDays,
  CircleAlert,
  Coins,
  Cpu,
  MessagesSquare,
  OctagonAlert,
  Settings,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { MetricTile } from '@/components/ui/metric-tile';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { SectionCard } from '@/components/ui/section-card';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
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
import { ViewToggle, type VizView } from '@/features/program/viz/view-toggle';
import { useUsage, type Usage } from '@/lib/api/hooks/admin';
import { formatCompact, formatNumber, formatPercent, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

import { DailySpendChart } from './daily-spend-chart';
import { capState, describeModel, fillDays } from './usage-model';

const CAP_COPY = {
  ok: null,
  approaching: { icon: TriangleAlert, text: 'Approaching today’s cap', className: 'text-warning' },
  reached: {
    icon: OctagonAlert,
    text: 'Cap reached — new turns are refused until tomorrow (UTC)',
    className: 'text-destructive',
  },
} as const;

function TodayTile({ usage }: { usage: Usage }) {
  const state = capState(usage.todayUsd, usage.capGlobalUsd);
  const ratio = usage.capGlobalUsd > 0 ? usage.todayUsd / usage.capGlobalUsd : 0;
  const copy = CAP_COPY[state];
  return (
    <MetricTile
      label="Spend today (UTC)"
      value={formatUsd(usage.todayUsd)}
      icon={Coins}
      hint={`of ${formatUsd(usage.capGlobalUsd)} daily cap · ${formatPercent(ratio)}`}
      footer={
        <div className="grid gap-1.5">
          <Progress
            value={Math.min(100, ratio * 100)}
            label="Today’s spend as a share of the daily cap"
            indicatorClassName={cn(
              state === 'ok' && 'bg-chart-2',
              state === 'approaching' && 'bg-warning',
              state === 'reached' && 'bg-destructive',
            )}
          />
          {copy ? (
            <p className={cn('flex items-center gap-1 text-xs font-medium', copy.className)}>
              <copy.icon aria-hidden className="size-3.5" />
              {copy.text}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

function ModelTable({ usage }: { usage: Usage }) {
  const rows = [...usage.byModel].sort((a, b) => b.usd - a.usd);
  const total = rows.reduce(
    (sum, r) => ({
      usd: sum.usd + r.usd,
      inputTokens: sum.inputTokens + r.inputTokens,
      outputTokens: sum.outputTokens + r.outputTokens,
    }),
    { usd: 0, inputTokens: 0, outputTokens: 0 },
  );
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No model calls in the last 30 days.</p>;
  }
  return (
    <Table containerClassName="rounded-none border-0">
      <TableCaption className="sr-only">Spend and tokens by model, last 30 days</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Model</TableHead>
          <TableHead scope="col" className="text-right">
            Spend
          </TableHead>
          <TableHead scope="col" className="text-right">
            Share
          </TableHead>
          <TableHead scope="col" className="text-right">
            Input tokens
          </TableHead>
          <TableHead scope="col" className="text-right">
            Output tokens
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const model = describeModel(row.modelId);
          return (
            <TableRow key={row.modelId}>
              <TableHead scope="row" className="h-auto py-2.5 font-normal text-foreground">
                <span className="block font-medium">{model.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {model.role} · <code className="font-mono">{row.modelId}</code>
                </span>
              </TableHead>
              <TableCell className="tabular text-right">{formatUsd(row.usd)}</TableCell>
              <TableCell className="tabular text-right">
                {total.usd > 0 ? formatPercent(row.usd / total.usd) : '—'}
              </TableCell>
              <TableCell className="tabular text-right" title={formatNumber(row.inputTokens)}>
                {formatCompact(row.inputTokens)}
              </TableCell>
              <TableCell className="tabular text-right" title={formatNumber(row.outputTokens)}>
                {formatCompact(row.outputTokens)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead scope="row" className="font-medium text-foreground">
            Total
          </TableHead>
          <TableCell className="tabular text-right">{formatUsd(total.usd)}</TableCell>
          <TableCell className="tabular text-right">100%</TableCell>
          <TableCell className="tabular text-right">{formatCompact(total.inputTokens)}</TableCell>
          <TableCell className="tabular text-right">{formatCompact(total.outputTokens)}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function UsageDashboard({ usage }: { usage: Usage }) {
  const [view, setView] = useState<VizView>('chart');
  const points = useMemo(() => fillDays(usage.byDay, 30), [usage.byDay]);
  const turns30 = points.reduce((sum, p) => sum + p.turns, 0);
  const perTurn = turns30 > 0 ? usage.last30DaysUsd / turns30 : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TodayTile usage={usage} />
        <MetricTile
          label="Last 30 days"
          value={formatUsd(usage.last30DaysUsd)}
          icon={CalendarDays}
          hint={`≈ ${formatUsd(usage.last30DaysUsd / 30)} per day on average`}
        />
        <MetricTile label="Coaching turns (30 days)" value={formatNumber(turns30)} icon={MessagesSquare} />
        <MetricTile
          label="Average cost per turn"
          value={perTurn === null ? '—' : formatUsd(perTurn, 3)}
          icon={Cpu}
          hint="Includes embeddings and fallback calls"
        />
      </div>

      <SectionCard
        title="Daily spend"
        description="Last 30 days (UTC), against the platform’s daily cap"
        icon={Coins}
        actions={<ViewToggle value={view} onChange={setView} label="Daily spend" />}
      >
        <DailySpendChart points={points} capUsd={usage.capGlobalUsd} view={view} />
      </SectionCard>

      <SectionCard title="By model" description="Last 30 days" icon={Cpu} flush>
        <ModelTable usage={usage} />
      </SectionCard>
    </div>
  );
}

/** Admin → Usage: AI spend against the daily cap, by day and by model. */
export function UsagePage() {
  const usage = useUsage();
  return (
    <PageContainer size="wide">
      <PageHeader
        title="Usage"
        description="AI spend from the usage ledger. Every model call is recorded with its cost."
        actions={
          <Button asChild variant="secondary">
            <Link to="/admin/settings">
              <Settings aria-hidden />
              Spend caps
            </Link>
          </Button>
        }
      />
      {usage.isPending ? (
        <LoadingRegion label="Loading usage">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[120px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="mt-6 h-64 rounded-xl" />
        </LoadingRegion>
      ) : usage.isError ? (
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} retrying={usage.isRefetching} />
      ) : usage.data.byDay.length === 0 && usage.data.last30DaysUsd === 0 ? (
        <div className="grid gap-6">
          <UsageDashboard usage={usage.data} />
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <CircleAlert aria-hidden className="size-3.5" />
            No AI usage recorded yet.
          </p>
        </div>
      ) : (
        <UsageDashboard usage={usage.data} />
      )}
    </PageContainer>
  );
}
