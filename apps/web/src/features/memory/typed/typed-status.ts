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

import type { ExperimentStatus, MilestoneStatus } from './attributes';

interface Def {
  label: string;
  icon: LucideIcon;
}

/** Stages of an experiment, as offered in its editor. */
export const EXPERIMENT_STATUS_DEFS: Record<ExperimentStatus, Def> = {
  planned: { label: 'Planned', icon: CircleDashed },
  running: { label: 'Running', icon: LoaderCircle },
  completed: { label: 'Completed', icon: CircleCheck },
  abandoned: { label: 'Abandoned', icon: CircleSlash },
};

/** Stages of a milestone, as offered in its editor. */
export const MILESTONE_STATUS_DEFS: Record<MilestoneStatus, Def> = {
  planned: { label: 'Planned', icon: CircleDashed },
  in_progress: { label: 'In progress', icon: CircleDot },
  at_risk: { label: 'At risk', icon: TriangleAlert },
  done: { label: 'Done', icon: CircleCheck },
  missed: { label: 'Missed', icon: CircleX },
};
