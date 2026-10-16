import type { LessonView, PersonaView } from '@foundry/contracts';
import { Lightbulb, Plus } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePersonaLessons } from '@/lib/api/hooks/veir-pools';

import { DistilledBadge, LessonStatusBadge, needsReview } from './lesson-labels';
import { LessonSheet } from './lesson-sheet';

type LessonFilter = 'review' | 'published' | 'withdrawn';

const FILTERS: { value: LessonFilter; label: string; match: (lesson: LessonView) => boolean }[] = [
  { value: 'review', label: 'To review', match: needsReview },
  { value: 'published', label: 'Published', match: (l) => l.status === 'published' },
  { value: 'withdrawn', label: 'Withdrawn', match: (l) => l.status === 'withdrawn' },
];

interface LessonsTabProps {
  persona: PersonaView;
  shortName: string;
  /** The lesson open in the sheet (kept in the URL so the review queue can link to it). */
  openLessonId: string | undefined;
  onOpenLessonChange: (lessonId: string | undefined) => void;
}

/**
 * Lessons: generalised, de-identified patterns in the vEIR's common pool. Distillation proposes drafts;
 * the curators edit, publish or withdraw them. Only published lessons are retrieved.
 */
export function LessonsTab({ persona, shortName, openLessonId, onOpenLessonChange }: LessonsTabProps) {
  const lessons = usePersonaLessons(persona.id);
  const [chosen, setChosen] = useState<LessonFilter | null>(null);
  const [creating, setCreating] = useState(false);
  const canCurate = persona.canCurate === true && persona.status !== 'retired';

  if (lessons.isPending) {
    return (
      <LoadingRegion label="Loading lessons">
        <Skeleton className="h-56 rounded-xl" />
      </LoadingRegion>
    );
  }
  if (lessons.isError) {
    return (
      <ErrorState
        error={lessons.error}
        onRetry={() => void lessons.refetch()}
        retrying={lessons.isRefetching}
      />
    );
  }

  const all = lessons.data;
  const toReview = all.filter(needsReview).length;
  // Open on what needs attention; otherwise on what the vEIR uses.
  const filter = chosen ?? (toReview > 0 ? 'review' : 'published');
  const def = FILTERS.find((f) => f.value === filter) ?? FILTERS[0];
  const shown = def ? all.filter(def.match) : all;
  const open = openLessonId ? (all.find((l) => l.id === openLessonId) ?? null) : null;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter lessons" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const count = all.filter(f.match).length;
            const selected = f.value === filter;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setChosen(f.value);
                }}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-small transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  selected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
              >
                {f.label}
                <span className="tabular text-caption opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
        {canCurate ? (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus aria-hidden />
            New lesson
          </Button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          size="sm"
          headingLevel={2}
          title={
            filter === 'review'
              ? 'Nothing to review'
              : filter === 'published'
                ? 'No published lessons'
                : 'Nothing withdrawn'
          }
          description={
            filter === 'published'
              ? `Published lessons are what ${shortName} learned across conversations, without names.`
              : undefined
          }
        />
      ) : (
        <ul aria-label="Lessons" className="divide-y divide-border rounded-xl border border-border bg-card">
          {shown.map((lesson) => (
            <li key={lesson.id} className="grid gap-1 px-4 py-3.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-body font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    onOpenLessonChange(lesson.id);
                  }}
                >
                  {lesson.title}
                </button>
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
      )}

      <LessonSheet
        personaId={persona.id}
        shortName={shortName}
        canCurate={canCurate}
        state={creating ? { mode: 'create' } : open ? { mode: 'open', lesson: open } : { mode: 'closed' }}
        onClose={() => {
          setCreating(false);
          onOpenLessonChange(undefined);
        }}
      />
    </div>
  );
}
