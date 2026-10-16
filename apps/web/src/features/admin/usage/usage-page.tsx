import { Link, useParams } from '@tanstack/react-router';
import { OctagonAlert, Settings, TriangleAlert } from 'lucide-react';
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
import { capState, describeModel, fillDays, isSpeechModel, purposeLabel } from './usage-model';

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
    (sum, r) => {
      const speech = isSpeechModel(r.modelId);
      return {
        usd: sum.usd + r.usd,
        inputTokens: sum.inputTokens + (speech ? 0 : r.inputTokens),
        outputTokens: sum.outputTokens + (speech ? 0 : r.outputTokens),
      };
    },
    { usd: 0, inputTokens: 0, outputTokens: 0 },
  );
  if (rows.length === 0) {
    return <p className="text-small text-muted-foreground">No model calls in the last 30 days.</p>;
  }
  return (
    <Table>
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
                {isSpeechModel(row.modelId) ? ' chars' : ''}
              </TableCell>
              <TableCell className="tabular text-right" title={formatNumber(row.outputTokens)}>
                {isSpeechModel(row.modelId) ? '—' : formatCompact(row.outputTokens)}
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

function PurposeTable({ usage }: { usage: Usage }) {
  const rows = usage.byPurpose;
  const total = rows.reduce((sum, r) => sum + r.usd, 0);
  if (rows.length === 0) {
    return <p className="text-small text-muted-foreground">No AI spend in the last 30 days.</p>;
  }
  return (
    <Table>
      <TableCaption className="sr-only">Spend by purpose, last 30 days</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Purpose</TableHead>
          <TableHead scope="col" className="text-right">
            Spend
          </TableHead>
          <TableHead scope="col" className="text-right">
            Share
          </TableHead>
          <TableHead scope="col" className="text-right">
            Calls
          </TableHead>
          <TableHead scope="col" className="hidden text-right sm:table-cell">
            Volume
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.purpose}>
            <TableHead scope="row" className="h-auto py-2.5 font-medium text-foreground">
              {purposeLabel(row.purpose)}
            </TableHead>
            <TableCell className="tabular text-right">{formatUsd(row.usd)}</TableCell>
            <TableCell className="tabular text-right">
              {total > 0 ? formatPercent(row.usd / total) : '—'}
            </TableCell>
            <TableCell className="tabular text-right">{formatNumber(row.calls)}</TableCell>
            <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
              {row.purpose === 'speech'
                ? `${formatCompact(row.inputTokens)} chars`
                : `${formatCompact(row.inputTokens)} in · ${formatCompact(row.outputTokens)} out`}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UsageDashboard({ usage }: { usage: Usage }) {
  const [view, setView] = useState<VizView>('chart');
  const points = useMemo(() => fillDays(usage.byDay, 30), [usage.byDay]);
  const turns30 = points.reduce((sum, p) => sum + p.turns, 0);
  const perTurn = turns30 > 0 ? usage.last30DaysUsd / turns30 : null;

  return (
    <div className="grid gap-12">
      <div className="grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        <TodayTile usage={usage} />
        <MetricTile
          label="Last 30 days"
          value={formatUsd(usage.last30DaysUsd)}
          hint={`≈ ${formatUsd(usage.last30DaysUsd / 30)} per day on average`}
        />
        <MetricTile label="Coaching turns (30 days)" value={formatNumber(turns30)} />
        <MetricTile
          label="Average cost per turn"
          value={perTurn === null ? '—' : formatUsd(perTurn, 3)}
          hint="Includes embeddings and fallback calls"
        />
      </div>

      <SectionCard
        title="Daily spend"
        description="Last 30 days (UTC), against the platform’s daily cap"
        actions={<ViewToggle value={view} onChange={setView} label="Daily spend" />}
      >
        <DailySpendChart points={points} capUsd={usage.capGlobalUsd} view={view} />
      </SectionCard>

      <SectionCard title="By purpose" description="Last 30 days">
        <PurposeTable usage={usage} />
      </SectionCard>

      <SectionCard title="By model" description="Last 30 days">
        <ModelTable usage={usage} />
      </SectionCard>
    </div>
  );
}

/** Admin → Usage: AI spend against the daily cap, by day, purpose and model. */
export function UsagePage() {
  const { tenant } = useParams({ from: '/$tenant/app/admin' });
  const usage = useUsage();
  return (
    <PageContainer size="wide">
      <PageHeader
        title="Usage"
        description="AI spend by day, purpose and model."
        actions={
          <Button asChild variant="secondary">
            <Link to="/$tenant/app/admin/settings" params={{ tenant }}>
              <Settings aria-hidden />
              Spend caps
            </Link>
          </Button>
        }
      />
      {usage.isPending ? (
        <LoadingRegion label="Loading usage">
          <div className="grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
          <Skeleton className="mt-12 h-64 rounded-lg" />
        </LoadingRegion>
      ) : usage.isError ? (
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} retrying={usage.isRefetching} />
      ) : (
        <UsageDashboard usage={usage.data} />
      )}
    </PageContainer>
  );
}
