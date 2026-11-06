import { useEffect, useRef, useState } from 'react';

import { BREATHING_FPS, canvasSize, fieldsAt, parseRgba } from './breathing';
import { groundCovered, subscribeGroundCover } from './ground-cover';

type Rgba = NonNullable<ReturnType<typeof parseRgba>>;

/** The fields' colours, computed from the canvas's border colours (`--breath-1..3`, resolved for the theme). */
function readColors(canvas: HTMLCanvasElement): (Rgba | null)[] {
  const style = getComputedStyle(canvas);
  return [style.borderTopColor, style.borderRightColor, style.borderBottomColor].map(parseRgba);
}

function slowDevice(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.perf === 'low';
}

function context2d(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  try {
    return canvas.getContext('2d', { alpha: true });
  } catch {
    return null;
  }
}

/**
 * The breathing ground behind an open conversation window (globals.css `.breathing-ground`, the motion in
 * breathing.ts): one small canvas the browser smooths up to the screen, redrawn a dozen times a second while the tab is
 * visible, and a copy of it over the window's gaps (`.breathing-caps`, over the plain caps the shell keeps there). It
 * stops while the tab is hidden and while a full-screen layer covers the ground (the call screen, ground-cover.ts),
 * holds one still frame under reduced motion, follows the theme, and is not drawn at all on a slow device.
 */
export function BreathingGround() {
  const groundRef = useRef<HTMLCanvasElement | null>(null);
  const capsRef = useRef<HTMLCanvasElement | null>(null);
  const [slow, setSlow] = useState(slowDevice);

  // The device verdict (lib/perf.ts) can arrive after the page has drawn.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setSlow(slowDevice());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-perf'] });
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (slow) return;
    const ground = groundRef.current;
    const context = context2d(ground);
    if (!ground || !context) return;
    const caps = capsRef.current;
    const capsContext = context2d(caps);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    let colors = readColors(ground);
    let frame = 0;
    let last = -Infinity;

    const draw = (seconds: number) => {
      const { width, height } = ground;
      context.clearRect(0, 0, width, height);
      for (const [index, field] of fieldsAt(seconds, width, height).entries()) {
        const color = colors[index];
        if (!color || color.a <= 0) continue;
        const alpha = color.a * field.strength;
        const rgb = `${String(color.r)}, ${String(color.g)}, ${String(color.b)}`;
        const gradient = context.createRadialGradient(field.cx, field.cy, 0, field.cx, field.cy, field.r);
        gradient.addColorStop(0, `rgba(${rgb}, ${String(alpha)})`);
        gradient.addColorStop(0.45, `rgba(${rgb}, ${String(alpha * 0.55)})`);
        gradient.addColorStop(1, `rgba(${rgb}, 0)`);
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
      }
      if (caps && capsContext) {
        capsContext.clearRect(0, 0, caps.width, caps.height);
        capsContext.drawImage(ground, 0, 0);
      }
    };
    // One clock for every mount (the page's own), so moving between conversations never jumps the fields.
    const now = () => (reduced.matches ? 0 : performance.now() / 1000);
    const refresh = () => {
      const size = canvasSize(window.innerWidth, window.innerHeight);
      for (const canvas of [ground, caps]) {
        if (!canvas) continue;
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
      }
      draw(now());
    };
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (time - last < 1000 / BREATHING_FPS) return;
      last = time;
      draw(time / 1000);
    };
    const start = () => {
      if (frame !== 0 || reduced.matches || document.hidden || groundCovered()) return;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const onCover = () => {
      if (groundCovered()) stop();
      else start();
    };
    const onMotion = () => {
      stop();
      refresh();
      start();
    };
    const onTheme = () => {
      colors = readColors(ground);
      draw(now());
    };

    refresh();
    start();
    window.addEventListener('resize', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribeCover = subscribeGroundCover(onCover);
    reduced.addEventListener('change', onMotion);
    scheme.addEventListener('change', onTheme);
    // The theme toggle sets a class (and data-theme) on <html>: the fields' colours follow it.
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => {
      stop();
      window.removeEventListener('resize', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeCover();
      reduced.removeEventListener('change', onMotion);
      scheme.removeEventListener('change', onTheme);
      themeObserver.disconnect();
    };
  }, [slow]);

  if (slow) return null;
  return (
    <>
      <canvas ref={groundRef} aria-hidden data-slot="breathing-ground" className="breathing-ground" />
      <canvas
        ref={capsRef}
        aria-hidden
        data-slot="breathing-caps"
        data-print="hide"
        className="breathing-ground breathing-caps ground-caps"
      />
    </>
  );
}
