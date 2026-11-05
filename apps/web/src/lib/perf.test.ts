import { afterEach, describe, expect, it } from 'vitest';

import {
  initPerfClass,
  isLowPerf,
  judgeFrames,
  lowFromHints,
  medianFrame,
  readVerdict,
  VERDICT_TTL_MS,
} from './perf';
import { safeStorage, STORAGE_KEYS } from './storage';

const NOW = Date.UTC(2026, 10, 5, 12);
const stored = (v: string, at: number) => JSON.stringify({ v, at });

/** Twenty frame intervals around `ms`, each off by up to `jitter`. */
function frames(ms: number, jitter = 0): number[] {
  return Array.from({ length: 20 }, (_, i) => ms + (i % 2 ? jitter : -jitter));
}

describe('device class', () => {
  afterEach(() => {
    safeStorage.remove(STORAGE_KEYS.perf);
    delete document.documentElement.dataset.perf;
  });

  it('reads few cores or little memory as low, and never counts unknown values against a device', () => {
    expect(lowFromHints({ hardwareConcurrency: 4 })).toBe(true);
    expect(lowFromHints({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(true);
    expect(lowFromHints({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false);
    expect(lowFromHints({})).toBe(false);
    expect(lowFromHints({ hardwareConcurrency: 0 })).toBe(false);
  });

  it('takes the median frame, and refuses to judge from too few frames', () => {
    expect(medianFrame([16, 17, 16, 50, 16, 17, 16, 16, 18, 16])).toBe(16);
    expect(medianFrame([25, 26, 24, 25, 30, 22, 25, 25, 26, 24, 23])).toBe(25);
    expect(medianFrame([16, 16])).toBeNull();
  });

  it('tells a refresh cap from a struggling device', () => {
    expect(judgeFrames(frames(16.7, 0.3))).toBe('ok');
    // A 48 Hz display: slower than 20 ms, but steady.
    expect(judgeFrames(frames(20.8, 0.4))).toBe('ok');
    // A steady 30 Hz (Low Power Mode, a 30 Hz screen): not judged, sampled again on a later visit.
    expect(judgeFrames(frames(33.3, 0.5))).toBeNull();
    // Irregular, slow frames: low.
    expect(judgeFrames(frames(30, 9))).toBe('low');
    expect(judgeFrames(frames(50, 0.5))).toBe('low');
    expect(judgeFrames([16, 16])).toBeNull();
  });

  it('keeps a verdict for a week, then samples again; an older stored format counts as none', () => {
    expect(readVerdict(stored('low', NOW - 1000), NOW)).toBe('low');
    expect(readVerdict(stored('ok', NOW - VERDICT_TTL_MS + 1000), NOW)).toBe('ok');
    expect(readVerdict(stored('low', NOW - VERDICT_TTL_MS - 1000), NOW)).toBeNull();
    expect(readVerdict(stored('low', NOW + 60_000), NOW)).toBeNull();
    expect(readVerdict('low', NOW)).toBeNull();
    expect(readVerdict('{not json', NOW)).toBeNull();
    expect(readVerdict(null, NOW)).toBeNull();
  });

  it('applies a standing verdict before first paint, and forgets an expired one', () => {
    safeStorage.set(STORAGE_KEYS.perf, stored('low', NOW - 1000));
    initPerfClass(NOW);
    expect(document.documentElement.dataset.perf).toBe('low');
    safeStorage.set(STORAGE_KEYS.perf, stored('ok', NOW - 1000));
    initPerfClass(NOW);
    expect(document.documentElement.dataset.perf).toBeUndefined();
    // A slow verdict from more than a week ago no longer holds the glass solid.
    safeStorage.set(STORAGE_KEYS.perf, stored('low', NOW - VERDICT_TTL_MS - 1));
    initPerfClass(NOW);
    expect(document.documentElement.dataset.perf).toBeUndefined();
  });

  it('reports the applied verdict to effects that hold still on a slow device', () => {
    expect(isLowPerf()).toBe(false);
    safeStorage.set(STORAGE_KEYS.perf, stored('low', NOW));
    initPerfClass(NOW);
    expect(isLowPerf()).toBe(true);
  });
});
