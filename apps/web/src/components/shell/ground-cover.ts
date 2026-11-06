import { useEffect } from 'react';

/*
 * Layers that cover the whole app ground (the full-screen call screen): while one is up nothing of the ground shows,
 * so the breathing ground (breathing-ground.tsx) stops drawing. A redraw behind an opaque layer is wasted, and every
 * one also makes the frosted layers over the ground recompute their blur, in exactly the moments a call needs the
 * GPU and the main thread for its audio and video.
 */

let covers = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Marks the ground as covered until the returned release is called (once; later calls do nothing). */
export function coverGround(): () => void {
  covers += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    covers -= 1;
    notify();
  };
}

/** Whether any layer covers the ground now. */
export function groundCovered(): boolean {
  return covers > 0;
}

/** Calls `listener` whenever the ground becomes covered or uncovered; returns the unsubscribe. */
export function subscribeGroundCover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Covers the ground while `active` (the call screen while it is open). */
export function useCoverGround(active: boolean): void {
  useEffect(() => (active ? coverGround() : undefined), [active]);
}
