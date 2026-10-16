import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { cn } from '@/lib/utils';

import { PROGRESS_STATUS_TEXT, progressAnnouncement, progressStepLabel, type TurnProgress } from './progress';

/**
 * One quiet line while a turn is answered: the step in progress with a spinner ("Retrieving evidence
 * (6)"). The full four-step list stays in the accessibility tree, each step with its status word, and
 * changes are announced politely through the global live region (content-free messages).
 */
export function TurnProgressList({ progress, className }: { progress: TurnProgress; className?: string }) {
  // Step changes are announced here; terminal outcomes are announced by the conversation page, which
  // outlives this list (it unmounts as soon as the finished turn joins the transcript).
  const message = progress.outcome === 'running' ? progressAnnouncement(progress) : null;
  const lastAnnounced = useRef<string | null>(null);

  useEffect(() => {
    if (message && message !== lastAnnounced.current) {
      lastAnnounced.current = message;
      announce(message);
    }
  }, [message]);

  const running = progress.outcome === 'running';
  return (
    <ol aria-label="Response progress" data-testid="turn-progress" className={cn('text-small', className)}>
      {progress.steps.map((step) => {
        const visible = running && step.status === 'active';
        return (
          <li
            key={step.id}
            aria-current={step.status === 'active' ? 'step' : undefined}
            data-status={step.status}
            className={visible ? 'flex items-center gap-2 text-muted-foreground' : 'sr-only'}
          >
            {visible ? (
              <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
            ) : null}
            <span>{progressStepLabel(step)}</span>
            <span className="sr-only"> — {PROGRESS_STATUS_TEXT[step.status]}</span>
          </li>
        );
      })}
    </ol>
  );
}
