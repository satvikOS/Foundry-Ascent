import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import { humaniseValue, type ExperimentStatus, type MilestoneStatus } from './attributes';

interface Def {
  label: string;
  icon: LucideIcon;
  className: string;
}

export const EXPERIMENT_STATUS_DEFS: Record<ExperimentStatus, Def> = {
  planned: {
    label: 'Planned',
    icon: CircleDashed,
    className: 'border-dashed border-border-strong text-muted-foreground',
  },
  running: { label: 'Running', icon: LoaderCircle, className: 'border-info/45 bg-info/10 text-info' },
  completed: {
    label: 'Completed',
    icon: CircleCheck,
    className: 'border-success/45 bg-success/10 text-success',
  },
  abandoned: {
    label: 'Abandoned',
    icon: CircleSlash,
    className: 'border-dotted border-border-strong text-muted-foreground',
  },
};

export const MILESTONE_STATUS_DEFS: Record<MilestoneStatus, Def> = {
  planned: {
    label: 'Planned',
    icon: CircleDashed,
    className: 'border-dashed border-border-strong text-muted-foreground',
  },
  in_progress: { label: 'In progress', icon: CircleDot, className: 'border-info/45 bg-info/10 text-info' },
  at_risk: {
    label: 'At risk',
    icon: TriangleAlert,
    className: 'border-warning/45 bg-warning/10 text-warning',
  },
  done: { label: 'Done', icon: CircleCheck, className: 'border-success/45 bg-success/10 text-success' },
  missed: {
    label: 'Missed',
    icon: CircleX,
    className: 'border-destructive/45 bg-destructive/10 text-destructive',
  },
};

/** Lifecycle chip for typed memory attributes: icon + label + border style (never colour alone). */
export function TypedStatusBadge({
  kind,
  status,
  className,
}: {
  kind: 'experiment' | 'milestone';
  status: string | undefined;
  className?: string;
}) {
  const defs: Record<string, Def | undefined> =
    kind === 'experiment' ? EXPERIMENT_STATUS_DEFS : MILESTONE_STATUS_DEFS;
  const def: Def = (status ? defs[status] : undefined) ?? {
    label: status ? humaniseValue(status) : 'No status',
    icon: CircleDashed,
    className: 'border-dotted border-border-strong text-muted-foreground',
  };
  const Icon = def.icon;
  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap',
        def.className,
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {def.label}
    </span>
  );
}
