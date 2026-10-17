import { OPEN_ESCALATION_STATUSES, type EscalationView } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, HandHelping, Inbox, LifeBuoy, Undo2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

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
import { HairlineSkeleton, PageSection } from '@/components/ui/page-section';
import { SelectableRow } from '@/components/ui/selectable-row';
import { getStatusDefinition, StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useEscalationAction, ventureEscalationsQueryOptions } from '@/lib/api/hooks/escalations';
import { canWrite, isAssignedEir } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { needsFounderConsent } from '@/features/program/escalations/status';
import { SegmentedControl } from '@/features/venture/segmented-control';

import { ConsentForm } from './consent-form';
import { EscalationFlowDialog } from './escalation-flow-dialog';
import { isErasedPacket, PacketView } from './packet-view';
import { EscalationTimeline } from './status-timeline';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/help');

const OPEN: ReadonlySet<EscalationView['status']> = new Set(OPEN_ESCALATION_STATUSES);
type Filter = 'open' | 'closed' | 'all';

const PRIORITY_RANK: Record<EscalationView['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Requests waiting for consent first, then the most urgent, then the newest. */
export function sortHelpRequests(items: readonly EscalationView[]): EscalationView[] {
  return [...items].sort(
    (a, b) =>
      Number(needsFounderConsent(b)) - Number(needsFounderConsent(a)) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

/**
 * Human help: requests for a person (an EIR, the program team or a specialist). The list on the left,
 * the selected request on the right (on its own screen on phones): where it is, the AI-drafted brief,
 * and the founder's consent, which gates anything being shared.
 */
export function EscalationsPage() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const canEdit = canWrite(me, ventureId);
  // Requests are the founders' and team's; nobody else asks for them (the API answers 403).
  const escalations = useQuery({
    ...ventureEscalationsQueryOptions(ventureId),
    enabled: canEdit,
    select: (data) => data.items,
  });
  const [filter, setFilter] = useState<Filter>('open');
  const [creating, setCreating] = useState(false);

  const select = (id: string | undefined) => void navigate({ search: { id }, replace: false });

  const rows = useMemo(
    () =>
      sortHelpRequests(
        (escalations.data ?? []).filter((e) =>
          filter === 'all' ? true : filter === 'open' ? OPEN.has(e.status) : !OPEN.has(e.status),
        ),
      ),
    [escalations.data, filter],
  );

  // Side by side (lg+), the most relevant request opens instead of an empty pane; on phones the list
  // comes first and a request opens on its own screen.
  const wide = useMediaQuery(BREAKPOINTS.lg);
  const explicit = escalations.data?.find((e) => e.id === search.id) ?? null;
  const selected = explicit ?? (wide && !search.id ? (rows[0] ?? null) : null);
  const awaiting = (escalations.data ?? []).filter(needsFounderConsent).length;

  if (!canEdit) {
    return (
      <PageContainer>
        <PageHeader title="Human help" />
        {isAssignedEir(me, ventureId) ? (
          <EmptyState
            icon={Inbox}
            headingLevel={2}
            title="Requests for you arrive in your inbox"
            action={
              <Button asChild size="sm" variant="secondary">
                <Link to="/$tenant/app/eir/inbox" params={{ tenant }}>
                  Open inbox
                </Link>
              </Button>
            }
          />
        ) : (
          <EmptyState icon={LifeBuoy} headingLevel={2} title="Only the venture team sees requests" />
        )}
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Human help"
        description="Nothing is shared without your consent."
        info="Ask a person: an EIR, the program team or a specialist."
        actions={
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            <HandHelping aria-hidden />
            Ask a person
          </Button>
        }
      />

      {awaiting > 0 ? (
        <Alert variant="warning" className="mb-8">
          {pluralize(awaiting, 'request')} waiting for your consent.
        </Alert>
      ) : null}

      {escalations.isError ? (
        <ErrorState error={escalations.error} onRetry={() => void escalations.refetch()} headingLevel={2} />
      ) : escalations.data?.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          headingLevel={2}
          title="No requests yet"
          description="Ask here or from a conversation."
        />
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className={cn('grid content-start gap-4', selected && 'hidden lg:grid')}>
            <SegmentedControl
              label="Show requests"
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
              <HairlineSkeleton rows={3} label="Loading requests…" />
            ) : rows.length === 0 ? (
              <p className="border-y border-border py-8 text-center text-small text-muted-foreground">
                {filter === 'open'
                  ? 'No open requests.'
                  : filter === 'closed'
                    ? 'Nothing closed yet.'
                    : 'No requests yet.'}
              </p>
            ) : (
              <ul aria-label="Help requests" className="divide-y divide-border border-y border-border">
                {rows.map((e) => (
                  <li key={e.id}>
                    <SelectableRow
                      selected={e.id === selected?.id}
                      onClick={() => {
                        select(e.id);
                      }}
                      className="grid gap-1 px-3 py-3"
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {ESCALATION_CATEGORY_LABELS[e.category]}
                        </span>
                        <span className="shrink-0 text-caption text-subtle-foreground">
                          {formatRelative(e.createdAt)}
                        </span>
                      </span>
                      {isErasedPacket(e.packet) ? (
                        <span className="text-small text-muted-foreground italic">
                          From a deleted conversation
                        </span>
                      ) : e.packet ? (
                        <span className="line-clamp-2 text-small text-muted-foreground">
                          {e.packet.founderQuestion}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          'text-caption',
                          needsFounderConsent(e) ? 'font-medium text-warning' : 'text-subtle-foreground',
                        )}
                      >
                        {getStatusDefinition('escalationStatus', e.status).label}
                        {e.priority === 'P0' || e.priority === 'P1'
                          ? ` · ${getStatusDefinition('escalationPriority', e.priority).label}`
                          : ''}
                      </span>
                    </SelectableRow>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={cn(!selected && 'hidden lg:block')}>
            {selected ? (
              <HelpRequestDetail
                key={selected.id}
                escalation={selected}
                isSubject={selected.createdBy.id === me.principal.id}
                onBack={() => {
                  select(undefined);
                }}
              />
            ) : search.id && !escalations.isPending ? (
              <EmptyState
                headingLevel={2}
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
            ) : null}
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

/** One request, for the founders and team (the only people who see this page's requests). */
function HelpRequestDetail({
  escalation,
  isSubject,
  onBack,
}: {
  escalation: EscalationView;
  /** Whether the viewer created the request: only they may agree to share it. */
  isSubject: boolean;
  onBack: () => void;
}) {
  const action = useEscalationAction();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const headingId = useId();
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
    <section aria-labelledby={headingId} className="grid gap-8">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit lg:hidden" onClick={onBack}>
        <ArrowLeft aria-hidden />
        All requests
      </Button>

      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <p className="label-mono">
              Requested{' '}
              <time dateTime={isoString(escalation.createdAt)}>{formatDateTime(escalation.createdAt)}</time>
            </p>
            <h2 id={headingId} className="font-serif text-subheading font-normal">
              {ESCALATION_CATEGORY_LABELS[escalation.category]}
            </h2>
          </div>
          {OPEN.has(escalation.status) ? (
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
          ) : null}
        </div>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className="text-caption text-muted-foreground">Status</dt>
            <dd>
              <StatusBadge kind="escalationStatus" status={escalation.status} size="md" withTitle />
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-caption text-muted-foreground">Urgency</dt>
            <dd>
              <StatusBadge kind="escalationPriority" status={escalation.priority} size="md" withTitle />
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-caption text-muted-foreground">Requested from</dt>
            <dd>
              {role}
              {escalation.assignee ? `, ${escalation.assignee.displayName}` : ''}
            </dd>
          </div>
          {escalation.dueAt ? (
            <div className="grid gap-1">
              <dt className="text-caption text-muted-foreground">Response due</dt>
              <dd>
                <time dateTime={isoString(escalation.dueAt)}>{formatDateTime(escalation.dueAt)}</time>
              </dd>
            </div>
          ) : null}
          <div className="grid gap-1">
            <dt className="text-caption text-muted-foreground">Asked by</dt>
            <dd>{escalation.createdBy.displayName}</dd>
          </div>
        </dl>
      </div>

      {escalation.resolution ? (
        <PageSection title="Resolution" headingLevel={3}>
          <p className="text-body whitespace-pre-wrap">{escalation.resolution.summary}</p>
          {escalation.resolution.nextSteps.length > 0 ? (
            <ul className="grid list-disc gap-0.5 pl-5 text-sm marker:text-subtle-foreground">
              {escalation.resolution.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
        </PageSection>
      ) : null}

      <PageSection title="Progress" headingLevel={3}>
        <EscalationTimeline escalation={escalation} />
      </PageSection>

      <PageSection title="Packet" headingLevel={3}>
        <PacketView escalation={escalation} audience="founder" />
      </PageSection>

      {needsConsent ? (
        <PageSection title="Consent" headingLevel={3}>
          {isSubject ? (
            <ConsentForm escalation={escalation} />
          ) : (
            <p className="text-small text-muted-foreground">
              Only {escalation.createdBy.displayName}, who asked, can choose what {role} sees.
            </p>
          )}
        </PageSection>
      ) : null}

      <AlertDialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {escalation.sharingConsentAt
                ? `${role} is told, and gets nothing more. What was shared stays in the audit record.`
                : 'Nothing has been shared yet. The draft closes.'}
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
    </section>
  );
}
