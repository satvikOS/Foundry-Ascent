import { useSyncExternalStore } from 'react';

/**
 * Aurora Serverless v2 auto-pauses after 10 idle minutes; the first request afterwards gets
 * `503 database_resuming` while it wakes (~15 s). The API client retries such requests transparently
 * and registers each wait here so the UI can show one shared "Waking up your workspace…" banner with
 * elapsed time and a Cancel action that stops every pending wait.
 */
export interface ResumingSnapshot {
  /** Number of requests currently waiting for the database. */
  waiting: number;
  /** Epoch ms when the current waking period started, or null when idle. */
  since: number | null;
  /** Epoch ms of the last time a waking period ended successfully. */
  lastResumedAt: number | null;
}

export interface ResumeLease {
  /** Aborted when the person presses Cancel. */
  readonly signal: AbortSignal;
  /** Release the lease. `resumed` = the request eventually succeeded. */
  end(resumed: boolean): void;
}

type Listener = () => void;

class ResumingStore {
  private controllers = new Set<AbortController>();
  private snapshot: ResumingSnapshot = { waiting: 0, since: null, lastResumedAt: null };
  private listeners = new Set<Listener>();

  begin(): ResumeLease {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.update({
      waiting: this.controllers.size,
      since: this.snapshot.since ?? Date.now(),
    });
    let ended = false;
    return {
      signal: controller.signal,
      end: (resumed: boolean) => {
        if (ended) return;
        ended = true;
        this.controllers.delete(controller);
        const idle = this.controllers.size === 0;
        this.update({
          waiting: this.controllers.size,
          since: idle ? null : this.snapshot.since,
          lastResumedAt: resumed ? Date.now() : this.snapshot.lastResumedAt,
        });
      },
    };
  }

  /** Stop waiting: every pending request fails fast with `database_resuming`. */
  cancelAll(): void {
    for (const controller of this.controllers) controller.abort(new DOMException('Cancelled', 'AbortError'));
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ResumingSnapshot => this.snapshot;

  private update(patch: Partial<ResumingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const resumingStore = new ResumingStore();

export function useResumingState(): ResumingSnapshot {
  return useSyncExternalStore(resumingStore.subscribe, resumingStore.getSnapshot, resumingStore.getSnapshot);
}
