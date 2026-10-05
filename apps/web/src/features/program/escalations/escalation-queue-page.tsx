import { EscalationPriority } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { CircleAlert, Eye, EyeOff, Flag, Hand, Inbox, Lock, Send } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  SortableTableHead,
  sortRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type SortState,
} from '@/components/ui/table';
import { shortId } from '@/features/admin/shared/form';
import { useProgramEscalations, type EscalationQueueEntry } from '@/lib/api/hooks/program';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate, formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { useAssigneeOptions } from './assignees';
import { RouteEscalationDialog } from './route-escalation-dialog';
import { isOpenEscalation, isOverdue, isRoutable, PRIORITY_RANK } from './status';

type StatusFilter = 'open' | 'awaiting_assignment' | 'closed' | 'all';
type SortKey = 'priority' | 'due' | 'created' | 'venture';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'awaiting_assignment', label: 'Waiting for assignment' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

function matches(entry: EscalationQueueEntry, filter: StatusFilter): boolean {
  switch (filter) {
    case 'open':
      return isOpenEscalation(entry);
    case 'awaiting_assignment':
      return entry.status === 'awaiting_assignment';
    case 'closed':
      return !isOpenEscalation(entry);
    case 'all':
      return true;
  }
}

/**
 * Program console → Escalation queue. Program staff see metadata only (category, priority, status,
 * venture, due date, assignee). Packet contents reach only the assignee, and only after the founder
 * approves sharing — this page never requests them.
 */
export function EscalationQueuePage() {
  const me = useRequiredMe();
  const tenant = me.tenant.slug;
  const queue = useProgramEscalations();
  const assignees = useAssigneeOptions(me);
  const [status, setStatus] = useState<StatusFilter>('open');
  const [priority, setPriority] = useState<string>('all');
  const [sort, setSort] = useState<SortState<SortKey> | null>({ key: 'priority', direction: 'asc' });
  const [routing, setRouting] = useState<EscalationQueueEntry | null>(null);

  const all = useMemo(() => queue.data ?? [], [queue.data]);
  const names = useMemo(() => new Map(assignees.options.map((o) => [o.id, o.name])), [assignees.options]);

  const rows = useMemo(() => {
    const filtered = all.filter((e) => matches(e, status) && (priority === 'all' || e.priority === priority));
    return sortRows(filtered, sort, (e, key) => {
      switch (key) {
        case 'priority':
          return (PRIORITY_RANK[e.priority] ?? 9) * 1e13 + Date.parse(e.createdAt) / 1e3;
        case 'due':
          return e.dueAt ? Date.parse(e.dueAt) : null;
        case 'created':
          return Date.parse(e.createdAt);
        case 'venture':
          return e.ventureName;
      }
    });
  }, [all, status, priority, sort]);

  const openCount = all.filter(isOpenEscalation).length;
  const waitingCount = all.filter((e) => e.status === 'awaiting_assignment').length;
  const overdueCount = all.filter((e) => isOverdue(e)).length;

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Escalation queue"
        description="Route human handoffs to the right person. You see metadata only — packets go to the assignee once the founder approves sharing."
        actions={
          <Button asChild variant="secondary">
            <Link to="/$tenant/app/eir/inbox" params={{ tenant }}>
              <Inbox aria-hidden />
              My inbox
            </Link>
          </Button>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={status}
            onValueChange={(value) => {
              const match = STATUS_FILTERS.find((f) => f.value === value);
              if (match) setStatus(match.value);
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="w-full sm:w-44" aria-label="Filter by priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              {EscalationPriority.options.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[13px] text-muted-foreground sm:ml-auto" aria-live="polite">
            {queue.isSuccess
              ? `${formatNumber(openCount)} open · ${formatNumber(waitingCount)} waiting for assignment · ${formatNumber(overdueCount)} overdue`
              : null}
          </p>
        </div>
      </PageHeader>

      {queue.isPending ? (
        <LoadingRegion label="Loading escalation queue">
          <Skeleton className="h-72 rounded-xl" />
        </LoadingRegion>
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} retrying={queue.isRefetching} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Flag}
          title={all.length === 0 ? 'No escalations yet' : 'Nothing matches these filters'}
          description={
            all.length === 0
              ? 'When Foundry Guide or a founder asks for a human, the escalation appears here for routing.'
              : 'Try another status or priority.'
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="priority" sort={sort} onSortChange={setSort}>
                Priority · status
              </SortableTableHead>
              <TableHead>Topic</TableHead>
              <SortableTableHead sortKey="venture" sort={sort} onSortChange={setSort}>
                Venture
              </SortableTableHead>
              <TableHead>Assignee</TableHead>
              <SortableTableHead sortKey="due" sort={sort} onSortChange={setSort}>
                Due
              </SortableTableHead>
              <TableHead>Packet</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => {
              const overdue = isOverdue(e);
              const open = isOpenEscalation(e);
              const routable = isRoutable(e);
              const assigneeName = e.assigneeId ? names.get(e.assigneeId) : undefined;
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <div className="grid gap-1">
                      <StatusBadge kind="escalationPriority" status={e.priority} withTitle />
                      <StatusBadge kind="escalationStatus" status={e.status} withTitle />
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="block whitespace-nowrap">{ESCALATION_CATEGORY_LABELS[e.category]}</span>
                    <span className="block text-xs whitespace-nowrap text-muted-foreground">
                      for {REQUESTED_ROLE_LABELS[e.requestedRole] ?? e.requestedRole}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-36">
                    <span className="block font-medium">{e.ventureName}</span>
                    <span className="block text-xs whitespace-nowrap text-muted-foreground">
                      Raised{' '}
                      <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>
                        {formatRelative(e.createdAt)}
                      </time>
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {e.assigneeId === null ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <CircleAlert aria-hidden className="size-3.5" />
                        Unassigned
                      </span>
                    ) : (
                      (assigneeName ?? (
                        <span className="text-muted-foreground" title={e.assigneeId}>
                          Assigned · {shortId(e.assigneeId, 6)}
                        </span>
                      ))
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {e.dueAt ? (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1',
                          overdue && 'font-medium text-destructive',
                        )}
                      >
                        {overdue ? <CircleAlert aria-hidden className="size-3.5" /> : null}
                        <time dateTime={e.dueAt} title={formatDateTime(e.dueAt)}>
                          {overdue ? `Overdue · ${formatRelative(e.dueAt)}` : formatDate(e.dueAt)}
                        </time>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-[13px]">
                    {e.shared ? (
                      <span className="inline-flex items-center gap-1">
                        <Eye aria-hidden className="size-3.5" />
                        Shared
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <EyeOff aria-hidden className="size-3.5" />
                        Metadata only
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {routable ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`${e.assigneeId ? 'Reassign' : 'Route'} ${e.priority} escalation for ${e.ventureName}`}
                        onClick={() => {
                          setRouting(e);
                        }}
                      >
                        <Send aria-hidden />
                        {e.assigneeId ? 'Reassign' : 'Route'}
                      </Button>
                    ) : open ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Hand aria-hidden className="size-3" />
                        Waiting for the founder
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock aria-hidden className="size-3" />
                        Closed
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <RouteEscalationDialog
        escalation={routing}
        options={assignees.options}
        optionsState={assignees.isLoading ? 'loading' : assignees.isError ? 'error' : 'ready'}
        onClose={() => {
          setRouting(null);
        }}
      />
    </PageContainer>
  );
}
