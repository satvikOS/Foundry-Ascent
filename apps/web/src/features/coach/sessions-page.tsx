import type { CoachMode, SessionView } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
import { EyeOff, FileCheck2, MessagesSquare, Minus, Play } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
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
import { useSessions } from '@/lib/api/hooks/sessions';
import { useVenture } from '@/lib/api/hooks/ventures';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { MODE_LABELS } from '@/lib/labels';

import { SegmentedControl } from '@/features/venture/segmented-control';

import { coachingAvailability } from './availability';
import { ModeBadge } from './modes';
import { StartSessionDialog } from './start-session-dialog';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/coach/');

type Filter = 'all' | 'active' | 'ended';
type SortKey = 'started' | 'mode' | 'turns';

export function sessionTitle(session: Pick<SessionView, 'goal' | 'mode'>): string {
  const goal = session.goal?.trim();
  if (goal) return goal;
  return `${MODE_LABELS[session.mode].label} session`;
}

function sortValue(session: SessionView, key: SortKey): string | number {
  switch (key) {
    case 'started':
      return Date.parse(session.startedAt);
    case 'mode':
      return MODE_LABELS[session.mode].label;
    case 'turns':
      return session.turnCount;
  }
}

export function SessionsPage() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const venture = useVenture(ventureId);
  const sessions = useSessions(ventureId);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortState<SortKey> | null>({ key: 'started', direction: 'desc' });
  const availability = venture.data ? coachingAvailability(me, venture.data) : null;
  const startOpen = search.start !== undefined;

  const setStart = (mode: CoachMode | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, start: mode }), replace: true });

  const rows = useMemo(() => {
    const items = (sessions.data ?? []).filter((s) =>
      filter === 'all' ? true : filter === 'active' ? s.status !== 'ended' : s.status === 'ended',
    );
    return sortRows(items, sort, sortValue);
  }, [sessions.data, filter, sort]);

  const counts = useMemo(() => {
    const items = sessions.data ?? [];
    return {
      all: items.length,
      active: items.filter((s) => s.status !== 'ended').length,
      ended: items.filter((s) => s.status === 'ended').length,
    };
  }, [sessions.data]);

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Coach"
        description="Sessions with Foundry Guide. Every answer cites its evidence and labels what is fact, inference, hypothesis or recommendation."
        actions={
          availability?.available ? (
            <Button
              onClick={() => {
                setStart('diagnose');
              }}
            >
              <Play aria-hidden />
              Start a session
            </Button>
          ) : null
        }
      />
      <DisclosureBanner variant="inline" className="mb-5" />
      {availability && !availability.available ? (
        <Alert variant="warning" title={availability.title} className="mb-5">
          {availability.reason}
        </Alert>
      ) : null}

      <SegmentedControl
        label="Filter sessions"
        value={filter}
        onChange={setFilter}
        className="mb-4"
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'active', label: 'Active', count: counts.active },
          { value: 'ended', label: 'Ended', count: counts.ended },
        ]}
      />

      {sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : sessions.isPending ? (
        <div aria-busy="true" className="overflow-hidden rounded-xl border border-border bg-card">
          <span className="sr-only" role="status">
            Loading sessions…
          </span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={filter === 'all' ? 'No sessions yet' : `No ${filter} sessions`}
          description={
            filter === 'all'
              ? 'Start with Diagnose: Foundry Guide will help you find the constraint that matters most right now.'
              : 'Switch the filter to see other sessions.'
          }
          action={
            filter === 'all' && availability?.available ? (
              <Button
                size="sm"
                onClick={() => {
                  setStart('diagnose');
                }}
              >
                <Play aria-hidden />
                Start a session
              </Button>
            ) : null
          }
        />
      ) : (
        <Table aria-label="Coaching sessions">
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <SortableTableHead sortKey="mode" sort={sort} onSortChange={setSort}>
                Mode
              </SortableTableHead>
              <TableHead>Status</TableHead>
              <SortableTableHead sortKey="turns" sort={sort} onSortChange={setSort} align="right">
                Turns
              </SortableTableHead>
              <TableHead>Recap</TableHead>
              <SortableTableHead sortKey="started" sort={sort} onSortChange={setSort}>
                Started
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((session) => (
              <TableRow key={session.id}>
                <TableCell className="max-w-[26rem]">
                  <Link
                    to="/$tenant/app/ventures/$ventureId/coach/$sessionId"
                    params={{ tenant, ventureId, sessionId: session.id }}
                    className="block truncate font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {sessionTitle(session)}
                  </Link>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {session.startedBy.displayName}
                    {session.privacy === 'ephemeral' ? (
                      <span className="inline-flex items-center gap-1">
                        · <EyeOff aria-hidden className="size-3" /> Ephemeral
                      </span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <ModeBadge mode={session.mode} />
                </TableCell>
                <TableCell>
                  <StatusBadge kind="session" status={session.status} />
                </TableCell>
                <TableCell className="tabular text-right">
                  <span className="sr-only">{pluralize(session.turnCount, 'turn')}</span>
                  <span aria-hidden>{session.turnCount}</span>
                </TableCell>
                <TableCell>
                  {session.recap ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium">
                      <FileCheck2 aria-hidden className="size-3.5 text-success" />
                      Recap ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Minus aria-hidden className="size-3.5" />
                      {session.status === 'ended' && session.privacy === 'ephemeral'
                        ? 'Not kept'
                        : 'None yet'}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={isoString(session.startedAt)} title={formatDateTime(session.startedAt)}>
                    {formatRelative(session.startedAt)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <StartSessionDialog
        ventureId={ventureId}
        tenant={tenant}
        open={startOpen && Boolean(availability?.available)}
        defaultMode={search.start ?? 'diagnose'}
        onOpenChange={(open) => {
          if (!open) setStart(undefined);
        }}
      />
    </PageContainer>
  );
}
