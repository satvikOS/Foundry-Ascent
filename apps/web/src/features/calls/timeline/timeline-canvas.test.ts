import { describe, expect, it, vi } from 'vitest';

import {
  barHeight,
  barsFor,
  drawTimeline,
  layoutTimeline,
  SEGMENT_MIN_PX,
  TIMELINE_PALETTES,
} from './timeline-canvas';
import type { TimelineTurn } from './timeline-model';

function turn(
  speaker: 'veir' | 'student',
  startMs: number,
  endMs: number | null,
  bins: number[] = [],
): TimelineTurn {
  return { id: `${speaker}-${String(startMs)}`, speaker, startMs, endMs, bins, text: '' };
}

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('layoutTimeline', () => {
  it('sizes turns by duration over at least a minute, with a minimum width', () => {
    const layout = layoutTimeline([turn('veir', 0, 6_000), turn('student', 6_000, 6_100)], 10_000, 600);
    expect(layout.scrolling).toBe(false);
    expect(layout.segments[0]?.x).toBe(0);
    expect(layout.segments[0]?.width).toBeCloseTo(60, 5);
    expect(layout.segments[1]?.x).toBeCloseTo(60, 5);
    expect(layout.segments[1]?.width).toBe(SEGMENT_MIN_PX);
  });

  it('scrolls the latest stretch once the whole call would draw slower than 4 px/s, unless asked for all of it', () => {
    const turns = [turn('veir', 0, 10_000), turn('student', 590_000, 600_000)];
    const scrolled = layoutTimeline(turns, 600_000, 400);
    expect(scrolled.scrolling).toBe(true);
    expect(scrolled.segments.map((s) => s.turn.speaker)).toEqual(['student']);
    expect(scrolled.segments[0]?.x).toBeCloseTo(360, 5);
    const whole = layoutTimeline(turns, 600_000, 400, { whole: true });
    expect(whole.scrolling).toBe(false);
    expect(whole.segments).toHaveLength(2);
  });

  it('draws a turn still going up to its latest bin', () => {
    const layout = layoutTimeline([turn('student', 0, null, [0.1, 0.1, 0.1])], 300, 600);
    expect(layout.segments[0]?.width).toBe(SEGMENT_MIN_PX);
  });
});

describe('bars', () => {
  it('puts one bar per 8 px, each the average of the bins it covers', () => {
    const bars = barsFor([0.1, 0.5, 0.2, 0.05], 26);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toBeCloseTo(0.3, 5);
    expect(bars[1]).toBeCloseTo(0.125, 5);
    expect(barsFor([], 100)).toEqual([]);
  });

  it('uses the sphere’s perceptual curve, capped at 62 % of the segment and never under 2 px', () => {
    expect(barHeight(0, 48)).toBe(2);
    expect(barHeight(1, 48)).toBeCloseTo(48 * 0.62, 5);
    expect(barHeight(0.01, 48)).toBeCloseTo(Math.sqrt(0.06) * 48, 5);
  });
});

describe('palettes', () => {
  it('keeps every bar at least 3:1 against its segment in both themes', () => {
    for (const palette of Object.values(TIMELINE_PALETTES)) {
      for (const speaker of ['veir', 'student'] as const) {
        expect(contrast(palette.bar[speaker], palette.segment[speaker])).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('drawTimeline', () => {
  function context() {
    const calls: string[] = [];
    const ctx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn((_x: number, _y: number, w: number, h: number) => {
        calls.push(`rect ${String(w)}x${String(h)}`);
      }),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(() => {
        calls.push('fill');
      }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx };
  }

  it('draws the dotted midline, then segments with bars from the measured bins', () => {
    const { ctx, raw } = context();
    const layout = layoutTimeline(
      [
        turn(
          'veir',
          0,
          3_000,
          Array.from({ length: 30 }, () => 0.1),
        ),
      ],
      3_000,
      300,
    );
    drawTimeline(ctx, layout, { width: 300, height: 48 }, TIMELINE_PALETTES.dark, true);
    // 50 dots at a 6 px pitch across 300 px.
    expect(raw.fillRect).toHaveBeenCalledTimes(50);
    // One segment (3 s of a 60 s span is 15 px, widened to the 20 px minimum) and its two bars.
    expect(raw.fill).toHaveBeenCalledTimes(3);
  });

  it('draws a flat midline instead of bars where no amplitude was measured', () => {
    const { ctx, raw } = context();
    const layout = layoutTimeline([turn('student', 0, 30_000)], 60_000, 300);
    drawTimeline(ctx, layout, { width: 300, height: 48 }, TIMELINE_PALETTES.light, false);
    expect(raw.fill).toHaveBeenCalledTimes(1);
    expect(raw.fillRect).toHaveBeenLastCalledWith(5, 23, 140, 2);
  });
});
