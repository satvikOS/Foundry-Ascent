import { ScrollText, Search, X } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type AuditEvent, useAuditLog } from '@/lib/api/hooks/admin';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';

import { AUDIT_OUTCOMES, OutcomeBadge, outcomeLabel, type AuditOutcome } from './outcome-badge';

export interface AuditSearch {
  action?: string | undefined;
  outcome?: AuditOutcome | undefined;
}

interface AuditPageProps {
  search: AuditSearch;
  onSearchChange: (next: AuditSearch) => void;
}

function DetailRow({ term, value, copyLabel }: { term: string; value: string | null; copyLabel?: string }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 items-start gap-1">
        {value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            <code className="min-w-0 font-mono text-caption break-all">{value}</code>
            {copyLabel ? <CopyButton value={value} label={copyLabel} size="icon-xs" /> : null}
          </>
        )}
      </dd>
    </div>
  );
}

/** Everything recorded for one event (metadata only, never content). */
function EventSheet({ event, onClose }: { event: AuditEvent | null; onClose: () => void }) {
  return (
    <Sheet
      open={event !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-[min(100vw-1rem,30rem)]">
        {event ? (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">{event.action}</SheetTitle>
              <SheetDescription>
                Event #{event.id} · {formatDateTime(event.at)}
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <div className="mb-3">
                <OutcomeBadge outcome={event.outcome} />
              </div>
              <dl className="divide-y divide-border text-small">
                <DetailRow term="Actor" value={event.actorId} copyLabel="Copy actor ID" />
                <DetailRow term="Venture" value={event.ventureId} copyLabel="Copy venture ID" />
                <DetailRow term="Object type" value={event.objectType} />
                <DetailRow term="Object" value={event.objectId} copyLabel="Copy object ID" />
                <DetailRow term="Policy reason" value={event.policyReason} />
                <DetailRow term="Request" value={event.requestId} copyLabel="Copy request ID" />
                <DetailRow term="Hash" value={event.hash} copyLabel="Copy hash" />
              </dl>
            </SheetBody>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Admin → Audit log: append-only, hash-chained metadata events (never content), newest first, with
 * cursor pagination. Filters live in the URL so a filtered view can be linked from an incident.
 */
export function AuditPage({ search, onSearchChange }: AuditPageProps) {
  const [action, setAction] = useState(search.action ?? '');
  const pushed = useRef(search.action);
  const actionId = useId();
  const log = useAuditLog({ action: search.action, outcome: search.outcome, limit: 50 });
  const [openId, setOpenId] = useState<number | null>(null);

  // Adopt URL changes we didn't make (back/forward) without clobbering typing.
  useEffect(() => {
    if (search.action !== pushed.current) {
      pushed.current = search.action;
      setAction(search.action ?? '');
    }
  }, [search.action]);

  // Debounce the action filter into the URL.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = action.trim().slice(0, 80) || undefined;
      if (next !== search.action) {
        pushed.current = next;
        onSearchChange({ ...search, action: next });
      }
    }, 300);
    return () => {
      clearTimeout(handle);
    };
  }, [action, search, onSearchChange]);

  const events = log.data?.pages.flatMap((page) => page.items) ?? [];
  const openEvent = events.find((event) => event.id === openId) ?? null;
  const filtering = search.action !== undefined || search.outcome !== undefined;

  return (
    <PageContainer size="full" className="max-w-[96rem]">
      <PageHeader
        title="Audit log"
        description="Security and admin events (metadata only). Hash-chained: any edit breaks the chain."
      >
        <div
          role="search"
          aria-label="Filter audit events"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <div className="grid gap-1.5">
            <label htmlFor={actionId} className="text-[13px] font-medium text-muted-foreground">
              Action
            </label>
            <div className="relative w-full sm:w-72">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={actionId}
                type="search"
                value={action}
                maxLength={80}
                onChange={(event) => {
                  setAction(event.target.value);
                }}
                placeholder="e.g. auth.sign_in"
                className="pl-8 font-mono text-[13px]"
                spellCheck={false}
                autoCapitalize="off"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium text-muted-foreground" aria-hidden>
              Outcome
            </span>
            <Select
              value={search.outcome ?? 'all'}
              onValueChange={(value) => {
                const outcome = AUDIT_OUTCOMES.find((o) => o === value);
                onSearchChange({ ...search, outcome });
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                {AUDIT_OUTCOMES.map((o) => (
                  <SelectItem key={o} value={o}>
                    {outcomeLabel(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filtering ? (
            <Button
              variant="ghost"
              size="sm"
              className="sm:mb-0.5"
              onClick={() => {
                setAction('');
                pushed.current = undefined;
                onSearchChange({});
              }}
            >
              <X aria-hidden />
              Clear filters
            </Button>
          ) : null}
        </div>
      </PageHeader>

      {log.isPending ? (
        <LoadingRegion label="Loading audit events">
          <Skeleton className="h-96 rounded-xl" />
        </LoadingRegion>
      ) : log.data === undefined ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} retrying={log.isRefetching} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={filtering ? 'No events match' : 'No audit events yet'}
          description={
            filtering ? 'Try a different action or outcome.' : 'Events appear as people sign in and act.'
          }
        />
      ) : (
        <div className="grid gap-3">
          <Table className="text-small">
            <TableCaption className="sr-only">Audit events, newest first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">When</TableHead>
                <TableHead scope="col">Action</TableHead>
                <TableHead scope="col">Outcome</TableHead>
                <TableHead scope="col" className="hidden md:table-cell">
                  Object
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id} className="relative">
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <time dateTime={event.at} title={formatDateTime(event.at)}>
                      {formatRelative(event.at)}
                    </time>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenId(event.id);
                      }}
                      className="text-left font-mono text-caption underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      aria-label={`Event ${event.id}: ${event.action}`}
                    >
                      <BreakAfterDots text={event.action} />
                    </button>
                  </TableCell>
                  <TableCell>
                    <OutcomeBadge outcome={event.outcome} />
                  </TableCell>
                  <TableCell className="hidden max-w-56 truncate text-muted-foreground md:table-cell">
                    {event.objectType ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
            <p className="text-[13px] text-muted-foreground" aria-live="polite">
              Showing {formatNumber(events.length)} {events.length === 1 ? 'event' : 'events'}
              {log.hasNextPage ? '' : ' · end of log'}
            </p>
            {log.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void log.fetchNextPage()}
                loading={log.isFetchingNextPage}
                loadingText="Loading…"
              >
                Load older events
              </Button>
            ) : null}
          </div>
          {log.isError ? (
            // Pages already loaded stay visible; only the failed fetch is reported.
            <ErrorState
              size="sm"
              error={log.error}
              title={log.isFetchNextPageError ? 'Couldn’t load older events' : 'Couldn’t refresh the log'}
              onRetry={() => void (log.isFetchNextPageError ? log.fetchNextPage() : log.refetch())}
            />
          ) : null}
        </div>
      )}
      <EventSheet
        event={openEvent}
        onClose={() => {
          setOpenId(null);
        }}
      />
    </PageContainer>
  );
}

/** Lets dotted identifiers (`escalation.approve_sharing`) wrap after a dot instead of mid-word. */
function BreakAfterDots({ text }: { text: string }) {
  const parts = text.split('.');
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? (
            <>
              .<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}
