import { describe, expect, it } from 'vitest';

import { drawingRatio, MAX_CANVAS_PIXELS } from './pdf-canvas';

describe('drawingRatio', () => {
  it('draws at the screen’s density, at most 2x', () => {
    expect(drawingRatio(860, 1113, 1)).toBe(1);
    expect(drawingRatio(860, 1113, 2)).toBe(2);
    expect(drawingRatio(860, 1113, 3)).toBe(2);
    expect(drawingRatio(860, 1113, 0)).toBe(1);
  });

  it('keeps a zoomed page within the canvas limit, at the size it is shown', () => {
    // A letter page at 400% of an 860px fit on a 2x screen: 6880 × 8903 = 61 MP without the cap.
    const [width, height] = [860 * 4, 1113 * 4];
    const ratio = drawingRatio(width, height, 2);
    expect(ratio).toBeLessThan(2);
    expect(Math.floor(width * ratio) * Math.floor(height * ratio)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    // As dense as the limit allows (within a rounding pixel).
    expect((width * ratio + 1) * (height * ratio + 1)).toBeGreaterThan(MAX_CANVAS_PIXELS);
    // "Wide page" at 400%.
    const wide = drawingRatio(1118 * 4, 1447 * 4, 2);
    expect(1118 * 4 * wide * 1447 * 4 * wide).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
  });
});
