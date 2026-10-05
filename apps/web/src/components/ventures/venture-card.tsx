import type { VentureSummary } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Brain, Clock, ListChecks, Siren } from 'lucide-react';

import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { StageChip } from '@/components/ui/stage-chip';
import { StatusBadge } from '@/components/ui/status-badge';
import { ROLE_LABELS } from '@/lib/auth/roles';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { DOMAIN_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

function Count({
  icon: Icon,
  value,
  label,
  tone = 'neutral',
}: {
  icon: typeof Brain;
  value: number;
  label: string;
  /** Highlight non-zero counts that need attention (text + weight, not colour alone). */
  tone?: 'neutral' | 'attention';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap',
        tone === 'attention' && value > 0 ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden className={cn('size-3.5', tone === 'attention' && value > 0 && 'text-warning')} />
      <span className="tabular">{value}</span>
      <span>{label}</span>
    </span>
  );
}

/** Venture summary card. The whole card is one link to the venture overview. */
export function VentureCard({ venture, tenant }: { venture: VentureSummary; tenant: string }) {
  return (
    <Link
      to="/$tenant/app/ventures/$ventureId/overview"
      params={{ tenant, ventureId: venture.id }}
      className={cn(
        'group flex h-full flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm transition-[border-color,box-shadow]',
        'hover:border-border-strong hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar name={venture.name} shape="square" size="lg" decorative />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold tracking-tight group-hover:underline group-hover:decoration-border-strong group-hover:underline-offset-4">
            {venture.name}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {DOMAIN_LABELS[venture.domain] ?? venture.domain}
            {venture.myRole ? ` · ${ROLE_LABELS[venture.myRole]}` : ''}
          </p>
        </div>
        {venture.status !== 'active' ? <StatusBadge kind="venture" status={venture.status} /> : null}
      </div>
      <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {venture.oneLiner || 'No one-liner yet.'}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <StageChip stage={venture.stage} />
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock aria-hidden className="size-3.5" />
          {venture.lastSessionAt ? (
            <time dateTime={isoString(venture.lastSessionAt)} title={formatDateTime(venture.lastSessionAt)}>
              {formatRelative(venture.lastSessionAt)}
            </time>
          ) : (
            'No sessions yet'
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
        <Count icon={Brain} value={venture.pendingMemory} label="to review" tone="attention" />
        <Count
          icon={Siren}
          value={venture.openEscalations}
          label={venture.openEscalations === 1 ? 'escalation' : 'escalations'}
          tone="attention"
        />
        <Count
          icon={ListChecks}
          value={venture.openActions}
          label={venture.openActions === 1 ? 'action' : 'actions'}
        />
      </div>
    </Link>
  );
}

export function VentureCardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-md" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="mt-2 h-5 w-24" />
    </div>
  );
}
