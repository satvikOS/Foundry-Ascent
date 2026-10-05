import type { EscalationView } from '@foundry/contracts';
import { CircleAlert, CircleCheck, Inbox } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isOpenEscalation, isOverdue, PRIORITY_RANK } from '@/features/program/escalations/status';
import { useInboxEscalations } from '@/lib/api/hooks/escalations';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { EscalationPacketView } from './escalation-packet';
import { InboxActions } from './inbox-actions';

export type InboxFilter = 'open' | 'closed';

function byUrgency(a: EscalationView, b: EscalationView): number {
  const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (rank !== 0) return rank;
  const due = (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
  if (due !== 0 && !Number.isNaN(due)) return due;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

interface InboxPageProps {
  selectedId: string | undefined;
  filter: InboxFilter;
  onSelect: (id: string | undefined) => void;
  onFilterChange: (filter: InboxFilter) => void;
}

function DueLabel({ escalation }: { escalation: EscalationView }) {
  if (!escalation.dueAt) return null;
  const overdue = isOverdue(escalation);
  return (
    <span className={cn('inline-flex items-center gap-1', overdue && 'font-medium text-destructive')}>
      {overdue ? <CircleAlert aria-hidden className="size-3.5" /> : null}
      <time dateTime={escalation.dueAt} title={formatDateTime(escalation.dueAt)}>
        {overdue
          ? `Overdue · due ${formatRelative(escalation.dueAt)}`
          : `Due ${formatDate(escalation.dueAt)}`}
      </time>
    </span>
  );
}

/** EIR studio → Inbox: escalations assigned to me, with the shared packet and assignee actions. */
export function InboxPage({ selectedId, filter, onSelect, onFilterChange }: InboxPageProps) {
  const inbox = useInboxEscalations();
  const detailRef = useRef<HTMLDivElement | null>(null);
  const all = useMemo(() => [...(inbox.data ?? [])].sort(byUrgency), [inbox.data]);
  const open = all.filter(isOpenEscalation);
  const closed = all.filter((e) => !isOpenEscalation(e));
  const visible = filter === 'open' ? open : closed;
  const selected = all.find((e) => e.id === selectedId) ?? visible[0];

  useEffect(() => {
    if (inbox.isSuccess && selectedId && !all.some((e) => e.id === selectedId)) onSelect(undefined);
  }, [inbox.isSuccess, all, selectedId, onSelect]);

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Escalation inbox"
        description="Human handoffs routed to you. Packet details are visible only after the founder approves sharing."
      >
        <Tabs
          value={filter}
          onValueChange={(value) => {
            onFilterChange(value === 'closed' ? 'closed' : 'open');
          }}
        >
          <TabsList aria-label="Inbox">
            <TabsTrigger value="open">
              <Inbox aria-hidden />
              Open <span className="tabular text-muted-foreground">{inbox.isSuccess ? open.length : ''}</span>
            </TabsTrigger>
            <TabsTrigger value="closed">
              <CircleCheck aria-hidden />
              Closed{' '}
              <span className="tabular text-muted-foreground">{inbox.isSuccess ? closed.length : ''}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {inbox.isPending ? (
        <LoadingRegion label="Loading inbox">
          <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-96 rounded-xl" />
          </div>
        </LoadingRegion>
      ) : inbox.isError ? (
        <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} retrying={inbox.isRefetching} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing routed to you"
          description="When a program lead routes an escalation to you, it appears here."
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[20rem_1fr]">
          <nav aria-label={filter === 'open' ? 'Open escalations' : 'Closed escalations'}>
            {visible.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted-foreground">
                {filter === 'open' ? 'No open escalations. Nice work.' : 'No closed escalations yet.'}
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {visible.map((e) => {
                  const isSelected = e === selected;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={() => {
                          onSelect(e.id);
                          requestAnimationFrame(() => {
                            detailRef.current?.focus();
                          });
                        }}
                        className={cn(
                          'grid w-full gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
                          'hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-ring',
                          isSelected ? 'border-foreground bg-accent' : 'border-border bg-card',
                        )}
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge kind="escalationPriority" status={e.priority} />
                          <StatusBadge kind="escalationStatus" status={e.status} />
                        </span>
                        <span className="text-sm font-medium">{e.ventureName}</span>
                        <span className="text-[13px] text-muted-foreground">
                          {ESCALATION_CATEGORY_LABELS[e.category]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {e.dueAt ? <DueLabel escalation={e} /> : `Raised ${formatRelative(e.createdAt)}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>

          {selected ? (
            <div ref={detailRef} tabIndex={-1} className="outline-none">
              <SectionCard
                title={`${selected.ventureName} · ${ESCALATION_CATEGORY_LABELS[selected.category]}`}
                description={`Raised ${formatDateTime(selected.createdAt)} by ${selected.createdBy.displayName} · requested: ${
                  REQUESTED_ROLE_LABELS[selected.requestedRole] ?? selected.requestedRole
                }`}
                actions={
                  <StatusBadge kind="escalationPriority" status={selected.priority} size="md" withTitle />
                }
              >
                <div className="grid gap-5">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <StatusBadge kind="escalationStatus" status={selected.status} withTitle />
                    <DueLabel escalation={selected} />
                    {selected.sessionId ? <Badge variant="muted">From a coaching session</Badge> : null}
                  </div>
                  <InboxActions key={selected.id} escalation={selected} />
                  <EscalationPacketView escalation={selected} />
                  {selected.resolution ? (
                    <section className="grid gap-2 rounded-lg border border-border px-4 py-3">
                      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                        <CircleCheck aria-hidden className="size-4 text-muted-foreground" />
                        Resolution
                      </h3>
                      <p className="text-sm whitespace-pre-wrap">{selected.resolution.summary}</p>
                      {selected.resolution.nextSteps.length > 0 ? (
                        <ul className="grid list-disc gap-1 pl-5 text-sm">
                          {selected.resolution.nextSteps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              </SectionCard>
            </div>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
