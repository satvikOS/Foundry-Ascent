import { createFileRoute, Link } from '@tanstack/react-router';
import {
  ArrowRight,
  BookOpenCheck,
  Brain,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Play,
  Rocket,
  ShieldCheck,
  Siren,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { MetricTile } from '@/components/ui/metric-tile';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { QuickStart } from '@/components/ventures/quick-start';
import { VentureCard, VentureCardSkeleton } from '@/components/ventures/venture-card';
import { useInboxEscalations } from '@/lib/api/hooks/escalations';
import { useVentures, venturesQueryOptions } from '@/lib/api/hooks/ventures';
import {
  canUseAdminConsole,
  canUseEirStudio,
  canUseProgramConsole,
  canWrite,
  hasAnyRole,
} from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate, formatRelative, greeting } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';

export const Route = createFileRoute('/$tenant/app/')({
  loader: ({ context }) => {
    // Start fetching early; the page renders skeletons until it arrives.
    context.queryClient.query(venturesQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Home' }] }),
  component: HomePage,
});

function HomePage() {
  const me = useRequiredMe();
  const tenant = me.tenant.slug;
  const ventures = useVentures();
  const showInbox = hasAnyRole(me, ['eir', 'program_lead']);
  const inbox = useInboxEscalations({ enabled: showInbox });

  const items = ventures.data ?? [];
  const writable = items.filter((v) => canWrite(me, v.id));
  const totals = items.reduce(
    (acc, v) => ({
      pendingMemory: acc.pendingMemory + v.pendingMemory,
      openEscalations: acc.openEscalations + v.openEscalations,
      openActions: acc.openActions + v.openActions,
    }),
    { pendingMemory: 0, openEscalations: 0, openActions: 0 },
  );
  const firstName = me.principal.displayName.split(/\s+/)[0] ?? me.principal.displayName;
  const loading = ventures.isPending;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={formatDate(new Date())}
        title={`${greeting()}, ${firstName}`}
        description={
          items.length > 0
            ? 'Here’s where your ventures stand since your last visit.'
            : 'Welcome to Foundry Ascent.'
        }
        actions={
          writable.length === 1 && me.aiEnabled ? (
            <Button asChild>
              <Link
                to="/$tenant/app/ventures/$ventureId/coach"
                params={{ tenant, ventureId: writable[0]?.id ?? '' }}
              >
                <Play aria-hidden />
                Open coach
              </Link>
            </Button>
          ) : null
        }
      />

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label="Ventures" value={items.length} icon={Rocket} loading={loading} />
        <MetricTile
          label="Memory to review"
          value={totals.pendingMemory}
          icon={Brain}
          loading={loading}
          hint={totals.pendingMemory > 0 ? 'Proposed by the coach, waiting for approval' : 'All caught up'}
        />
        <MetricTile
          label="Open escalations"
          value={totals.openEscalations}
          icon={Siren}
          loading={loading}
          hint={totals.openEscalations > 0 ? 'Awaiting a human or your consent' : 'Nothing waiting'}
        />
        <MetricTile label="Open actions" value={totals.openActions} icon={ListChecks} loading={loading} />
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SectionCard
          title="Your ventures"
          icon={Rocket}
          actions={
            items.length > 0 ? (
              <Button asChild variant="ghost" size="sm">
                <Link to="/$tenant/app/ventures" params={{ tenant }}>
                  View all
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            ) : null
          }
        >
          {ventures.isError ? (
            <ErrorState
              error={ventures.error}
              onRetry={() => void ventures.refetch()}
              size="sm"
              headingLevel={3}
            />
          ) : loading ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
              <span className="sr-only" role="status">
                Loading ventures…
              </span>
              <VentureCardSkeleton />
              <VentureCardSkeleton />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Rocket}
              title="No ventures yet"
              description={
                canUseProgramConsole(me)
                  ? 'Enrol a venture from the Program console to get started.'
                  : 'When a program lead adds you to a venture, it will appear here.'
              }
              action={
                canUseProgramConsole(me) ? (
                  <Button asChild size="sm" variant="secondary">
                    <Link to="/$tenant/app/program/ventures" params={{ tenant }}>
                      Go to Program
                    </Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {items.slice(0, 6).map((venture) => (
                <li key={venture.id}>
                  <VentureCard venture={venture} tenant={tenant} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="grid content-start gap-6">
          {writable.length > 0 ? (
            <SectionCard
              title="Start a session"
              icon={Play}
              description="Work with Foundry Guide on what matters now."
            >
              <QuickStart tenant={tenant} ventures={writable} aiEnabled={me.aiEnabled} />
            </SectionCard>
          ) : null}

          {showInbox ? (
            <SectionCard
              title="Escalation inbox"
              icon={Inbox}
              flush
              actions={
                canUseEirStudio(me) ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/$tenant/app/eir/inbox" params={{ tenant }}>
                      Open
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                ) : null
              }
            >
              {inbox.isPending ? (
                <div className="space-y-2 p-4" aria-hidden>
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : inbox.isError ? (
                <ErrorState
                  error={inbox.error}
                  onRetry={() => void inbox.refetch()}
                  size="sm"
                  headingLevel={3}
                  className="border-0"
                />
              ) : inbox.data.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">Nothing is waiting for you.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {inbox.data.slice(0, 5).map((escalation) => (
                    <li key={escalation.id} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{escalation.ventureName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {ESCALATION_CATEGORY_LABELS[escalation.category]} ·{' '}
                          {formatRelative(escalation.createdAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <StatusBadge kind="escalationPriority" status={escalation.priority} />
                        <StatusBadge kind="escalationStatus" status={escalation.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          ) : null}

          {canUseEirStudio(me) || canUseProgramConsole(me) || canUseAdminConsole(me) ? (
            <SectionCard title="Consoles" flush>
              <ul className="divide-y divide-border">
                {canUseEirStudio(me) ? (
                  <li>
                    <ConsoleLink
                      icon={BookOpenCheck}
                      title="EIR studio"
                      description="Personas, calibration reviews, inbox"
                    >
                      <Link
                        to="/$tenant/app/eir"
                        params={{ tenant }}
                        className="absolute inset-0"
                        aria-label="Open EIR studio"
                      />
                    </ConsoleLink>
                  </li>
                ) : null}
                {canUseProgramConsole(me) ? (
                  <li>
                    <ConsoleLink
                      icon={LayoutDashboard}
                      title="Program"
                      description="Portfolio, ventures, resources, escalations"
                    >
                      <Link
                        to="/$tenant/app/program"
                        params={{ tenant }}
                        className="absolute inset-0"
                        aria-label="Open Program console"
                      />
                    </ConsoleLink>
                  </li>
                ) : null}
                {canUseAdminConsole(me) ? (
                  <li>
                    <ConsoleLink
                      icon={ShieldCheck}
                      title="Admin"
                      description="Principals, settings, usage, audit"
                    >
                      <Link to="/admin" className="absolute inset-0" aria-label="Open Admin console" />
                    </ConsoleLink>
                  </li>
                ) : null}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}

function ConsoleLink({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Rocket;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex items-center gap-3 px-5 py-3.5 transition-colors focus-within:bg-accent hover:bg-accent/60 [&_a]:rounded-none [&_a:focus-visible]:outline-2 [&_a:focus-visible]:-outline-offset-2 [&_a:focus-visible]:outline-ring">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
      <ArrowRight aria-hidden className="size-4 text-muted-foreground" />
      {children}
    </div>
  );
}
