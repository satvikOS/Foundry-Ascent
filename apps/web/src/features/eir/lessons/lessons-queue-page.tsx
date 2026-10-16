import type { LessonView, PersonaView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Lightbulb } from 'lucide-react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { DistilledBadge, LessonStatusBadge, needsReview } from '@/features/eir/personas/lesson-labels';
import { usePersonas } from '@/lib/api/hooks/eir';
import { useLessonsOfPersonas } from '@/lib/api/hooks/veir-pools';
import { formatRelative, pluralize } from '@/lib/format';
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
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {lessons.map((lesson) => (
          <li key={lesson.id} className="relative grid gap-1 px-4 py-3.5 hover:bg-accent/40">
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
 * EIR studio → Lessons to review: draft lessons of every vEIR the person curates, distilled from
 * conversations or written by a colleague. Each opens in its vEIR's Lessons section.
 */
export function LessonsQueuePage({ tenant }: { tenant: string }) {
  const personas = usePersonas();
  const curated = (personas.data ?? []).filter((p) => p.canCurate === true && p.status !== 'retired');
  const results = useLessonsOfPersonas(curated.map((p) => p.id));
  const loading = personas.isPending || results.some((r) => r.isPending);
  const groups = curated
    .map((persona, index) => ({
      persona,
      result: results[index],
      lessons: (results[index]?.data?.items ?? []).filter(needsReview),
    }))
    .filter((group) => group.result?.isError === true || group.lessons.length > 0);
  const total = groups.reduce((sum, g) => sum + g.lessons.length, 0);

  return (
    <PageContainer size="narrow">
      <PageHeader
        title="Lessons to review"
        description={loading || total === 0 ? undefined : `${pluralize(total, 'lesson')} waiting for you.`}
      />
      {loading ? (
        <LoadingRegion label="Loading lessons">
          <Skeleton className="h-48 rounded-xl" />
        </LoadingRegion>
      ) : personas.isError ? (
        <ErrorState
          error={personas.error}
          onRetry={() => void personas.refetch()}
          retrying={personas.isRefetching}
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
          {groups.map(({ persona, result, lessons }) =>
            result?.isError ? (
              <ErrorState
                key={persona.id}
                size="sm"
                title={`Couldn’t load ${persona.name}’s lessons`}
                error={result.error}
                onRetry={() => void result.refetch()}
              />
            ) : (
              <PersonaGroup key={persona.id} tenant={tenant} persona={persona} lessons={lessons} />
            ),
          )}
        </div>
      )}
    </PageContainer>
  );
}
