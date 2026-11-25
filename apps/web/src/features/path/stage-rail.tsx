import type { PathStageView, VenturePath } from '@foundry/contracts';
import { Check, Circle, CircleCheck, CircleDot, type LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '@/lib/utils';

import { longDay } from './due';
import { CRITERION_LABELS, reportedEvidence } from './plan';

const CRITERION_ICON: Record<
  PathStageView['criteria'][number]['status'],
  { icon: LucideIcon; tone: string }
> = {
  open: { icon: Circle, tone: 'text-muted-foreground' },
  claimed: { icon: CircleDot, tone: 'text-warning' },
  met: { icon: CircleCheck, tone: 'text-success' },
};

/** The seven stages in order, the current one open on what it asks to be shown; any other opens with a press. */
export function StageRail({ path }: { path: VenturePath }) {
  return (
    <ol aria-label="Stages" data-slot="stage-rail" className="grid">
      {path.stages.map((stage, index) => (
        <StageRow
          key={stage.stage}
          stage={stage}
          number={index + 1}
          last={index === path.stages.length - 1}
          path={path}
        />
      ))}
    </ol>
  );
}

function StageRow({
  stage,
  number,
  last,
  path,
}: {
  stage: PathStageView;
  number: number;
  last: boolean;
  path: VenturePath;
}) {
  const id = useId();
  const current = stage.status === 'current';
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? current;
  return (
    <li
      aria-current={current ? 'step' : undefined}
      data-status={stage.status}
      className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 pb-1"
    >
      {last ? null : (
        <span
          aria-hidden
          className={cn(
            'absolute top-8 bottom-0 left-3.5 w-px -translate-x-1/2',
            stage.status === 'done' ? 'bg-foreground/50' : 'bg-border-strong',
          )}
        />
      )}
      <span
        aria-hidden
        className={cn(
          'tabular mt-1 flex size-7 items-center justify-center rounded-full border text-caption font-medium',
          stage.status === 'done' && 'border-transparent bg-muted text-foreground',
          current && 'border-transparent bg-foreground text-background',
          stage.status === 'ahead' && 'border-border-strong text-muted-foreground',
        )}
      >
        {stage.status === 'done' ? <Check className="size-3.5" /> : number}
      </span>
      <div className="min-w-0">
        <h3 className="m-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? `${id}-body` : undefined}
            onClick={() => {
              setChosen(!open);
            }}
            className={cn(
              'flex min-h-9 w-full items-center rounded-md px-1.5 text-left text-small transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11',
              current ? 'font-semibold' : 'text-muted-foreground',
            )}
          >
            <span className="sr-only">
              Stage {number}, {stage.status === 'done' ? 'done' : current ? 'current' : 'ahead'}:{' '}
            </span>
            {stage.title}
          </button>
        </h3>
        {open ? (
          <div id={`${id}-body`} className="grid gap-3 px-1.5 pt-0.5 pb-4">
            <p className="text-small text-pretty text-muted-foreground">{stage.goal}</p>
            <ul aria-label={`What ${stage.title} asks for`} className="grid gap-3">
              {stage.criteria.map((criterion) => {
                const mark = CRITERION_ICON[criterion.status];
                const reports = reportedEvidence(path, criterion.id);
                return (
                  <li key={criterion.id} data-slot="criterion" className="flex items-start gap-2">
                    <mark.icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', mark.tone)} />
                    <div className="grid min-w-0 gap-0.5">
                      <p className="text-small font-medium text-pretty">
                        {criterion.title}{' '}
                        <span className="font-normal text-muted-foreground">
                          · {CRITERION_LABELS[criterion.status]}
                        </span>
                      </p>
                      <p className="text-caption text-pretty text-muted-foreground">{criterion.evidence}</p>
                      {reports.map((step) => (
                        <p key={step.id} className="text-caption text-pretty" data-slot="criterion-report">
                          “{step.evidence}”
                          {step.completedAt ? (
                            <span className="text-muted-foreground"> · {longDay(step.completedAt)}</span>
                          ) : null}
                        </p>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}
