import { OPEN_ESCALATION_STATUSES, type EscalationView } from '@foundry/contracts';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowLeft, CalendarClock, HandHelping, ShieldCheck, Siren, Undo2, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useEscalationAction, useVentureEscalations } from '@/lib/api/hooks/escalations';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { needsFounderConsent } from '@/features/program/escalations/status';
import { SegmentedControl } from '@/features/venture/segmented-control';

import { ConsentForm } from './consent-form';
import { EscalationFlowDialog } from './escalation-flow-dialog';
import { EscalationPacketView } from './packet-view';
import { EscalationTimeline } from './status-timeline';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/escalations');

const OPEN: ReadonlySet<EscalationView['status']> = new Set(OPEN_ESCALATION_STATUSES);
const WITHDRAWABLE = OPEN;
type Filter = 'open' | 'closed' | 'all';

const PRIORITY_RANK: Record<EscalationView['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function EscalationsPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const escalations = useVentureEscalations(ventureId);
  const canEdit = canWrite(me, ventureId);
  const [filter, setFilter] = useState<Filter>('open');
  const [creating, setCreating] = useState(false);

  const select = (id: string | undefined) => void navigate({ search: { id }, replace: false });

  const rows = useMemo(() => {
    const items = (escalations.data ?? []).filter((e) =>
      filter === 'all' ? true : filter === 'open' ? OPEN.has(e.status) : !OPEN.has(e.status),
    );
    return items.sort(
      (a, b) =>
        Number(needsFounderConsent(b)) - Number(needsFounderConsent(a)) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }, [escalations.data, filter]);

  // Side-by-side layout (lg+): open the most relevant request instead of an empty detail pane. On phones
  // the list comes first and a request opens on its own screen.
  const wide = useMediaQuery(BREAKPOINTS.lg);
  const explicit = escalations.data?.find((e) => e.id === search.id) ?? null;
  const selected = explicit ?? (wide && !search.id ? (rows[0] ?? null) : null);
  const awaiting = (escalations.data ?? []).filter(needsFounderConsent).length;

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Escalations"
        description="Requests for human support. Packets are drafted by Foundry Guide (AI) — nothing is shared until you review it and consent."
        actions={
          canEdit ? (
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              <HandHelping aria-hidden />
              Request human support
            </Button>
          ) : null
        }
      />

      {awaiting > 0 ? (
        <Alert variant="warning" title="Waiting for your consent" className="mb-5">
          {awaiting === 1
            ? 'One request is drafted but not shared yet. Review its packet and choose what to share.'
            : `${awaiting} requests are drafted but not shared yet. Review each packet and choose what to share.`}
        </Alert>
      ) : null}

      {escalations.isError ? (
        <ErrorState error={escalations.error} onRetry={() => void escalations.refetch()} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className={cn('grid content-start gap-3', selected && 'hidden lg:grid')}>
            <SegmentedControl
              label="Filter escalations"
              value={filter}
              onChange={setFilter}
              className="w-full"
              options={[
                { value: 'open', label: 'Open' },
                { value: 'closed', label: 'Closed' },
                { value: 'all', label: 'All' },
              ]}
            />
            {escalations.isPending ? (
              <div aria-busy="true" className="grid gap-2">
                <span className="sr-only" role="status">
                  Loading escalations…
                </span>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-xl" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Siren}
                title={
                  filter === 'open'
                    ? 'No open requests'
                    : filter === 'closed'
                      ? 'Nothing closed yet'
                      : 'No requests yet'
                }
                description="When Foundry Guide suggests a person should weigh in — or you ask for one — the request appears here."
              />
            ) : (
              <ul aria-label="Escalations" className="grid gap-2">
                {rows.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      aria-current={e.id === selected?.id ? 'true' : undefined}
                      onClick={() => {
                        select(e.id);
                      }}
                      className={cn(
                        'grid w-full gap-1.5 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:bg-accent/50',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        e.id === selected?.id ? 'border-foreground/50' : 'border-border',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {ESCALATION_CATEGORY_LABELS[e.category]}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelative(e.createdAt)}
                        </span>
                      </span>
                      {e.packet ? (
                        <span className="line-clamp-2 text-[13px] text-muted-foreground">
                          {e.packet.founderQuestion}
                        </span>
                      ) : null}
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge kind="escalationPriority" status={e.priority} />
                        <StatusBadge kind="escalationStatus" status={e.status} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={cn(!selected && 'hidden lg:block')}>
            {selected ? (
              <EscalationDetail
                key={selected.id}
                escalation={selected}
                canEdit={canEdit}
                onBack={() => {
                  select(undefined);
                }}
              />
            ) : search.id && !escalations.isPending ? (
              <EmptyState
                title="Request not found"
                description="It may have been removed, or you may not have access to it."
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      select(undefined);
                    }}
                  >
                    Back to the list
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={HandHelping}
                title="Select a request"
                description="See the AI-drafted packet, what you agreed to share, and where it is in the process."
              />
            )}
          </div>
        </div>
      )}

      <EscalationFlowDialog
        ventureId={ventureId}
        open={creating}
        onOpenChange={setCreating}
        onViewEscalation={(e) => {
          select(e.id);
        }}
      />
    </PageContainer>
  );
}

function EscalationDetail({
  escalation,
  canEdit,
  onBack,
}: {
  escalation: EscalationView;
  canEdit: boolean;
  onBack: () => void;
}) {
  const action = useEscalationAction();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const role = REQUESTED_ROLE_LABELS[escalation.requestedRole] ?? escalation.requestedRole;
  const needsConsent = needsFounderConsent(escalation);

  const withdraw = () => {
    setConfirmWithdraw(false);
    action.mutate(
      { escalationId: escalation.id, action: { action: 'withdraw' } },
      {
        onSuccess: () => {
          toast.success('Request withdrawn');
          announce('Request withdrawn');
        },
        onError: (error) => {
          toast.error('Couldn’t withdraw the request', { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <div className="grid gap-5">
      <Button variant="ghost" size="sm" className="w-fit lg:hidden" onClick={onBack}>
        <ArrowLeft aria-hidden />
        All requests
      </Button>
      <SectionCard
        title={ESCALATION_CATEGORY_LABELS[escalation.category]}
        icon={Siren}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Requested {formatDateTime(escalation.createdAt)}</span>
            <span>by {escalation.createdBy.displayName}</span>
          </span>
        }
        actions={
          canEdit && WITHDRAWABLE.has(escalation.status) ? (
            <Button
              variant="ghost"
              size="sm"
              loading={action.isPending}
              onClick={() => {
                setConfirmWithdraw(true);
              }}
            >
              <Undo2 aria-hidden />
              Withdraw
            </Button>
          ) : null
        }
      >
        <div className="grid gap-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge kind="escalationStatus" status={escalation.status} size="md" withTitle />
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">Urgency</dt>
              <dd>
                <StatusBadge kind="escalationPriority" status={escalation.priority} size="md" withTitle />
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">Requested help from</dt>
              <dd className="flex items-center gap-1.5">
                <UserRound aria-hidden className="size-4 text-muted-foreground" />
                {role}
                {escalation.assignee ? <> · {escalation.assignee.displayName}</> : null}
              </dd>
            </div>
            {escalation.dueAt ? (
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">Response due</dt>
                <dd className="flex items-center gap-1.5">
                  <CalendarClock aria-hidden className="size-4 text-muted-foreground" />
                  <time dateTime={isoString(escalation.dueAt)}>{formatDateTime(escalation.dueAt)}</time>
                </dd>
              </div>
            ) : null}
          </dl>

          {escalation.resolution ? (
            <Alert variant="success" title="Resolution">
              <p className="whitespace-pre-wrap">{escalation.resolution.summary}</p>
              {escalation.resolution.nextSteps.length > 0 ? (
                <ul className="mt-2 list-disc pl-4">
                  {escalation.resolution.nextSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}

          <div>
            <h3 className="mb-3 text-sm font-semibold">Progress</h3>
            <EscalationTimeline escalation={escalation} />
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Packet"
        description="What the human reviewer receives. Drafted by Foundry Guide — check it carefully."
      >
        {escalation.packet ? (
          <EscalationPacketView packet={escalation.packet} sharedOnly={!needsConsent} />
        ) : (
          <p className="text-[13px] text-muted-foreground">
            The packet isn’t available to you, or is still being prepared.
          </p>
        )}
        {!needsConsent && escalation.packet && escalation.packet.sharedFacts.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <ShieldCheck aria-hidden className="size-4 text-muted-foreground" />
              Facts you shared
            </h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {escalation.packet.sharedFacts.map((fact, index) => (
                <li key={`${index}-${fact.text}`}>{fact.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>

      {needsConsent && canEdit ? (
        <SectionCard
          title="Consent"
          icon={ShieldCheck}
          description={`Choose which confirmed facts ${role} may see.`}
        >
          <ConsentForm escalation={escalation} />
        </SectionCard>
      ) : null}

      <AlertDialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {escalation.sharingConsentAt
                ? `${role} will be told the request was withdrawn and won’t receive anything further. What was already shared stays in the audit record.`
                : 'Nothing has been shared yet. The draft will be closed.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep request</AlertDialogCancel>
            <Button variant="destructive" onClick={withdraw}>
              Withdraw
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
