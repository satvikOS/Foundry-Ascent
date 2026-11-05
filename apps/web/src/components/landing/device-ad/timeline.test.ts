import { describe, expect, it } from 'vitest';

import { barHeight, barsFor } from './timeline';

describe('the ad’s timeline bars', () => {
  it('use the presence’s perceptual curve, at least 2 px and at most 62 % of the segment', () => {
    expect(barHeight(0, 40)).toBe(2);
    expect(barHeight(0.01, 40)).toBeCloseTo(Math.sqrt(0.06) * 40, 5);
    expect(barHeight(1, 40)).toBeCloseTo(0.62 * 40, 5);
  });

  it('draw one bar per 8 px, each the loudest bin it covers', () => {
    const bins = Float32Array.from([0.1, 0.4, 0.2, 0.05]);
    expect(barsFor(bins, 26)).toHaveLength(2);
    expect(barsFor(bins, 26).map((v) => Number(v.toFixed(2)))).toEqual([0.4, 0.2]);
    // A narrow segment still shows one bar, never none.
    expect(barsFor(bins, 4)).toHaveLength(1);
  });
});
