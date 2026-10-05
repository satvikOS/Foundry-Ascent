import type { CoachMode, MemoryObjectView, SessionView } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
import {
  AlarmClock,
  ArrowRight,
  ChevronDown,
  FileCheck2,
  Gavel,
  Inbox,
  Lightbulb,
  Milestone,
  MessagesSquare,
  Play,
  Siren,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVentureOverview } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { MODE_LABELS } from '@/lib/labels';
import { coachingAvailability } from '@/features/coach/availability';
import { COACH_MODES, ModeBadge } from '@/features/coach/modes';
import { sessionTitle } from '@/features/coach/sessions-page';
import { StartSessionDialog } from '@/features/coach/start-session-dialog';
import { MemoryTypeLabel } from '@/features/memory/memory-meta';
import {
  actionAttributes,
  daysUntil,
  decisionAttributes,
  formatIsoDate,
  milestoneAttributes,
} from '@/features/memory/typed/attributes';
import { TypedStatusBadge } from '@/features/memory/typed/typed-status';

import { GoalEditor } from './goal-editor';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/overview');

function MemoryLink({
  memory,
  tenant,
  ventureId,
}: {
  memory: MemoryObjectView;
  tenant: string;
  ventureId: string;
}) {
  return (
    <Link
      to="/$tenant/app/ventures/$ventureId/memory"
      params={{ tenant, ventureId }}
      search={{ m: memory.id }}
      className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
    >
      {memory.title}
    </Link>
  );
}

function BriefList({
  items,
  empty,
  render,
}: {
  items: readonly MemoryObjectView[];
  empty: string;
  render: (memory: MemoryObjectView) => ReactNode;
}) {
  if (items.length === 0) return <p className="text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <ul className="-my-2 divide-y divide-border">
      {items.map((memory) => (
        <li key={memory.id} className="py-2.5 text-sm">
          {render(memory)}
        </li>
      ))}
    </ul>
  );
}

const viewAllClasses = 'inline-flex items-center gap-1';

function ViewAllLabel({ label }: { label: string }) {
  return (
    <span className={viewAllClasses}>
      {label}
      <ArrowRight aria-hidden />
    </span>
  );
}

