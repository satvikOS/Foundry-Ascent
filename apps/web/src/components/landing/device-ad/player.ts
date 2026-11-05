import { useEffect, useRef, useState, type RefObject } from 'react';

import { BEATS, PLAYS, quantize } from './script';

/** Longest step one animation frame may advance the loop (a stalled tab never skips the story ahead). */
const MAX_STEP_MS = 100;

/**
 * Where the sequence is after `elapsed` ms of play, for a loop from `from` to the end: the time into the current
 * loop, or the final frame once it has played `plays` times.
 */
export function loopTime(elapsed: number, from = 0, end: number = BEATS.end, plays: number = PLAYS): number {
  const length = end - from;
  if (elapsed >= length * plays) return end;
  return from + (elapsed % length);
}

/**
 * Plays the ad's sequence with one requestAnimationFrame loop. It runs only while the figure is on screen and the
 * page is visible, calls `onFrame` with the exact time every frame (for the voice presence, outside React) and
 * returns the time on 100 ms steps, so React renders the screens at most ten times a second. With `still` (reduced
 * motion, a slow device) nothing runs and the final frame shows.
 */
export function useAdPlayer(
  root: RefObject<HTMLElement | null>,
  still: boolean,
  onFrame: (t: number) => void,
  /** Where each loop starts (the phone alone starts at its call). */
  from = 0,
): number {
  const [shown, setShown] = useState(() => (still ? BEATS.end : from));
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  useEffect(() => {
    const element = root.current;
    if (still || !element) {
      setShown(BEATS.end);
      onFrameRef.current(BEATS.end);
      return undefined;
    }
    let elapsed = 0;
    let frame = 0;
    let last: number | null = null;
    let onScreen = false;
    let lastShown = -1;
    let finished = false;

    const tick = (now: number) => {
      elapsed += last === null ? 0 : Math.min(MAX_STEP_MS, now - last);
      last = now;
      const t = loopTime(elapsed, from);
      finished = elapsed >= (BEATS.end - from) * PLAYS;
      onFrameRef.current(t);
      const step = finished ? BEATS.end : quantize(t);
      if (step !== lastShown) {
        lastShown = step;
        setShown(step);
      }
      frame = finished ? 0 : requestAnimationFrame(tick);
    };
    const update = () => {
      const playing = onScreen && document.visibilityState === 'visible' && !finished;
      if (playing && frame === 0) {
        last = null;
        frame = requestAnimationFrame(tick);
      } else if (!playing && frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      cancelAnimationFrame(frame);
    };
  }, [root, still, from]);

  return shown;
}
