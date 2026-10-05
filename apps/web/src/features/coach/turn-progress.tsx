import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  LoaderCircle,
  OctagonX,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { cn } from '@/lib/utils';

import {
  PROGRESS_STATUS_TEXT,
  progressAnnouncement,
  progressStepLabel,
  type ProgressStepStatus,
  type TurnProgress,
} from './progress';

const STATUS_ICON: Record<ProgressStepStatus, LucideIcon> = {
  pending: CircleDashed,
  active: LoaderCircle,
  done: CircleCheck,
  stopped: OctagonX,
  skipped: CircleMinus,
};

/**
 * Accessible step list for a streaming turn. Each step shows an icon AND a status word for screen
 * readers; changes are announced politely through the global live region (content-free messages).
 */
export function TurnProgressList({ progress, className }: { progress: TurnProgress; className?: string }) {
  // Step changes are announced here; terminal outcomes are announced by the session canvas, which
  // outlives this list (it unmounts as soon as the finished turn joins the transcript).
  const message = progress.outcome === 'running' ? progressAnnouncement(progress) : null;
  const lastAnnounced = useRef<string | null>(null);

  useEffect(() => {
    if (message && message !== lastAnnounced.current) {
      lastAnnounced.current = message;
      announce(message);
    }
  }, [message]);

  return (
    <ol
      aria-label="Response progress"
      data-testid="turn-progress"
      className={cn('flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4', className)}
    >
      {progress.steps.map((step) => {
        const Icon = STATUS_ICON[step.status];
        return (
          <li
            key={step.id}
            aria-current={step.status === 'active' ? 'step' : undefined}
            data-status={step.status}
            className={cn(
              'flex items-center gap-1.5 text-[13px]',
              step.status === 'active' && 'font-medium text-foreground',
              step.status === 'done' && 'text-foreground',
              (step.status === 'pending' || step.status === 'skipped') && 'text-subtle-foreground',
              step.status === 'stopped' && 'text-destructive',
            )}
          >
            <Icon
              aria-hidden
              className={cn('size-4 shrink-0', step.status === 'active' && 'motion-safe:animate-spin')}
            />
            <span>{progressStepLabel(step)}</span>
            <span className="sr-only"> — {PROGRESS_STATUS_TEXT[step.status]}</span>
          </li>
        );
      })}
    </ol>
  );
}
