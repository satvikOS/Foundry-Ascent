import { describe, expect, it, vi } from 'vitest';

import envelopes from '@/components/landing/device-ad/envelopes.json';

import {
  BAR_CAP,
  BAR_FLOOR,
  barHeight,
  barReference,
  barsFor,
  drawTimeline,
  layoutTimeline,
  MIN_REFERENCE,
  resolveTimelinePalette,
  SEGMENT_MIN_PX,
  type TimelinePalette,
} from './timeline-canvas';
import type { TimelineTurn } from './timeline-model';

const PALETTE: TimelinePalette = {
  dots: 'rgb(61, 61, 61)',
  segment: { veir: 'rgb(48, 61, 113)', student: 'rgb(52, 75, 42)' },
  bar: { veir: 'rgb(255, 255, 255)', student: 'rgb(255, 255, 255)' },
};

function turn(
  speaker: 'veir' | 'student',
  startMs: number,
  endMs: number | null,
  bins: number[] = [],
): TimelineTurn {
  return { id: `${speaker}-${String(startMs)}`, speaker, startMs, endMs, bins, text: '' };
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

  it('lets a short call fill the bar when given a shorter minimum span', () => {
    const layout = layoutTimeline([turn('veir', 0, 6_000), turn('student', 6_000, 10_000)], 10_000, 600, {
      minSpanMs: 10_000,
    });
    expect(layout.segments[0]?.width).toBeCloseTo(360, 5);
    expect(layout.segments[1]?.x).toBeCloseTo(360, 5);
    expect(layout.segments[1]?.width).toBeCloseTo(240, 5);
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

  it('scales a turn to its own loud syllables: silence is a dot, sound runs from 12 % to the 58 % cap', () => {
    const reference = 0.2;
    expect(barHeight(0, 48, reference)).toBe(2);
    expect(barHeight(0.002, 48, reference)).toBe(2);
    expect(barHeight(0.1, 48, reference)).toBeCloseTo((BAR_FLOOR + (BAR_CAP - BAR_FLOOR) * 0.5) * 48, 5);
    expect(barHeight(0.2, 48, reference)).toBeCloseTo(BAR_CAP * 48, 5);
    expect(barHeight(0.9, 48, reference)).toBeCloseTo(BAR_CAP * 48, 5);
    expect(barHeight(Number.NaN, 48, reference)).toBe(2);
  });

  it('takes the reference from the turn’s 90th percentile, never under the quiet floor', () => {
    const loud = Array.from({ length: 10 }, (_, i) => (i + 1) / 10);
    expect(barReference(loud)).toBeCloseTo(0.9, 5);
    expect(barReference([0.004, 0.005, 0.006])).toBe(MIN_REFERENCE);
    expect(barReference([0, 0.001])).toBe(MIN_REFERENCE);
  });

  it('keeps real speech readable: the committed vEIR envelope rises and falls instead of pinning at the cap', () => {
    // The device ad's vEIR line (10 Hz RMS of a synthetic voice), on phone- to desktop-width segments.
    for (const width of [140, 280, 500]) {
      const bars = barsFor(envelopes.veir, width);
      const reference = barReference(bars);
      const heights = bars.map((value) => barHeight(value, 48, reference));
      const capped = heights.filter((h) => h >= BAR_CAP * 48 - 0.01).length;
      const distinct = new Set(heights.map((h) => Math.round(h))).size;
      expect(distinct, `distinct heights at ${String(width)} px`).toBeGreaterThanOrEqual(4);
      expect(capped / heights.length, `share at the cap at ${String(width)} px`).toBeLessThan(0.3);
      expect(Math.min(...heights)).toBeLessThan(0.3 * 48);
    }
  });
});

describe('resolveTimelinePalette', () => {
  it('reads each --tl-* token through the probe’s computed colour, then clears it', () => {
    const probe = document.createElement('span');
    const seen: string[] = [];
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const { color, transitionProperty } = (element as HTMLElement).style;
      // Read with transitions off: a colour mid-transition would read back as the old one.
      expect(transitionProperty).toBe('none');
      seen.push(color);
      return { color: `resolved ${color}` } as CSSStyleDeclaration;
    });
    try {
      expect(resolveTimelinePalette(probe)).toEqual({
        dots: 'resolved var(--tl-dots)',
        segment: { veir: 'resolved var(--tl-veir)', student: 'resolved var(--tl-student)' },
        bar: { veir: 'resolved var(--tl-bar-veir)', student: 'resolved var(--tl-bar-student)' },
      });
      expect(seen).toHaveLength(5);
      expect(probe.style.color).toBe('');
      expect(probe.style.transitionProperty).toBe('');
    } finally {
      spy.mockRestore();
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
    drawTimeline(ctx, layout, { width: 300, height: 48 }, PALETTE, true);
    // 50 dots at a 6 px pitch across 300 px.
    expect(raw.fillRect).toHaveBeenCalledTimes(50);
    // One segment (3 s of a 60 s span is 15 px, widened to the 20 px minimum) and its two bars.
    expect(raw.fill).toHaveBeenCalledTimes(3);
  });

  it('draws a flat midline instead of bars where no amplitude was measured', () => {
    const { ctx, raw } = context();
    const layout = layoutTimeline([turn('student', 0, 30_000)], 60_000, 300);
    drawTimeline(ctx, layout, { width: 300, height: 48 }, PALETTE, false);
    expect(raw.fill).toHaveBeenCalledTimes(1);
    expect(raw.fillRect).toHaveBeenLastCalledWith(5, 23, 140, 2);
  });
});
