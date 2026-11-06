/*
 * The breathing ground's motion (owner, 2026-11-06: "breathing blur gradients, very delicate and light, soothing, not
 * distracting"): three large soft colour fields, each drifting on a slow closed path and swelling and settling like a
 * breath. Every period is 20-40 s and no two match, so the picture never visibly repeats and nothing moves fast enough
 * to draw the eye: no field's centre travels more than about 1% of the screen per second.
 */

export interface BreathingField {
  /** Resting centre, as fractions of the canvas (0-1). */
  readonly x: number;
  readonly y: number;
  /** How far the centre drifts from rest, as fractions of the canvas. */
  readonly driftX: number;
  readonly driftY: number;
  /** Seconds per drift loop (x and y apart, so the path is an open Lissajous curve, not a line). */
  readonly periodX: number;
  readonly periodY: number;
  /** Radius at rest, as a fraction of the canvas's longer side. */
  readonly radius: number;
  /** Seconds per breath (the radius and the strength swell and settle together). */
  readonly breath: number;
  /** Phase offset in radians, so the fields never breathe in step. */
  readonly phase: number;
}

/** Placed where the glass is (the side panel at the left, the composer low and right) and kept off the top edge. */
export const BREATHING_FIELDS: readonly BreathingField[] = [
  {
    x: 0.16,
    y: 0.6,
    driftX: 0.04,
    driftY: 0.05,
    periodX: 34,
    periodY: 27,
    radius: 0.55,
    breath: 23,
    phase: 0,
  },
  {
    x: 0.86,
    y: 0.86,
    driftX: 0.05,
    driftY: 0.03,
    periodX: 29,
    periodY: 38,
    radius: 0.5,
    breath: 31,
    phase: 2.1,
  },
  {
    x: 0.6,
    y: 0.34,
    driftX: 0.05,
    driftY: 0.04,
    periodX: 39,
    periodY: 33,
    radius: 0.42,
    breath: 37,
    phase: 4.2,
  },
];

/** How much a breath swells the radius and the strength (8% and a fifth: felt, not seen). */
const RADIUS_SWELL = 0.08;
const STRENGTH_SWELL = 0.2;

export interface FieldFrame {
  /** Centre and radius in canvas pixels. */
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  /** Strength, 0-1, multiplied into the field's colour alpha (its token is the strongest it gets). */
  readonly strength: number;
}

/** Where each field is at `seconds`, on a `width` x `height` canvas. */
export function fieldsAt(
  seconds: number,
  width: number,
  height: number,
  fields: readonly BreathingField[] = BREATHING_FIELDS,
): FieldFrame[] {
  const longer = Math.max(width, height);
  const turn = (period: number) => (2 * Math.PI * seconds) / period;
  return fields.map((field) => {
    const breath = Math.sin(turn(field.breath) + field.phase);
    return {
      cx: (field.x + field.driftX * Math.sin(turn(field.periodX) + field.phase)) * width,
      cy: (field.y + field.driftY * Math.cos(turn(field.periodY) + field.phase)) * height,
      r: field.radius * longer * (1 + RADIUS_SWELL * breath),
      // From 1 - STRENGTH_SWELL at the bottom of a breath to 1 at the top: never stronger than the token.
      strength: 1 - STRENGTH_SWELL * (1 - breath) * 0.5,
    };
  });
}

/** An `rgb()`/`rgba()` colour as computed by the browser, as numbers; null when it cannot be read. */
export function parseRgba(css: string): { r: number; g: number; b: number; a: number } | null {
  const match = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  if (!match?.[1]) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((part) => (part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part)));
  const [r, g, b, a = 1] = parts;
  if ([r, g, b, a].some((value) => value === undefined || Number.isNaN(value))) return null;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a };
}

/** The canvas's size for a viewport: about a tenth of it (the browser smooths it up), never tinier than 48 px. */
export function canvasSize(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
  const scale = 0.1;
  const width = Math.max(48, Math.min(256, Math.round(viewportWidth * scale)));
  const height = Math.max(48, Math.round((width * Math.max(1, viewportHeight)) / Math.max(1, viewportWidth)));
  return { width, height: Math.min(height, 256) };
}

/** Frames per second while breathing: the motion is so slow that more would only spend battery. */
export const BREATHING_FPS = 12;
