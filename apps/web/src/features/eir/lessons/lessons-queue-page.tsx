import type { LessonView, PersonaView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Lightbulb } from 'lucide-react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { DistilledBadge, LessonStatusBadge } from '@/features/eir/personas/lesson-labels';
import { useLessonsToReview, usePersonas } from '@/lib/api/hooks/eir';
import { formatNumber, formatRelative, pluralize } from '@/lib/format';
import { veirName } from '@/lib/veir';

function PersonaGroup({
  tenant,
  persona,
  lessons,
}: {
  tenant: string;
  persona: PersonaView;
  lessons: readonly LessonView[];
}) {
  const headingId = `lessons-${persona.id}`;
  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <h2 id={headingId} className="flex items-center gap-2.5 text-body font-medium">
        <PersonaAvatar
          name={veirName(persona.name, persona.kind, persona.eirProfile?.displayName)}
          size="sm"
          decorative
        />
        {persona.name}
        <span className="tabular text-small font-normal text-muted-foreground">{lessons.length}</span>
      </h2>
      <ul className="divide-y divide-border border-y border-border">
        {lessons.map((lesson) => (
          <li key={lesson.id} className="relative grid gap-1 py-3.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link
                to="/$tenant/app/eir/personas/$personaId"
                params={{ tenant, personaId: persona.id }}
                search={{ tab: 'lessons', lesson: lesson.id }}
                className="min-w-0 truncate text-body font-medium underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {lesson.title}
              </Link>
              {lesson.origin === 'distilled' ? <DistilledBadge /> : null}
              <LessonStatusBadge status={lesson.status} />
            </div>
            <p className="line-clamp-1 text-small text-muted-foreground">{lesson.context}</p>
            <p className="text-caption text-muted-foreground">
              Created <time dateTime={lesson.createdAt}>{formatRelative(lesson.createdAt)}</time>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * EIR studio → Lessons to review: lessons waiting for review in every vEIR the person curates, distilled from
 * conversations or written by a colleague, fetched in one request and grouped by vEIR. Each opens in its vEIR's
 * Lessons section.
 */
export function LessonsQueuePage({ tenant }: { tenant: string }) {
  const personas = usePersonas();
  const queue = useLessonsToReview();
  const curated = (personas.data ?? []).filter((p) => p.canCurate === true && p.status !== 'retired');
  const loading = personas.isPending || queue.isPending;
  const lessons = queue.data?.items ?? [];
  // In the order the vEIRs are listed; the server sends only lessons of vEIRs the person curates.
  const groups = curated
    .map((persona) => ({ persona, lessons: lessons.filter((lesson) => lesson.personaId === persona.id) }))
    .filter((group) => group.lessons.length > 0);
  const total = queue.data?.total ?? 0;
  const shown = groups.reduce((sum, g) => sum + g.lessons.length, 0);
  const error = personas.error ?? queue.error;

  return (
    <PageContainer size="narrow">
      <PageHeader
        title="Lessons to review"
        description={
          loading || total === 0
            ? undefined
            : `${pluralize(total, 'lesson')} waiting for you.${shown < total ? ` The ${formatNumber(shown)} most recent are shown.` : ''}`
        }
      />
      {loading ? (
        <LoadingRegion label="Loading lessons">
          <Skeleton className="h-48 rounded-xl" />
        </LoadingRegion>
      ) : error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void personas.refetch();
            void queue.refetch();
          }}
          retrying={personas.isRefetching || queue.isRefetching}
        />
      ) : curated.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No vEIRs to curate"
          description="Lessons appear here for the vEIRs built from you, or for every vEIR if you lead the program."
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="Nothing to review"
          description="New drafts appear here as conversations are distilled."
        />
      ) : (
        <div className="grid gap-10">
          {groups.map(({ persona, lessons: items }) => (
            <PersonaGroup key={persona.id} tenant={tenant} persona={persona} lessons={items} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
