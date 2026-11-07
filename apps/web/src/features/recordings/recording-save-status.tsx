import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { RecordingSession } from './recording-session';
import { useRecordingState, useWatchRecording } from './use-call-recording';

const action =
  'fa-call-focus inline-flex min-h-8 items-center rounded-full px-3 font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground';

/**
 * The recording's save, in the call screen above its controls (a toast says it once the screen is closed:
 * useCallRecordingLifecycle). Saving with its progress; then "Recording saved" with Watch (the call goes on,
 * minimized, while the recording opens), which goes by itself after a moment; or why it was not saved, with Try again
 * and Discard. Inside the screen, so it can be clicked, and above the controls, so it never covers End.
 */
export function RecordingSaveStatus({ session, tenant }: { session: RecordingSession; tenant: string }) {
  const state = useRecordingState(session);
  const watch = useWatchRecording(tenant);
  if (state.status === 'idle' || state.status === 'recording') return null;
  const shell =
    'glass flex min-h-11 max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-3xl border border-(--glass-border) py-1.5 pr-1.5 pl-4 text-small text-popover-foreground';
  if (state.status === 'saving') {
    return (
      <div data-slot="recording-save" data-state="saving" className={cn(shell, 'pr-4')}>
        <LoaderCircle aria-hidden className="size-4 animate-spin text-muted-foreground" />
        <span>
          Saving the recording…
          {state.percent === null ? null : (
            <span className="tabular text-muted-foreground"> {state.percent}%</span>
          )}
        </span>
      </div>
    );
  }
  if (state.status === 'saved') {
    const { recording } = state;
    return (
      <div
        role="group"
        aria-label="Recording saved"
        data-slot="recording-save"
        data-state="saved"
        className={shell}
      >
        <CircleCheck aria-hidden className="size-4 text-success" />
        <span>
          Recording saved<span className="text-muted-foreground"> · Only you can watch it.</span>
        </span>
        <button
          type="button"
          className={action}
          onClick={() => {
            session.dismiss();
            watch(recording);
          }}
        >
          Watch
        </button>
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={state.title}
      data-slot="recording-save"
      data-state="failed"
      className={shell}
    >
      <CircleAlert aria-hidden className="size-4 text-destructive" />
      <span>
        {state.title}
        <span className="text-muted-foreground"> · {state.message}</span>
      </span>
      {state.canRetry ? (
        <>
          <button
            type="button"
            className={action}
            onClick={() => {
              void session.retry();
            }}
          >
            Try again
          </button>
          <button
            type="button"
            className={cn(action, 'text-muted-foreground')}
            onClick={() => {
              session.dismiss();
            }}
          >
            Discard
          </button>
        </>
      ) : (
        <button
          type="button"
          className={cn(action, 'text-muted-foreground')}
          onClick={() => {
            session.dismiss();
          }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
