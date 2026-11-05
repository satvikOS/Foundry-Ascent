import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import type { TimelineTurn } from './script';

/** What a call timeline needs from the ad (the call's own timeline takes the same turns). */
export interface TimelineSlotProps {
  turns: readonly TimelineTurn[];
  /** Time since the call started (ms): the open turn grows to it. */
  elapsedMs: number;
  /** The span the bar's width stands for (ms). */
  spanMs: number;
  className?: string;
}

const PAD = 4;
const PITCH = 8;
const BAR = 2;
const END_PAD = 5;
const DOT = 2;
const DOT_PITCH = 6;
const MIN_SEGMENT = 20;

/** The same perceptual curve the call's presence uses: speech RMS (about 0.02–0.2) spread over 0–1. */
export function barHeight(rms: number, segment: number): number {
  const level = rms > 0 ? Math.min(0.62, Math.sqrt(rms * 6)) : 0;
  return Math.max(2, level * segment);
}

/** Bars for a segment `width` px wide: one per 8 px, each the loudest bin it covers. */
export function barsFor(bins: Float32Array, width: number): number[] {
  const count = Math.max(1, Math.floor((width - END_PAD * 2 + PITCH - BAR) / PITCH));
  const bars: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor((i / count) * bins.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * bins.length));
    let loudest = 0;
    for (let b = from; b < to && b < bins.length; b += 1) loudest = Math.max(loudest, bins[b] ?? 0);
    bars.push(loudest);
  }
  return bars;
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** Draws the dotted line, then each turn's segment and bars, at the canvas's size (device pixels, at most 2x). */
export function drawTimeline(
  canvas: HTMLCanvasElement,
  turns: readonly TimelineTurn[],
  elapsedMs: number,
  spanMs: number,
): void {
  const { width, height } = canvas.getBoundingClientRect();
  if (width === 0 || height === 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  const inner = width - PAD * 2;
  const segment = height - PAD * 2;
  const mid = height / 2;
  ctx.fillStyle = token(style, '--tl-dots', '#3d3d3d');
  for (let x = PAD; x < width - PAD; x += DOT_PITCH) ctx.fillRect(x, mid - DOT / 2, DOT, DOT);
  const perMs = inner / Math.max(spanMs, 1);
  for (const turn of turns) {
    const end = turn.endMs ?? Math.max(turn.startMs, elapsedMs);
    const x = PAD + turn.startMs * perMs;
    const w = Math.min(inner - (x - PAD), Math.max(MIN_SEGMENT, (end - turn.startMs) * perMs));
    ctx.fillStyle = token(style, turn.speaker === 'veir' ? '--tl-veir' : '--tl-student', '#303d71');
    roundRect(ctx, x, PAD, w, segment, 4);
    ctx.fillStyle = token(style, turn.speaker === 'veir' ? '--tl-bar-veir' : '--tl-bar-student', '#fff');
    barsFor(turn.bins, w).forEach((rms, i) => {
      const h = barHeight(rms, segment);
      roundRect(ctx, x + END_PAD + i * PITCH, mid - h / 2, BAR, h, 1);
    });
  }
}

/**
 * The call's conversation timeline as the ad draws it: each turn a rounded segment (the vEIR blue, the student
 * green) filled with bars from its recorded loudness, a dotted line where nobody speaks. One canvas, redrawn
 * only when a turn's bins change (ten times a second at most) or its size does.
 */
export function AdTimeline({ turns, elapsedMs, spanMs, className }: TimelineSlotProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const drawRef = useRef<() => void>(() => undefined);

  // Redrawn when the turns change (ten times a second at most while someone speaks).
  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (canvas) drawTimeline(canvas, turns, elapsedMs, spanMs);
    };
    drawRef.current();
  }, [turns, elapsedMs, spanMs]);

  // And when its size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const observer = new ResizeObserver(() => {
      drawRef.current();
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div data-slot="ad-timeline" className={cn('ad-timeline', className)}>
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
