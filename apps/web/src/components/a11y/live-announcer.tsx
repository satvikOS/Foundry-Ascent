import { useSyncExternalStore } from 'react';

/**
 * Global aria-live regions. Mount <LiveAnnouncer /> once (in __root); call `announce()` from
 * anywhere — components, hooks or plain functions — to have screen readers read a short message.
 *
 *   announce('Memory approved');                    // polite (default)
 *   announce('Session ended unexpectedly', 'assertive');
 *
 * Messages must be short and must not contain venture content (they may be read aloud in shared
 * spaces); prefer "3 sources found" over echoing text.
 */
type Politeness = 'polite' | 'assertive';

interface AnnouncerState {
  polite: string;
  assertive: string;
}

let state: AnnouncerState = { polite: '', assertive: '' };
const listeners = new Set<() => void>();
const timers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>> = {};

function emit(next: AnnouncerState) {
  state = next;
  for (const listener of listeners) listener();
}

export function announce(message: string, politeness: Politeness = 'polite'): void {
  // Clear first so repeating the same message is announced again.
  emit({ ...state, [politeness]: '' });
  clearTimeout(timers[politeness]);
  timers[politeness] = setTimeout(() => {
    emit({ ...state, [politeness]: message });
  }, 60);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

export function LiveAnnouncer() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="live-polite">
        {current.polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" data-testid="live-assertive">
        {current.assertive}
      </div>
    </div>
  );
}

/** Hook form for components that prefer it. */
export function useAnnounce(): typeof announce {
  return announce;
}