function StartSessionControl({
  available,
  reason,
  onStart,
}: {
  available: boolean;
  reason: string | null;
  onStart: (mode: CoachMode) => void;
}) {
  if (!available) {
    return (
      <SimpleTooltip content={reason ?? 'Coaching is unavailable'}>
        <Button aria-disabled className="cursor-not-allowed">
          <Play aria-hidden />
          Start a session
        </Button>
      </SimpleTooltip>
    );
  }
  return (
    <div className="flex">
      <Button
        className="rounded-r-none"
        onClick={() => {
          onStart('diagnose');
        }}
      >
        <Play aria-hidden />
        Start a session
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="rounded-l-none border-l border-primary-foreground/20 px-2"
            aria-label="Choose a mode to start with"
          >
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Start in mode</DropdownMenuLabel>
          {COACH_MODES.map((mode) => {
            const def = MODE_LABELS[mode];
            const Icon = def.icon;
            return (
              <DropdownMenuItem
                key={mode}
                onSelect={() => {
                  onStart(mode);
                }}
                className="items-start"
              >
                <Icon aria-hidden className="mt-0.5" />
                <span className="grid">
                  <span className="font-medium">{def.label}</span>
                  <span className="text-xs text-muted-foreground">{def.description}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SessionLine({
  session,
  tenant,
  ventureId,
}: {
  session: SessionView;
  tenant: string;
  ventureId: string;
}) {
  return (
    <li className="grid gap-1 py-2.5">
      <Link
        to="/$tenant/app/ventures/$ventureId/coach/$sessionId"
        params={{ tenant, ventureId, sessionId: session.id }}
        className="truncate text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {sessionTitle(session)}
      </Link>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ModeBadge mode={session.mode} />
        <StatusBadge kind="session" status={session.status} />
        {session.recap ? (
          <span className="inline-flex items-center gap-1">
            <FileCheck2 aria-hidden className="size-3.5" />
            Recap
          </span>
        ) : null}
        <time dateTime={isoString(session.startedAt)} title={formatDateTime(session.startedAt)}>
          {formatRelative(session.startedAt)}
        </time>
      </span>
    </li>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <span className="sr-only" role="status">
        Loading overview…
      </span>
      <div className="grid gap-6">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
      <div className="grid content-start gap-6">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}

function CountCallout({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <Alert variant="warning" icon={Icon} title={title} action={action}>
      {description}
    </Alert>
  );
}

export function OverviewPage() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const overview = useVentureOverview(ventureId);
  const [startMode, setStartMode] = useState<CoachMode | null>(null);
  const canEdit = canWrite(me, ventureId);
  const data = overview.data;
  const availability = data ? coachingAvailability(me, data.venture) : null;
  const since = data?.sinceLastSession;

  return (
    <PageContainer size="wide">
      <PageHeader
        eyebrow={data?.venture.name}
        title="Since your last session"
        description={
          data
            ? since?.lastSessionAt
              ? `Your last session was ${formatRelative(since.lastSessionAt)}. Here’s what changed and what needs you.`
              : 'No sessions yet. Start with Diagnose to find the constraint that matters most right now.'
            : undefined
        }
        actions={
          availability && canEdit ? (
            <StartSessionControl
              available={availability.available}
              reason={availability.reason}
              onStart={setStartMode}
            />
          ) : null
        }
      />

      {overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !data ? (
        <OverviewSkeleton />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid content-start gap-6">
            <GoalEditor ventureId={ventureId} goal={data.currentGoal} canEdit={canEdit} />

            {data.pendingMemoryCount > 0 || data.openEscalations > 0 ? (
              <div className="grid gap-3" aria-label="Needs your attention" role="group">
                {data.pendingMemoryCount > 0 ? (
                  <CountCallout
                    icon={Inbox}
                    title={`${pluralize(data.pendingMemoryCount, 'memory suggestion')} waiting for approval`}
                    description="Foundry Guide doesn’t use proposed memory until someone on the team approves it."
                    action={
                      <Button asChild size="sm">
                        <Link
                          to="/$tenant/app/ventures/$ventureId/memory"
                          params={{ tenant, ventureId }}
                          search={{ view: 'proposed' }}
                        >
                          Review now
                        </Link>
                      </Button>
                    }
                  />
                ) : null}
                {data.openEscalations > 0 ? (
                  <Alert
                    variant="info"
                    icon={Siren}
                    title={`${pluralize(data.openEscalations, 'open request')} for human support`}
                    action={
                      <Button asChild size="sm" variant="secondary">
                        <Link
                          to="/$tenant/app/ventures/$ventureId/escalations"
                          params={{ tenant, ventureId }}
                        >
                          Open escalations
                        </Link>
                      </Button>
                    }
                  >
                    Check whether any are waiting for your consent.
                  </Alert>
                ) : null}
              </div>
            ) : null}

            <SectionCard
              title="New since last session"
              icon={Sparkles}
              description="Evidence and memory added or changed since you last worked with Foundry Guide."
            >
              <BriefList
                items={[
                  ...data.sinceLastSession.newEvidence,
                  ...data.sinceLastSession.changedMemory.filter(
                    (m) => !data.sinceLastSession.newEvidence.some((e) => e.id === m.id),
                  ),
                ]}
                empty="Nothing new since your last session."
                render={(memory) => (
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <MemoryTypeLabel type={memory.type} />
                      <MemoryLink memory={memory} tenant={tenant} ventureId={ventureId} />
                    </div>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <StatusBadge kind="memory" status={memory.status} />
                      Updated {formatRelative(memory.updatedAt)} · {memory.createdBy.displayName}
                    </span>
                  </div>
                )}
              />
            </SectionCard>

            <SectionCard
              title="Verified decisions"
              icon={Gavel}
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link to="/$tenant/app/ventures/$ventureId/decisions" params={{ tenant, ventureId }}>
                    <ViewAllLabel label="All decisions" />
                  </Link>
                </Button>
              }
            >
              <BriefList
                items={data.verifiedDecisions}
                empty="No confirmed decisions yet."
                render={(memory) => {
                  const a = decisionAttributes(memory);
                  return (
                    <div className="grid gap-0.5">
                      <MemoryLink memory={memory} tenant={tenant} ventureId={ventureId} />
                      <span className="text-xs text-muted-foreground">
                        {[a.decided_on ? formatIsoDate(a.decided_on) : null, a.owner]
                          .filter(Boolean)
                          .join(' · ') || formatRelative(memory.createdAt)}
                      </span>
                      {a.reversal_condition ? (
                        <span className="text-xs text-muted-foreground">
                          Revisit if: {a.reversal_condition}
                        </span>
                      ) : null}
                    </div>
                  );
                }}
              />
            </SectionCard>

            <SectionCard
              title="Open assumptions"
              icon={Lightbulb}
              description="Hypotheses not yet tested. The riskiest ones deserve an experiment."
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link
                    to="/$tenant/app/ventures/$ventureId/memory"
                    params={{ tenant, ventureId }}
                    search={{ type: 'hypothesis' }}
                  >
                    <ViewAllLabel label="All hypotheses" />
                  </Link>
                </Button>
              }
            >
              <BriefList
                items={data.openAssumptions}
                empty="No open assumptions recorded."
                render={(memory) => (
                  <div className="grid gap-1">
                    <MemoryLink memory={memory} tenant={tenant} ventureId={ventureId} />
                    <span className="line-clamp-2 text-[13px] text-muted-foreground">{memory.content}</span>
                  </div>
                )}
              />
            </SectionCard>
          </div>

          <div className="grid content-start gap-6">
            <SectionCard
              title="Overdue actions"
              icon={AlarmClock}
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link
                    to="/$tenant/app/ventures/$ventureId/memory"
                    params={{ tenant, ventureId }}
                    search={{ type: 'action' }}
                  >
                    <ViewAllLabel label="All actions" />
                  </Link>
                </Button>
              }
            >
              <BriefList
                items={data.overdueActions}
                empty="Nothing overdue."
                render={(memory) => {
                  const a = actionAttributes(memory);
                  const overdue = a.due ? -daysUntil(a.due) : null;
                  return (
                    <div className="grid gap-1">
                      <MemoryLink memory={memory} tenant={tenant} ventureId={ventureId} />
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {overdue !== null && overdue > 0 ? (
                          <span className="inline-flex items-center gap-1 font-medium text-destructive">
                            <AlarmClock aria-hidden className="size-3" />
                            {overdue} day{overdue === 1 ? '' : 's'} overdue
                          </span>
                        ) : null}
                        {a.owner ? <span>{a.owner}</span> : null}
                      </span>
                    </div>
                  );
                }}
              />
            </SectionCard>

            <SectionCard
              title="Upcoming milestones"
              icon={Milestone}
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link to="/$tenant/app/ventures/$ventureId/milestones" params={{ tenant, ventureId }}>
                    <ViewAllLabel label="Timeline" />
                  </Link>
                </Button>
              }
            >
              <BriefList
                items={data.upcomingMilestones}
                empty="No upcoming milestones."
                render={(memory) => {
                  const a = milestoneAttributes(memory);
                  return (
                    <div className="grid gap-1">
                      <MemoryLink memory={memory} tenant={tenant} ventureId={ventureId} />
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {a.target_date ? (
                          <time dateTime={a.target_date}>{formatIsoDate(a.target_date)}</time>
                        ) : null}
                        <TypedStatusBadge kind="milestone" status={a.status} />
                      </span>
                    </div>
                  );
                }}
              />
            </SectionCard>

            <SectionCard
              title="Recent sessions"
              icon={MessagesSquare}
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link to="/$tenant/app/ventures/$ventureId/coach" params={{ tenant, ventureId }}>
                    <ViewAllLabel label="All sessions" />
                  </Link>
                </Button>
              }
            >
              {data.recentSessions.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No sessions yet.</p>
              ) : (
                <ul className="-my-2 divide-y divide-border">
                  {data.recentSessions.map((session) => (
                    <SessionLine key={session.id} session={session} tenant={tenant} ventureId={ventureId} />
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </div>
      )}

      <StartSessionDialog
        ventureId={ventureId}
        tenant={tenant}
        open={startMode !== null}
        defaultMode={startMode ?? 'diagnose'}
        onOpenChange={(open) => {
          if (!open) setStartMode(null);
        }}
      />
    </PageContainer>
  );
}
