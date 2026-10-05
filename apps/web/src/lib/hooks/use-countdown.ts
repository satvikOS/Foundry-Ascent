import { useEffect, useReducer } from 'react';

/** Whole seconds from `now` until `target` (epoch ms), never negative; 0 when there is no target. */
export function secondsUntil(target: number | null | undefined, now = Date.now()): number {
  if (target === null || target === undefined) return 0;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

/** "12 s", "3 min": a short label for a wait the server asked for. */
export function formatWait(seconds: number): string {
  return seconds <= 90 ? `${String(seconds)} s` : `${String(Math.ceil(seconds / 60))} min`;
}

/**
 * Seconds left until `target` (epoch ms), re-rendering once a second until it reaches 0. Use it to honour
 * a server's Retry-After / `retryAfterSeconds` in the UI.
 */
export function useSecondsUntil(target: number | null | undefined): number {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const remaining = secondsUntil(target);
  useEffect(() => {
    if (target === null || target === undefined) return undefined;
    const timer = setInterval(() => {
      tick();
      if (secondsUntil(target) === 0) clearInterval(timer);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [target]);
  return remaining;
}
