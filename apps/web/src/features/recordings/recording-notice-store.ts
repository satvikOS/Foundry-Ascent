import { useCallback, useSyncExternalStore } from 'react';

import { safeStorage } from '@/lib/storage';

/*
 * The notice read before a person's first recording (what is recorded, where it is kept, how to delete it),
 * remembered per person in this browser: a versioned key, so new facts are shown again once.
 */
const NOTICE_VERSION = 1;

export function recordingNoticeKey(principalId: string): string {
  return `fa.recording.notice.v${String(NOTICE_VERSION)}.${principalId}`;
}

const listeners = new Set<() => void>();
/** Read in this page view though the browser would not store it (storage disabled). */
const unstored = new Set<string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordingNoticeSeen(principalId: string): boolean {
  const key = recordingNoticeKey(principalId);
  return unstored.has(key) || safeStorage.get(key) !== null;
}

export function acknowledgeRecordingNotice(principalId: string): void {
  if (recordingNoticeSeen(principalId)) return;
  const key = recordingNoticeKey(principalId);
  safeStorage.set(key, new Date().toISOString());
  if (safeStorage.get(key) === null) unstored.add(key);
  for (const listener of [...listeners]) listener();
}

/** Whether this person has read the recording notice, and a way to say they have. */
export function useRecordingNotice(principalId: string): [seen: boolean, acknowledge: () => void] {
  const seen = useSyncExternalStore(
    subscribe,
    () => recordingNoticeSeen(principalId),
    () => true,
  );
  const acknowledge = useCallback(() => {
    acknowledgeRecordingNotice(principalId);
  }, [principalId]);
  return [seen, acknowledge];
}
