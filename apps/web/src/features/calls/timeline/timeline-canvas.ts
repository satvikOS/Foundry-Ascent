import { BIN_MS, turnEnd, type Speaker, type TimelineTurn } from './timeline-model';

/**
 * Geometry and drawing of the conversation timeline (design-spec §10.2, measured from the owner's reference): rounded
 * speaker segments on a dotted midline, bars on an 8 px pitch whose heights come from real amplitude, scaled per turn.
 */

export const SEGMENT_MIN_PX = 20;
export const SEGMENT_RADIUS = 4;
export const BAR_WIDTH = 2;
export const BAR_PITCH = 8;
export const BAR_INSET = 5;
export const DOT_SIZE = 2;
export const DOT_PITCH = 6;
/** The whole call fits until it would draw slower than this; then the latest stretch scrolls. */
export const MIN_PX_PER_SECOND = 4;
/** The shortest span the width stands for, so the first seconds do not fill the bar. */
export const MIN_SPAN_MS = 60_000;
/** A turn whose bins never reach this RMS had no audible sound: it draws as a midline, not bars. */
export const AUDIBLE_BIN = 0.003;

/** A bar never falls under this share of the segment while it is audible, nor rises above the cap. */
export const BAR_FLOOR = 0.12;
export const BAR_CAP = 0.58;
/** Bars are scaled to this quantile of the turn's own audible bars (its loud syllables reach the cap). */
export const BAR_REFERENCE_QUANTILE = 0.9;
/** The smallest reference: a turn that stays this quiet draws short bars instead of being scaled up to full. */
export const MIN_REFERENCE = 0.02;

/**
 * The colours the canvas draws with (the frame's ground is CSS). They are the `--tl-*` tokens of globals.css, resolved for the element's own
 * colour scheme (`resolveTimelinePalette`), so the canvas, the legend and the contrast test share one source.
 */
export interface TimelinePalette {
  readonly dots: string;
  readonly segment: Record<Speaker, string>;
  readonly bar: Record<Speaker, string>;
}

/** The token behind each colour of the palette. */
export const TIMELINE_TOKENS = {
  dots: '--tl-dots',
  segment: { veir: '--tl-veir', student: '--tl-student' },
  bar: { veir: '--tl-bar-veir', student: '--tl-bar-student' },
} as const;

/**
 * Resolves the palette at `probe` (an element inside the timeline): each token is set as the probe's colour and
 * read back computed, which settles `light-dark()` for the probe's colour scheme (a fixed-scheme part of the page
 * included). Call it when the theme may have changed, not per frame.
 */
export function resolveTimelinePalette(probe: HTMLElement): TimelinePalette {
  // No transition on the probe: under reduced motion every element transitions (0.01 ms, globals.css), and a
  // transitioning colour reads back as its old value.
  probe.style.transitionProperty = 'none';
  const read = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const palette = {
    dots: read(TIMELINE_TOKENS.dots),
    segment: { veir: read(TIMELINE_TOKENS.segment.veir), student: read(TIMELINE_TOKENS.segment.student) },
    bar: { veir: read(TIMELINE_TOKENS.bar.veir), student: read(TIMELINE_TOKENS.bar.student) },
  };
  probe.style.removeProperty('color');
  probe.style.removeProperty('transition-property');
  return palette;
}

export interface SegmentBox {
  readonly turn: TimelineTurn;
  readonly x: number;
  readonly width: number;
}

export interface TimelineLayout {
  readonly segments: readonly SegmentBox[];
  /** Only the latest stretch is shown (the whole call no longer fits at the minimum scale). */
  readonly scrolling: boolean;
  readonly pxPerMs: number;
}

/**
 * Places each turn: width proportional to its duration over the call so far (at least `minSpanMs`, a minute by
 * default), or, once that would be slower than 4 px/s, a window of the latest seconds unless `whole` asks for the
 * whole call compressed.
 */
export function layoutTimeline(
  turns: readonly TimelineTurn[],
  elapsedMs: number,
  width: number,
  options: { readonly whole?: boolean; readonly binMs?: number; readonly minSpanMs?: number } = {},
): TimelineLayout {
  const binMs = options.binMs ?? BIN_MS;
  const span = Math.max(elapsedMs, options.minSpanMs ?? MIN_SPAN_MS);
  let pxPerMs = width / span;
  let windowStart = 0;
  const scrolling = !options.whole && pxPerMs * 1000 < MIN_PX_PER_SECOND;
  if (scrolling) {
    pxPerMs = MIN_PX_PER_SECOND / 1000;
    windowStart = elapsedMs - width / pxPerMs;
  }
  const segments: SegmentBox[] = [];
  for (const turn of turns) {
    const end = turnEnd(turn, binMs);
    if (end <= windowStart) continue;
    const x = (turn.startMs - windowStart) * pxPerMs;
    const raw = (end - turn.startMs) * pxPerMs;
    segments.push({ turn, x, width: Math.max(SEGMENT_MIN_PX, raw) });
  }
  return { segments, scrolling, pxPerMs };
}

