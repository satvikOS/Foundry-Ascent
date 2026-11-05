import { afterEach, describe, expect, it } from 'vitest';

import { initPerfClass, lowFromHints, medianFrame } from './perf';
import { safeStorage, STORAGE_KEYS } from './storage';

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

  it('applies a stored verdict before first paint', () => {
    safeStorage.set(STORAGE_KEYS.perf, 'low');
    initPerfClass();
    expect(document.documentElement.dataset.perf).toBe('low');
    safeStorage.set(STORAGE_KEYS.perf, 'ok');
    initPerfClass();
    expect(document.documentElement.dataset.perf).toBeUndefined();
  });
});
