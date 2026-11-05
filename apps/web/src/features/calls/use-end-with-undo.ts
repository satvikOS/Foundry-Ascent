import { useCallback, useEffect, useRef, useState } from 'react';

import type { CallEngine, CallSnapshot } from '@/lib/realtime/call-engine';

/** How long "Call ended · Undo" waits before the call really ends (design-spec §10.1: no confirm dialog). */
export const END_UNDO_MS = 3_000;

/**
 * End with a short undo (design-spec §10.1): a single press of End silences the call at once (the microphone is
 * muted and a reply in progress stops) and ends it after `END_UNDO_MS` unless Undo is pressed; a second press ends
 * it now. Leaving the screen meanwhile (minimizing, Escape) ends it at once: the founder asked to end. A call that
 * is still connecting ends at once (there is nothing to undo).
 */
export function useEndWithUndo(
  engine: CallEngine,
  snapshot: CallSnapshot,
  delayMs: number = END_UNDO_MS,
): { pending: boolean; request: () => void; undo: () => void } {
  const [pending, setPending] = useState<{ wasMuted: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const commit = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
    void engine.end('user');
  }, [engine]);

  // Unmounted while ending (minimized, closed): end now.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
      void engine.end('user');
    },
    [engine],
  );
  // Ended some other way meanwhile (its time ran out, the program paused calls): nothing left to undo.
  useEffect(() => {
    if (snapshot.phase === 'live' || timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
  }, [snapshot.phase]);

  const request = () => {
    if (snapshot.phase !== 'live' || pending) {
      commit();
      return;
    }
    const wasMuted = snapshot.muted;
    if (snapshot.activity === 'speaking') engine.interrupt();
    if (snapshot.input === 'voice' && !wasMuted) engine.setMuted(true);
    setPending({ wasMuted });
    clear();
    timer.current = setTimeout(commit, delayMs);
  };
  const undo = () => {
    if (!pending) return;
    clear();
    if (snapshot.input === 'voice' && !pending.wasMuted) engine.setMuted(false);
    setPending(null);
  };
  return { pending: pending !== null, request, undo };
}
