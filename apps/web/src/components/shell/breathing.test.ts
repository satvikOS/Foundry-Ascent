import { describe, expect, it } from 'vitest';

import { BREATHING_FIELDS, canvasSize, fieldsAt, parseRgba } from './breathing';

describe('the breathing ground', () => {
  it('breathes slowly: every cycle is 20 to 40 seconds', () => {
    for (const field of BREATHING_FIELDS) {
      for (const period of [field.periodX, field.periodY, field.breath]) {
        expect(period).toBeGreaterThanOrEqual(20);
        expect(period).toBeLessThanOrEqual(40);
      }
    }
  });

  it('drifts at most about 1% of the screen per second, and never stronger than its token', () => {
    const width = 1440;
    const height = 900;
    let fastest = 0;
    for (let t = 0; t < 120; t += 0.25) {
      const now = fieldsAt(t, width, height);
      const next = fieldsAt(t + 0.25, width, height);
      for (const [index, field] of now.entries()) {
        const later = next[index];
        if (!later) continue;
        const speed = Math.hypot(later.cx - field.cx, later.cy - field.cy) / 0.25;
        fastest = Math.max(fastest, speed / Math.max(width, height));
        expect(field.strength).toBeGreaterThanOrEqual(0.8);
        expect(field.strength).toBeLessThanOrEqual(1);
      }
    }
    expect(fastest).toBeLessThan(0.012);
  });

  it('stays still at a given moment (one picture under reduced motion)', () => {
    expect(fieldsAt(0, 160, 100)).toEqual(fieldsAt(0, 160, 100));
  });

  it('is drawn small and smoothed up by the browser', () => {
    expect(canvasSize(1440, 900)).toEqual({ width: 144, height: 90 });
    expect(canvasSize(390, 844)).toEqual({ width: 48, height: 104 });
    expect(canvasSize(5120, 1440).width).toBe(256);
  });

  it('reads the colours the browser computes', () => {
    expect(parseRgba('rgba(92, 121, 245, 0.16)')).toEqual({ r: 92, g: 121, b: 245, a: 0.16 });
    expect(parseRgba('rgb(92 121 245 / 0.1)')).toEqual({ r: 92, g: 121, b: 245, a: 0.1 });
    expect(parseRgba('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseRgba('canvastext')).toBeNull();
  });
});
