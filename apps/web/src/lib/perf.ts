import { safeStorage, STORAGE_KEYS } from './storage';

/*
 * Device class for effects that cost GPU time (the frosted panel's backdrop blur, the landing's moving ad). A
 * browser is "low" when it reports few cores or little memory, or when a two-second animation-frame sample shows
 * a median frame over 20 ms that is not just a steady refresh cap. The sample is taken on a quiet page (never the
 * landing page, whose own animations would be measured), once the page is idle and visible, and its verdict is kept
 * for a week, then taken again: a phone sampled in Low Power Mode is not marked slow for good. The verdict is
 * applied as `<html data-perf="low">`, which swaps the glass for its solid face (globals.css).
 */

export type PerfClass = 'low' | 'ok';

const SAMPLE_MS = 2000;
const SLOW_FRAME_MS = 20;
/** How long a sampled verdict stands before the frames are sampled again. */
export const VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Pages that animate on their own: a sample there measures their animation, not the device. */
const BUSY_PATHS: ReadonlySet<string> = new Set(['/']);

interface DeviceHints {
  hardwareConcurrency?: number | undefined;
  deviceMemory?: number | undefined;
}

/**
 * Very few cores or very little memory: low without sampling. Unknown values never count against the device. Four
 * cores is common on capable phones, tablets and laptops (and browsers round the count down for privacy), so only two
 * or fewer cores, or 2 GB or less, decide alone; everything else is judged by its frames.
 */
export function lowFromHints({ hardwareConcurrency, deviceMemory }: DeviceHints): boolean {
  return (
    (typeof hardwareConcurrency === 'number' && hardwareConcurrency > 0 && hardwareConcurrency <= 2) ||
    (typeof deviceMemory === 'number' && deviceMemory > 0 && deviceMemory <= 2)
  );
}

function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (at - low);
}

/** Median of the frame intervals, or null with too few frames to judge. */
export function medianFrame(intervals: readonly number[]): number | null {
  if (intervals.length < 10) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The verdict of one frame sample, or null when it cannot tell. Frames that arrive on a steady cadence (an
 * interquartile range within 3 ms) come from a refresh cap, not from struggling: a 48 or 50 Hz display is "ok",
 * and a steady 30 Hz (Low Power Mode, a 30 Hz screen, or a device dropping every other frame) is not judged.
 * Irregular frames slower than 20 ms at the median are "low".
 */
export function judgeFrames(intervals: readonly number[]): PerfClass | null {
  const median = medianFrame(intervals);
  if (median === null) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const steady = quantile(sorted, 0.75) - quantile(sorted, 0.25) <= 3;
  if (median <= SLOW_FRAME_MS) return 'ok';
  if (steady && median <= 26) return 'ok';
  if (steady && median <= 36) return null;
  return 'low';
}

interface StoredVerdict {
  readonly v: PerfClass;
  readonly at: number;
}

/** The stored verdict while it stands (a week from its sample); anything else, an older format included, is none. */
export function readVerdict(raw: string | null, now: number): PerfClass | null {
  if (!raw?.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredVerdict>;
    if ((parsed.v !== 'low' && parsed.v !== 'ok') || typeof parsed.at !== 'number') return null;
    if (parsed.at > now || now - parsed.at > VERDICT_TTL_MS) return null;
    return parsed.v;
  } catch {
    return null;
  }
}

function storeVerdict(v: PerfClass, now: number): void {
  safeStorage.set(STORAGE_KEYS.perf, JSON.stringify({ v, at: now } satisfies StoredVerdict));
}

/** The verdict as applied: true once this browser is marked slow (`<html data-perf="low">`). */
export function isLowPerf(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.perf === 'low';
}

function apply(perf: PerfClass): void {
  if (perf === 'low') document.documentElement.dataset.perf = 'low';
  else delete document.documentElement.dataset.perf;
}

/** Samples frames while the page is visible; resolves with the intervals (null if the page was hidden). */
function sampleFrames(): Promise<number[] | null> {
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
      else resolve(intervals);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Applies the standing verdict at once (before first paint), or decides it: from the device hints when they
 * say "low" (checked on every load, never stored), otherwise from one frame sample taken once a quiet page is
 * idle and visible. Until a sample decides, the device counts as "ok".
 */
export function initPerfClass(now: number = Date.now()): void {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (lowFromHints({ hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory })) {
    apply('low');
    return;
  }
  const stored = readVerdict(safeStorage.get(STORAGE_KEYS.perf), now);
  if (stored) {
    apply(stored);
    return;
  }
  apply('ok');
  if (typeof requestAnimationFrame !== 'function' || document.hidden) return;
  if (BUSY_PATHS.has(window.location.pathname)) return; // decided on a quieter page
  const run = () => {
    void sampleFrames().then((intervals) => {
      const verdict = intervals ? judgeFrames(intervals) : null;
      if (verdict === null) return; // hidden, too few frames or a steady 30 Hz: decide on a later visit
      storeVerdict(verdict, Date.now());
      apply(verdict);
    });
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 1500);
}
