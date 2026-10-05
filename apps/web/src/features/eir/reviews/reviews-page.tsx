import { CircleCheck, CircleDashed, ClipboardCheck, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { useReviewQueue, useSubmitReview, type ReviewSampleView } from '@/lib/api/hooks/eir';
import { hasRole } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate } from '@/lib/format';
import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { RubricForm } from './rubric-form';
import { StructuredResponse } from './structured-response';

export type ReviewFilter = 'pending' | 'reviewed';

interface ReviewsPageProps {
  selectedTurnId: string | undefined;
  filter: ReviewFilter;
  onSelect: (turnId: string | undefined) => void;
  onFilterChange: (filter: ReviewFilter) => void;
}

/**
 * EIR studio → Calibration reviews. Sampled turns from assigned ventures are scored blind: no
 * founder identity, session, model or cost is shown — only the founder's message, the coach's
 * structured response and its evidence.
 */
export function ReviewsPage({ selectedTurnId, filter, onSelect, onFilterChange }: ReviewsPageProps) {
  const me = useRequiredMe();
  // Calibration reviews belong to EIRs assigned to ventures; program leads use the studio for personas.
  const isEir = hasRole(me, 'eir');
  const queue = useReviewQueue({ enabled: isEir });
  const submit = useSubmitReview();
  const detailRef = useRef<HTMLDivElement | null>(null);

  const samples = useMemo(() => queue.data ?? [], [queue.data]);
  const pending = samples.filter((s) => !s.reviewed);
  const reviewed = samples.filter((s) => s.reviewed);
  const visible = filter === 'pending' ? pending : reviewed;
  const selected = samples.find((s) => s.turn.id === selectedTurnId) ?? visible[0];
  const ordinal = (sample: ReviewSampleView) => samples.indexOf(sample) + 1;

  // Clear a stale/unknown selection from the URL once the queue has loaded.
  useEffect(() => {
    if (queue.isSuccess && selectedTurnId && !samples.some((s) => s.turn.id === selectedTurnId)) {
      onSelect(undefined);
    }
  }, [queue.isSuccess, samples, selectedTurnId, onSelect]);

  const select = (sample: ReviewSampleView) => {
    onSelect(sample.turn.id);
    requestAnimationFrame(() => {
      detailRef.current?.focus();
    });
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Calibration reviews"
        description="Score sampled coach turns from your assigned ventures. Reviews are blind: you see the question, the answer and its evidence — not who asked."
      >
        {isEir ? (
          <Tabs
            value={filter}
            onValueChange={(value) => {
              onFilterChange(value === 'reviewed' ? 'reviewed' : 'pending');
            }}
          >
            <TabsList aria-label="Review queue">
              <TabsTrigger value="pending">
                <CircleDashed aria-hidden />
                To review{' '}
                <span className="tabular text-muted-foreground">{queue.isSuccess ? pending.length : ''}</span>
              </TabsTrigger>
              <TabsTrigger value="reviewed">
                <CircleCheck aria-hidden />
                Reviewed{' '}
                <span className="tabular text-muted-foreground">
                  {queue.isSuccess ? reviewed.length : ''}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </PageHeader>

      {!isEir ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Reviews are scored by EIRs"
          description="Sampled coach answers are reviewed blind by the EIRs assigned to each venture. Your role can manage personas and route escalations; ask a platform admin for the EIR role if you review turns."
        />
      ) : queue.isPending ? (
        <LoadingRegion label="Loading review queue">
          <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-96 rounded-xl" />
          </div>
        </LoadingRegion>
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} retrying={queue.isRefetching} />
      ) : samples.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No samples to review"
          description="Samples appear when your assigned ventures have coaching sessions. Check back later."
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[18rem_1fr]">
          <nav aria-label={filter === 'pending' ? 'Samples to review' : 'Reviewed samples'}>
            {visible.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted-foreground">
                {filter === 'pending' ? 'All caught up — every sample is reviewed.' : 'Nothing reviewed yet.'}
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {visible.map((sample) => {
                  const isSelected = sample === selected;
                  return (
                    <li key={sample.turn.id}>
                      <button
                        type="button"
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={() => {
                          select(sample);
                        }}
                        className={cn(
                          'grid w-full gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors',
                          'hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-ring',
                          isSelected ? 'border-foreground bg-accent' : 'border-border bg-card',
                        )}
                      >
                        <span className="flex items-center justify-between gap-2 text-sm font-medium">
                          Sample {ordinal(sample)}
                          {sample.reviewed ? (
                            <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                              <CircleCheck aria-hidden className="size-3.5" />
                              Reviewed
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[13px] text-muted-foreground">
                          {sample.ventureName} · {MODE_LABELS[sample.turn.mode].label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(sample.turn.createdAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>

          {selected ? (
            <div
              ref={detailRef}
              tabIndex={-1}
              aria-labelledby="review-sample-title"
              role="region"
              className="grid gap-6 outline-none xl:grid-cols-[1fr_22rem]"
            >
              <SectionCard
                title={<span id="review-sample-title">Sample {ordinal(selected)}</span>}
                description={`${selected.ventureName} · ${MODE_LABELS[selected.turn.mode].label} mode · ${formatDate(selected.turn.createdAt)}`}
                icon={EyeOff}
              >
                <StructuredResponse turn={selected.turn} />
              </SectionCard>
              <SectionCard
                title="Rubric"
                description="1 = poor · 5 = excellent"
                icon={ClipboardCheck}
                className="xl:sticky xl:top-36"
              >
                {selected.reviewed ? (
                  <Alert variant="success" title="You reviewed this sample">
                    Your scores are recorded with this calibration set.
                  </Alert>
                ) : (
                  <RubricForm
                    key={selected.turn.id}
                    submitting={submit.isPending}
                    footer={<MutationErrorAlert error={submit.error} title="Your review wasn’t submitted" />}
                    onSubmit={(review) => {
                      const turnId = selected.turn.id;
                      submit.mutate(
                        { turnId, review },
                        {
                          onSuccess: () => {
                            toast.success('Review submitted');
                            announce('Review submitted');
                            const next = pending.find((s) => s.turn.id !== turnId);
                            onSelect(next?.turn.id);
                          },
                        },
                      );
                    }}
                  />
                )}
              </SectionCard>
            </div>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
