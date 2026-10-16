import { useEffect, useReducer } from 'react';

import type { CallSnapshot } from '@/lib/realtime/call-engine';

/** "0:42", "12:05", "1:02:03". */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${ss}` : `${String(m)}:${ss}`;
}

/** Spoken form for screen readers: "4 minutes 12 seconds". */
export function spokenDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const parts = [];
  if (m > 0) parts.push(`${String(m)} minute${m === 1 ? '' : 's'}`);
  if (s > 0 || m === 0) parts.push(`${String(s)} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export interface CallClock {
  /** Seconds since the call went live. */
  readonly elapsed: number;
  /** Seconds before the call's limit, or null before it is known. */
  readonly left: number | null;
  /** "18 min left", or "1:45 left" in the last two minutes. */
  readonly leftLabel: string | null;
  readonly warning: boolean;
}

export function callClock(snapshot: Pick<CallSnapshot, 'liveAt' | 'remaining'>, now: number): CallClock {
  const elapsed = snapshot.liveAt === null ? 0 : Math.max(0, (now - snapshot.liveAt) / 1000);
  const left =
    snapshot.remaining === null
      ? null
      : Math.max(0, snapshot.remaining.seconds - (now - snapshot.remaining.at) / 1000);
  const warning = left !== null && left <= 120;
  const leftLabel =
    left === null ? null : warning ? `${formatClock(left)} left` : `${String(Math.ceil(left / 60))} min left`;
  return { elapsed, left, leftLabel, warning };
}

/** The call's clock, re-rendering every second while the call is live. */
export function useCallClock(snapshot: Pick<CallSnapshot, 'phase' | 'liveAt' | 'remaining'>): CallClock {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const live = snapshot.phase === 'live';
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [live]);
  return callClock(snapshot, Date.now());
}
