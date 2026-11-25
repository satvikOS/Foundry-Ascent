import type { PathIntake, VenturePath } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Printer, Signpost } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useVentureName } from '@/components/shell/venture-name';
import { useVenturePath } from '@/lib/api/hooks/path';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';

import { longDay } from './due';
import { EMPTY_INTAKE, EXPERIENCE_LABELS, IntakeForm } from './intake-form';
import { currentStage, laterItems, nextSteps, planAsText, stageLine } from './plan';
import { PlanSheet } from './plan-sheet';
import { StageRail } from './stage-rail';
import { StepCard } from './step-card';
import { Story } from './story';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/path');

/** Your path: one venture's stage, its steps and its story. Founders and the team act on it; others read it. */
export function PathPage() {
  const { tenant, ventureId } = routeApi.useParams();
  return <PathView tenant={tenant} ventureId={ventureId} />;
}

/** The page's body for one venture (what the route renders, and what the tests render). */
export function PathView({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  const me = useRequiredMe();
  const path = useVenturePath(ventureId);
  // A program lead who is not on the venture reads its path's shape; its name comes with its team.
  const ventureName = useVentureName(me, ventureId);
  const editable = canWrite(me, ventureId);
  const name = ventureName ?? 'Venture';
  const title = editable ? 'Your path' : ventureName === null ? 'Path' : `${name}’s path`;

  if (path.isPending) {
    return (
      <PageContainer className="max-w-5xl">
        <PageHeader title={title} />
        <div aria-busy="true" className="grid gap-6">
          <span className="sr-only" role="status">
            Loading…
          </span>
          <Skeleton className="h-56 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageContainer>
    );
  }
  if (path.isError || path.data === null) {
    return (
      <PageContainer className="max-w-5xl">
        <PageHeader title={title} />
        {path.isError ? (
          <ErrorState error={path.error} onRetry={() => void path.refetch()} headingLevel={2} />
        ) : (
          <EmptyState
            icon={Signpost}
            headingLevel={2}
            title="No path yet"
            action={editable ? <AskNext tenant={tenant} ventureId={ventureId} /> : null}
          />
        )}
      </PageContainer>
    );
  }

  return (
    <>
      <PlanSheet path={path.data} ventureName={name} disclosure={me.disclosure} />
      <PageContainer className="max-w-5xl print:hidden">
        <PageHeader
          title={title}
          description={stageLine(path.data)}
          actions={
            <>
              <CopyButton
                value={planAsText(path.data, { ventureName: name, disclosure: me.disclosure })}
                label="Copy text"
                showLabel
                variant="secondary"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  window.print();
                }}
              >
                <Printer aria-hidden />
                Print
              </Button>
            </>
          }
        />
        <PathBody tenant={tenant} ventureId={ventureId} path={path.data} editable={editable} />
      </PageContainer>
    </>
  );
}

function AskNext({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  return (
    <Button asChild size="sm" variant="secondary">
      <Link to="/$tenant/app/v/$ventureId" params={{ tenant, ventureId }}>
        New chat
      </Link>
    </Button>
  );
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = `path-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 id={id} className="text-subheading font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function PathBody({
  tenant,
  ventureId,
  path,
  editable,
}: {
  tenant: string;
  ventureId: string;
  path: VenturePath;
  editable: boolean;
}) {
  const stage = currentStage(path);
  const next = nextSteps(path);
  const later = laterItems(path);
  const place = stage
    ? {
        stageTitle: stage.title,
        stageNumber: path.stages.indexOf(stage) + 1,
        stageCount: path.stages.length,
      }
    : null;
  const card = { tenant, ventureId, canEdit: editable, headingLevel: 3 as const };
  return (
    <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <Section title="Now">
          {path.now ? (
            <StepCard
              key={path.now.id}
              {...card}
              step={path.now}
              place={place}
              then={next.slice(0, 2).map((step) => step.title)}
              label="Step"
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-small text-muted-foreground">
              No step yet.
              {editable ? <AskNext tenant={tenant} ventureId={ventureId} /> : null}
            </div>
          )}
        </Section>
      </div>
      {/* Beside both on a wide screen; between now and next on a smaller one, in the order it is read. */}
      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <Section title="Stages">
          <StageRail path={path} />
        </Section>
      </div>
      <div className="grid min-w-0 content-start gap-10">
        {next.length > 0 ? (
          <Section title="Next">
            <ul className="grid gap-2">
              {next.map((step) => (
                <li key={step.id}>
                  <StepCard {...card} step={step} expanded={false} label="Next" />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {later.length > 0 ? (
          <Section title="Later">
            <ul className="divide-y divide-border border-y border-border">
              {later.map((item) => (
                <li key={item.id} className="grid gap-0.5 py-2.5">
                  <p className="text-small">{item.title}</p>
                  {item.detail ? (
                    <p className="text-caption text-pretty text-muted-foreground">{item.detail}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {path.done.length > 0 ? (
          <Section title="Done">
            <ul className="grid gap-2">
              {path.done.map((step) => (
                <li key={step.id}>
                  <StepCard {...card} step={step} expanded={false} label="Done" />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {editable || path.arc.length > 0 ? (
          <Section title={editable ? 'Your story' : 'Story'}>
            <Story arc={path.arc} tenant={tenant} ventureId={ventureId} canOpenConversations={editable} />
          </Section>
        ) : null}
        <Intake ventureId={ventureId} intake={path.intake} editable={editable} />
      </div>
    </div>
  );
}

/** What the founder told the mentor about themselves and the idea: read here by everyone, edited by the team. */
function Intake({
  ventureId,
  intake,
  editable,
}: {
  ventureId: string;
  intake: PathIntake | null;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const rows = intakeRows(intake ?? EMPTY_INTAKE);
  if (!editable && rows.length === 0) return null;
  return (
    <Section
      title={editable ? 'About you' : 'About the founder'}
      actions={
        editable && !editing ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(true);
            }}
          >
            {rows.length > 0 ? 'Edit' : 'Add'}
          </Button>
        ) : null
      }
    >
      {editing ? (
        <IntakeForm
          ventureId={ventureId}
          initial={intake}
          fields="all"
          cancelLabel="Cancel"
          onSaved={() => {
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : rows.length > 0 ? (
        <dl data-slot="intake" className="grid gap-2.5 text-small">
          {rows.map(([term, value]) => (
            <div key={term} className="grid gap-0.5">
              <dt className="text-caption text-muted-foreground">{term}</dt>
              <dd className="text-pretty [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-small text-muted-foreground">Nothing added yet.</p>
      )}
    </Section>
  );
}

function intakeRows(intake: PathIntake): [string, string][] {
  const rows: [string, string | null][] = [
    ['Idea', intake.idea],
    ['For', intake.customer],
    ['Studies', intake.studies],
    ['Experience', intake.experience ? EXPERIENCE_LABELS[intake.experience] : null],
    ['Hours a week', intake.hoursPerWeek === null ? null : String(intake.hoursPerWeek)],
    ['Deadline', intake.deadline ? `${intake.deadline.what}, ${longDay(intake.deadline.on)}` : null],
    ['Done so far', intake.doneSoFar],
    ['In the way', intake.block],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}