/**
 * The level the bars of one turn are scaled to: the 90th percentile of its audible bars, so ordinary speech spreads
 * over the bar's range instead of pinning at the cap (typical speech RMS is 0.05 to 0.2, which an absolute curve
 * saturates), and only the loudest tenth reaches it. Never under `MIN_REFERENCE`: a quiet turn stays short.
 */
export function barReference(bars: readonly number[]): number {
  const audible = bars
    .filter((value) => Number.isFinite(value) && value >= AUDIBLE_BIN)
    .sort((a, b) => a - b);
  if (audible.length === 0) return MIN_REFERENCE;
  const at = Math.min(audible.length - 1, Math.round(BAR_REFERENCE_QUANTILE * (audible.length - 1)));
  return Math.max(MIN_REFERENCE, audible[at] ?? MIN_REFERENCE);
}

/**
 * A bar's height: silence (under `AUDIBLE_BIN`) is a 2 px dot; sound rises linearly from 12 % of the segment to
 * the 58 % cap at the turn's reference level (the owner's reference spans about 12 % to 58 %).
 */
export function barHeight(rms: number, segmentHeight: number, reference: number): number {
  if (!Number.isFinite(rms) || rms < AUDIBLE_BIN) return 2;
  const share = Math.min(1, rms / Math.max(reference, MIN_REFERENCE));
  return Math.max(2, (BAR_FLOOR + (BAR_CAP - BAR_FLOOR) * share) * segmentHeight);
}

/**
 * One bar per 8 px of the segment, each the average of the bins it covers (the loudest would pin most bars at the
 * cap once a bar spans several bins; the average keeps the speech's rise and fall readable).
 */
export function barsFor(bins: readonly number[], segmentWidth: number): number[] {
  const room = segmentWidth - BAR_INSET * 2 + (BAR_PITCH - BAR_WIDTH);
  const count = Math.max(1, Math.floor(room / BAR_PITCH));
  if (bins.length === 0) return [];
  const bars: number[] = [];
  const per = bins.length / count;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * per);
    const to = Math.max(from + 1, Math.ceil((i + 1) * per));
    let sum = 0;
    let n = 0;
    for (let j = from; j < to && j < bins.length; j++) {
      sum += bins[j] ?? 0;
      n += 1;
    }
    bars.push(n > 0 ? sum / n : 0);
  }
  return bars;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Draws the timeline into a context already scaled to CSS pixels: the dotted midline edge to edge, then each
 * segment with its bars (or, without measured amplitude, a flat 2 px midline).
 */
export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  layout: TimelineLayout,
  size: { readonly width: number; readonly height: number },
  palette: TimelinePalette,
  measured: boolean,
): void {
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  const mid = Math.round(height / 2 - DOT_SIZE / 2);
  ctx.fillStyle = palette.dots;
  for (let x = 1; x < width; x += DOT_PITCH) ctx.fillRect(x, mid, DOT_SIZE, DOT_SIZE);

  for (const { turn, x, width: w } of layout.segments) {
    ctx.fillStyle = palette.segment[turn.speaker];
    roundedRect(ctx, x, 0, w, height, SEGMENT_RADIUS);
    ctx.fill();
    ctx.fillStyle = palette.bar[turn.speaker];
    // No amplitude measured (a past session), or nothing audible (a reply shown on screen only): a flat midline.
    if (!measured || !turn.bins.some((bin) => bin >= AUDIBLE_BIN)) {
      const inset = Math.min(BAR_INSET, w / 4);
      ctx.fillRect(x + inset, Math.round(height / 2 - 1), Math.max(0, w - inset * 2), 2);
      continue;
    }
    const bars = barsFor(turn.bins, w);
    const reference = barReference(bars);
    const used = (bars.length - 1) * BAR_PITCH + BAR_WIDTH;
    let bx = x + Math.max(BAR_INSET, (w - used) / 2);
    for (const value of bars) {
      const h = barHeight(value, height, reference);
      roundedRect(ctx, bx, (height - h) / 2, BAR_WIDTH, h, BAR_WIDTH / 2);
      ctx.fill();
      bx += BAR_PITCH;
    }
  }
}
