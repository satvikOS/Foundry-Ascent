import { Circle, Square } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatClock, spokenDuration } from '@/features/calls/use-call-clock';
import { cn } from '@/lib/utils';

import { canShareScreen } from './call-recorder';
import { RecordingNoticeDialog } from './recording-notice';
import './recordings.css';
import { useRecordingNotice } from './recording-notice-store';
import { DAILY_LIMIT_TEXT, type RecordingSession } from './recording-session';
import {
  RECORD_BLOCKER_TEXT,
  useElapsedSeconds,
  useRecordingState,
  type RecordBlocker,
} from './use-call-recording';

/** Starts the recording, after its notice the first time; the notice's choice is remembered per person. */
export function useStartRecording(session: RecordingSession, principalId: string) {
  const [seen, acknowledge] = useRecordingNotice(principalId);
  const [asking, setAsking] = useState(false);
  return {
    asking,
    request: () => {
      if (seen) session.start();
      else setAsking(true);
    },
    confirm: () => {
      acknowledge();
      setAsking(false);
      session.start();
    },
    cancel: () => {
      setAsking(false);
    },
  };
}

const UNSAVED_TEXT = 'Save or discard the last recording first.';

interface RecordControlProps {
  session: RecordingSession;
  /** Why this call cannot be recorded (the control shows, disabled, with the reason), or null. */
  blocker: RecordBlocker;
  principalId: string;
  /** The vEIR's name (the notice names it). */
  name: string;
  video: boolean;
  /** The whole call screen is disabled (ending). */
  disabled?: boolean;
}

/**
 * The call's Record control, between the microphone and End: Record (after a short notice the first time), Cancel while
 * the browser asks which screen to share, then a red dot with the recording's time and Stop. Hanging up stops and saves
 * it too. A call that cannot be recorded (a private call, a browser that cannot) keeps the control, disabled, with the
 * reason as its description.
 */
export function RecordControl({
  session,
  blocker,
  principalId,
  name,
  video,
  disabled = false,
}: RecordControlProps) {
  const state = useRecordingState(session);
  const start = useStartRecording(session, principalId);
  const reasonId = useId();
  const recording = state.status === 'recording';
  const seconds = useElapsedSeconds(recording ? state.startedAt : null);
  const saving = state.status === 'saving';
  // The browser asks which screen to share.
  const starting = state.status === 'starting';
  const screen = useMemo(() => canShareScreen(), []);
  // A take whose save failed waits to be saved or discarded (above the controls) before another can start.
  const unsaved = state.status === 'failed' && state.canRetry;
  // Today's recordings are used up (a save said so): another could not be saved either.
  const limited = !recording && session.limitReached();
  const blocked = (blocker !== null || unsaved || limited) && !recording;
  const reason =
    blocker !== null
      ? RECORD_BLOCKER_TEXT[blocker]
      : unsaved
        ? UNSAVED_TEXT
        : limited
          ? DAILY_LIMIT_TEXT
          : null;

  const toggle = () => {
    if (blocked || disabled || saving) return;
    // Stop saves the take; Cancel, while the browser asks, records nothing.
    if (recording || starting) void session.stop();
    else start.request();
  };

  return (
    <>
      <SimpleTooltip
        content={
          recording
            ? 'Stop and save the recording'
            : starting
              ? 'Cancel the recording'
              : (reason ?? 'Record this call')
        }
      >
        <button
          type="button"
          data-slot="record-control"
          data-recording={recording || undefined}
          onClick={toggle}
          aria-pressed={recording}
          aria-disabled={blocked || disabled || saving || undefined}
          aria-describedby={blocked ? reasonId : undefined}
          aria-keyshortcuts="R"
          // While it records, the name is what the button shows ("0:42 Stop", then "recording" for a screen reader):
          // a voice-control user says what they see. The time is described in words.
          aria-label={
            recording
              ? undefined
              : saving
                ? 'Saving the recording'
                : starting
                  ? 'Cancel the recording'
                  : 'Record'
          }
          aria-description={recording ? `${spokenDuration(seconds)} recorded` : undefined}
          className={cn(
            'fa-call-control fa-call-focus relative inline-flex h-12 min-w-28 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors duration-150',
            (blocked || disabled || saving) && 'cursor-not-allowed opacity-50',
          )}
        >
          {recording ? (
            <>
              <span aria-hidden className="fa-rec-dot size-2.5 rounded-full bg-destructive" />
              <span className="tabular">{formatClock(seconds)}</span>{' '}
              <Square aria-hidden className="size-3.5 fill-current" />
              <span>
                Stop <span className="sr-only">recording</span>
              </span>
            </>
          ) : saving ? (
            <span aria-hidden>Saving…</span>
          ) : starting ? (
            <span aria-hidden>Cancel</span>
          ) : (
            <>
              <Circle aria-hidden className="size-3.5 fill-current text-destructive" />
              <span aria-hidden>Record</span>
            </>
          )}
        </button>
      </SimpleTooltip>
      {blocked && reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
      <RecordingNoticeDialog
        open={start.asking}
        name={name}
        video={video}
        screen={screen}
        onConfirm={start.confirm}
        onCancel={start.cancel}
      />
    </>
  );
}

/**
 * "● REC 0:42" beside the call's time while it records: in the call screen's header (the dock's Stop says the rest) and
 * in the mini call bar while the call is minimized. `compact`: on a phone only "● REC", so the line keeps its room for
 * the time left (and its warning near the end).
 */
export function RecordingMark({
  session,
  separator = false,
  compact = false,
}: {
  session: RecordingSession;
  separator?: boolean;
  compact?: boolean;
}) {
  const state = useRecordingState(session);
  const recording = state.status === 'recording';
  const seconds = useElapsedSeconds(recording ? state.startedAt : null);
  if (!recording) return null;
  return (
    <span
      data-testid="recording-indicator"
      className="inline-flex items-center gap-1.5 font-medium text-destructive"
    >
      {separator ? (
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
      ) : null}
      <span aria-hidden className="fa-rec-dot size-2 rounded-full bg-destructive" />
      <span aria-hidden>REC</span>
      <span aria-hidden className={cn('tabular', compact && 'hidden sm:inline')}>
        {formatClock(seconds)}
      </span>
      <span className="sr-only">Recording</span>
    </span>
  );
}
