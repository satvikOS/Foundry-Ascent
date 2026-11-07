import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { queryKeys } from '@/lib/api/query-keys';
import { saveRecording } from '@/lib/api/hooks/recordings';

import { canRecordCalls } from './call-recorder';
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

const BROWSER_DEPS = { createRecorder: browserRecorder, save: saveRecording, now: () => Date.now() };

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

/**
 * Keeps the call's recording in step with the call screen (who it shows, the face) and says what happens to it: the
 * toasts while it saves, then Watch (its conversation's list and Recordings are refreshed), or why it failed with
 * Try again. Mounted once, by the call screen, which stays mounted for the whole call.
 */
export function useCallRecordingLifecycle(
  session: RecordingSession,
  subject: { veirName: string; founderName: string; face: RecordedFace | null; tenant: string },
): void {
  const client = useQueryClient();
  const navigate = useNavigate();
  const state = useRecordingState(session);
  const { veirName, founderName, face, tenant } = subject;

  useEffect(() => {
    session.attach({ veirName, founderName, face });
  }, [session, veirName, founderName, face]);

  useEffect(() => {
    session.onSaved = () => {
      void client.invalidateQueries({ queryKey: queryKeys.recordings.all() });
    };
    return () => {
      session.onSaved = null;
    };
  }, [client, session]);

  const previous = useRef<RecordingState['status']>(state.status);
  useEffect(() => {
    const was = previous.current;
    previous.current = state.status;
    if (state.status === was) return;
    switch (state.status) {
      case 'recording':
        announce('Recording started');
        break;
      case 'saving':
        if (was === 'recording') announce('Recording stopped. Saving it.');
        toast.loading('Saving the recording…', { id: SAVE_TOAST, duration: Infinity });
        break;
      case 'saved': {
        const { recording } = state;
        announce('Recording saved');
        toast.success('Recording saved', {
          id: SAVE_TOAST,
          duration: 8_000,
          description: 'Only you can watch it.',
          action: {
            label: 'Watch',
            onClick: () => {
              void navigate({
                to: '/$tenant/app/v/$ventureId/recordings',
                params: { tenant, ventureId: recording.ventureId },
                search: { r: recording.id },
              });
            },
          },
        });
        session.dismiss();
        break;
      }
      case 'failed':
        announce('The recording wasn’t saved', 'assertive');
        toast.error('The recording wasn’t saved', {
          id: SAVE_TOAST,
          duration: Infinity,
          description: state.message,
          ...(state.canRetry
            ? {
                action: {
                  label: 'Try again',
                  onClick: () => {
                    void session.retry();
                  },
                },
              }
            : {}),
          onDismiss: () => {
            session.dismiss();
          },
        });
        break;
      case 'idle':
        break;
    }
  }, [navigate, session, state, tenant]);
}

/** Whether this browser can record calls (checked once). */
export function useCanRecord(): boolean {
  return useMemo(() => canRecordCalls(), []);
}
