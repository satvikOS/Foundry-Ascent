import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { RecordingView } from '@foundry/contracts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { queryKeys } from '@/lib/api/query-keys';
import { saveRecording } from '@/lib/api/hooks/recording-upload';

import { canRecordCalls, requestScreen, sharesThisTab } from './call-recorder';
import { guardPageUnload } from './page-unload';
import {
  browserRecorder,
  recordingSessionFor,
  type RecordedEngine,
  type RecordedFace,
  type RecordingSession,
  type RecordingState,
} from './recording-session';

/** Why a call cannot be recorded (shown with the disabled control), or null when it can. */
export type RecordBlocker = 'private' | 'unsupported' | 'not_live' | null;

export const RECORD_BLOCKER_TEXT: Record<Exclude<RecordBlocker, null>, string> = {
  private: 'Private calls aren’t recorded.',
  unsupported: 'This browser can’t record calls.',
  not_live: 'Recording starts once the call is connected.',
};

const SAVE_TOAST = 'call-recording-save';

const BROWSER_DEPS = {
  createRecorder: browserRecorder,
  requestScreen,
  isThisTab: sharesThisTab,
  save: saveRecording,
  now: () => Date.now(),
  guardUnload: guardPageUnload,
};

/** The engine's recording (one per engine, shared by every part of the call screen). */
export function useRecordingSession(engine: RecordedEngine): RecordingSession {
  return useMemo(() => recordingSessionFor(engine, BROWSER_DEPS), [engine]);
}

export function useRecordingState(session: RecordingSession): RecordingState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

/** Seconds since `startedAt` (epoch ms), ticking once a second while `running`. */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** How long "Recording saved" stays in the call screen. */
export const SAVED_NOTICE_MS = 8_000;

/**
 * Opens a saved recording in its viewer, under the venture's Recordings (a live call goes on, minimized, and the replay
 * waits to be played: RecordingPlayer).
 */
export function useWatchRecording(tenant: string): (recording: RecordingView) => void {
  const navigate = useNavigate();
  return useCallback(
    (recording: RecordingView) => {
      void navigate({
        to: '/$tenant/app/v/$ventureId/recordings/$recordingId',
        params: { tenant, ventureId: recording.ventureId, recordingId: recording.id },
      });
    },
    [navigate, tenant],
  );
}

/**
 * Keeps the call's recording in step with the call screen (who it shows, the face, whether the screen is open: a
 * recording of this tab records it only then) and says what happens to it. While the call screen is open (`inCall`)
 * the screen itself shows the save (RecordingSaveStatus, above the controls): the screen is a modal, so nothing outside
 * it can be clicked, and a toast over it would hide End and pass its clicks through to it. Once the screen is closed
 * (minimized, or the call ended and it returned to the conversation) a toast says it instead: Saving, then Watch (its
 * conversation's list and Recordings are refreshed), or why it failed with Try again and Discard. Mounted once, by the
 * call screen, which stays mounted for the whole call.
 */
export function useCallRecordingLifecycle(
  session: RecordingSession,
  subject: {
    veirName: string;
    founderName: string;
    face: RecordedFace | null;
    tenant: string;
    /** The call screen is open and shows the call (and so the save). */
    inCall: boolean;
  },
): void {
  const client = useQueryClient();
  const state = useRecordingState(session);
  const { veirName, founderName, face, tenant, inCall } = subject;
  const watch = useWatchRecording(tenant);

  useEffect(() => {
    session.attach({ veirName, founderName, face });
  }, [session, veirName, founderName, face]);

  // Before the browser paints the page under a minimized call, so no frame of it reaches a recording of this tab.
  useLayoutEffect(() => {
    session.showing(inCall);
  }, [session, inCall]);

  useEffect(() => {
    session.onSaved = () => {
      void client.invalidateQueries({ queryKey: queryKeys.recordings.all() });
    };
    return () => {
      session.onSaved = null;
    };
  }, [client, session]);

  // Said once per change, wherever it is shown.
  const previous = useRef<RecordingState['status']>(state.status);
  useEffect(() => {
    const was = previous.current;
    previous.current = state.status;
    if (state.status === was) return;
    if (state.status === 'recording')
      announce(state.note === null ? 'Recording started' : `Recording started. ${state.note}`);
    else if (state.status === 'saving' && was === 'recording') announce('Recording stopped. Saving it.');
    else if (state.status === 'saved') announce('Recording saved');
    else if (state.status === 'failed') announce(state.title, 'assertive');
  }, [state]);

  // In the call screen, "Recording saved" goes after a moment (Record stays usable meanwhile).
  useEffect(() => {
    if (!inCall || state.status !== 'saved') return undefined;
    const timer = window.setTimeout(() => {
      if (session.getSnapshot() === state) session.dismiss();
    }, SAVED_NOTICE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inCall, session, state]);

  // Outside the call screen, a toast.
  const status = state.status;
  const percent = state.status === 'saving' ? state.percent : null;
  useEffect(() => {
    if (inCall) {
      toast.dismiss(SAVE_TOAST);
      return;
    }
    const current = session.getSnapshot();
    switch (current.status) {
      case 'saving':
        toast.loading('Saving the recording…', {
          id: SAVE_TOAST,
          duration: Infinity,
          ...(current.percent === null ? {} : { description: `${String(current.percent)}%` }),
        });
        break;
      case 'saved': {
        const { recording } = current;
        toast.success('Recording saved', {
          id: SAVE_TOAST,
          duration: 8_000,
          description: 'Only you can watch it.',
          action: {
            label: 'Watch',
            onClick: () => {
              watch(recording);
            },
          },
        });
        session.dismiss();
        break;
      }
      case 'failed':
        toast.error(current.title, {
          id: SAVE_TOAST,
          duration: Infinity,
          description: current.message,
          // Closing the toast keeps a take that can still be saved: the call screen offers it again.
          ...(current.canRetry
            ? {
                action: {
                  label: 'Try again',
                  onClick: () => {
                    void session.retry();
                  },
                },
                cancel: {
                  label: 'Discard',
                  onClick: () => {
                    session.dismiss();
                  },
                },
              }
            : {
                onDismiss: () => {
                  session.dismiss();
                },
              }),
        });
        break;
      case 'starting':
      case 'recording':
      case 'idle':
        break;
    }
  }, [inCall, session, status, percent, watch]);
}

/** Whether this browser can record calls (checked once). */
export function useCanRecord(): boolean {
  return useMemo(() => canRecordCalls(), []);
}
