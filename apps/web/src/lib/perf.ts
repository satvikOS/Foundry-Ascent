import { safeStorage, STORAGE_KEYS } from './storage';

/*
 * Device class for effects that cost GPU time (the frosted panel's backdrop blur). A browser is "low" when it
 * reports few cores or little memory, or when a two-second animation-frame sample shows a median frame over
 * 20 ms. The verdict is stored per browser, so the sample runs once, and it is applied as
 * `<html data-perf="low">`, which swaps the glass for its solid face (globals.css).
 */

export type PerfClass = 'low' | 'ok';

const SAMPLE_MS = 2000;
const SLOW_FRAME_MS = 20;

interface DeviceHints {
  hardwareConcurrency?: number | undefined;
  deviceMemory?: number | undefined;
}

/** Few cores or little memory: low without sampling. Unknown values never count against the device. */
export function lowFromHints({ hardwareConcurrency, deviceMemory }: DeviceHints): boolean {
  return (
    (typeof hardwareConcurrency === 'number' && hardwareConcurrency > 0 && hardwareConcurrency <= 4) ||
    (typeof deviceMemory === 'number' && deviceMemory > 0 && deviceMemory <= 4)
  );
}

/** Median of the frame intervals, or null with too few frames to judge. */
export function medianFrame(intervals: readonly number[]): number | null {
  if (intervals.length < 10) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function apply(perf: PerfClass): void {
  if (perf === 'low') document.documentElement.dataset.perf = 'low';
  else delete document.documentElement.dataset.perf;
}

/** Samples frames while the page is visible; resolves with the median interval (null if it could not judge). */
function sampleFrames(): Promise<number | null> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = 0;
    let start = 0;
    const step = (now: number) => {
      if (document.hidden) {
        resolve(null);
        return;
      }
      if (start === 0) start = now;
      else intervals.push(now - last);
      last = now;
      if (now - start < SAMPLE_MS) requestAnimationFrame(step);
      else resolve(medianFrame(intervals));
    };
    requestAnimationFrame(step);
  });
}

/**
 * Applies the stored verdict at once (before first paint), or decides it: from the device hints when they
 * already say "low", otherwise from one frame sample taken once the page is idle and visible.
 */
export function initPerfClass(): void {
  const stored = safeStorage.get(STORAGE_KEYS.perf);
  if (stored === 'low' || stored === 'ok') {
    apply(stored);
    return;
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (lowFromHints({ hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory })) {
    safeStorage.set(STORAGE_KEYS.perf, 'low');
    apply('low');
    return;
  }
  if (typeof requestAnimationFrame !== 'function' || document.hidden) return;
  const run = () => {
    void sampleFrames().then((median) => {
      if (median === null) return; // hidden or too few frames: decide on a later visit
      const verdict: PerfClass = median > SLOW_FRAME_MS ? 'low' : 'ok';
      safeStorage.set(STORAGE_KEYS.perf, verdict);
      apply(verdict);
    });
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 1500);
}
