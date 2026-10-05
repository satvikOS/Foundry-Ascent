import type { EscalationCategory, PortfolioSummary } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  ArrowRight,
  FlaskConical,
  Gavel,
  Layers,
  MessagesSquare,
  ShieldCheck,
  Siren,
  Star,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { MetricTile } from '@/components/ui/metric-tile';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatNumber } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';

import { AggregateBarChart } from './viz/aggregate-bar-chart';
import { toAggregateRows } from './viz/k-anonymity';
import { ViewToggle, type VizView } from './viz/view-toggle';

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

function stageLabel(key: string): string {
  return (STAGE_LABELS as Record<string, string | undefined>)[key] ?? key;
}

function categoryLabel(key: string): string {
  return (ESCALATION_CATEGORY_LABELS as Record<string, string | undefined>)[key as EscalationCategory] ?? key;
}

/**
 * Program portfolio: k-anonymous aggregates only (system-design §4.2 — no raw transcripts, memory or
 * venture names). Suppressed groups (null) are rendered as "fewer than k", never as numbers.
 */
export function PortfolioDashboard({ summary, tenant }: { summary: PortfolioSummary; tenant: string }) {
  const k = summary.minGroupSize;
  const [stageView, setStageView] = useState<VizView>('chart');
  const [categoryView, setCategoryView] = useState<VizView>('chart');

  const stageRows = toAggregateRows(summary.venturesByStage, stageLabel, STAGE_ORDER);
  const categoryRows = toAggregateRows(summary.escalationsByCategory, categoryLabel);
  const openTotal = PRIORITIES.reduce((sum, p) => sum + (summary.openEscalationsByPriority[p] ?? 0), 0);

  return (
    <div className="grid gap-6">
      <div
        role="note"
        className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground"
      >
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
        <p>
          <span className="font-medium text-foreground">Aggregates only. </span>
          You see counts across the portfolio, never transcripts, memory or documents. Groups smaller than k ={' '}
          {k} are hidden so no venture can be singled out.
        </p>
      </div>

      <section aria-labelledby="portfolio-30d" className="grid gap-3">
        <h2 id="portfolio-30d" className="text-sm font-semibold tracking-tight">
          Last 30 days
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricTile
            label="Active ventures"
            value={formatNumber(summary.activeVentures30d)}
            icon={Activity}
          />
          <MetricTile
            label="Coaching sessions"
            value={formatNumber(summary.sessions30d)}
            icon={MessagesSquare}
          />
          <MetricTile
            label="Confirmed decisions"
            value={formatNumber(summary.confirmedDecisions30d)}
            icon={Gavel}
          />
          <MetricTile
            label="Experiments completed"
            value={formatNumber(summary.experimentsCompleted30d)}
            icon={FlaskConical}
          />
          <MetricTile
            label="Median founder rating"
            value={
              summary.medianFeedbackRating30d === null ? null : (
                <>
                  {summary.medianFeedbackRating30d.toFixed(1)}
                  <span className="text-base font-medium text-muted-foreground"> / 5</span>
                </>
              )
            }
            icon={Star}
            suppressedReason={`Not enough ratings to show without identifying anyone (needs at least ${k}).`}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Ventures by stage"
          description="Enrolled ventures in each stage"
          icon={Layers}
          actions={<ViewToggle value={stageView} onChange={setStageView} label="Ventures by stage" />}
        >
          {stageRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ventures enrolled yet.</p>
          ) : (
            <AggregateBarChart
              rows={stageRows}
              k={k}
              label="Ventures by stage"
              categoryHeader="Stage"
              valueHeader="Ventures"
              unit="ventures"
              view={stageView}
            />
          )}
        </SectionCard>

        <SectionCard
          title="Escalations by category"
          description="Human handoffs requested, by topic"
          icon={Siren}
          actions={
            <ViewToggle value={categoryView} onChange={setCategoryView} label="Escalations by category" />
          }
        >
          {categoryRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No escalations in this period.</p>
          ) : (
            <AggregateBarChart
              rows={categoryRows}
              k={k}
              label="Escalations by category"
              categoryHeader="Category"
              valueHeader="Escalations"
              unit="escalations"
              view={categoryView}
            />
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Open escalations by priority"
        description={`${formatNumber(openTotal)} open across the portfolio`}
        icon={Siren}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/$tenant/app/program/escalations" params={{ tenant }}>
              Escalation queue
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PRIORITIES.map((priority) => (
            <div key={priority} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
              <dt>
                <StatusBadge kind="escalationPriority" status={priority} withTitle />
              </dt>
              <dd className="text-2xl leading-8 font-semibold tracking-tight">
                {formatNumber(summary.openEscalationsByPriority[priority] ?? 0)}
                <span className="sr-only"> open</span>
              </dd>
            </div>
          ))}
        </dl>
      </SectionCard>
    </div>
  );
}
