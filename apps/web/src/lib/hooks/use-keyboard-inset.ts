import { useEffect } from 'react';

/** The CSS variable that holds how much of the layout viewport the on-screen keyboard covers. */
export const KEYBOARD_INSET_VAR = '--keyboard-inset';

/** Below this, a visual viewport smaller than the layout viewport is browser chrome or a pinch zoom, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

/**
 * How much of the layout viewport an on-screen keyboard covers, from the visual viewport: the layout viewport's
 * height less the visible part and how far that part is panned down. 0 when nothing covers it: no keyboard, a
 * browser that resizes the page for its keyboard (Chrome and Firefox on Android, with `interactive-widget=
 * resizes-content`), or a pinch zoom (the scale is not 1).
 */
export function keyboardInset(
  layoutHeight: number,
  viewport: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>,
): number {
  if (Math.abs(viewport.scale - 1) > 0.01) return 0;
  const covered = Math.round(layoutHeight - viewport.height - viewport.offsetTop);
  return covered >= KEYBOARD_MIN_PX ? covered : 0;
}

/**
 * Keeps `--keyboard-inset` (and `data-keyboard="open"` on the root) in step with the on-screen keyboard where the
 * browser lays it over the page instead of resizing it (Safari on iPhone and iPad): the conversation's composer is
 * docked that far up, so it stays in view above the keyboard while the person types. Mounted once by the app shell;
 * written through the CSSOM (allowed under the strict CSP) once per frame at most, and only when it changes.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    let last = -1;
    const apply = () => {
      frame = 0;
      const inset = keyboardInset(window.innerHeight, viewport);
      if (inset === last) return;
      last = inset;
      root.style.setProperty(KEYBOARD_INSET_VAR, `${String(inset)}px`);
      if (inset > 0) root.dataset.keyboard = 'open';
      else delete root.dataset.keyboard;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
      root.style.removeProperty(KEYBOARD_INSET_VAR);
      delete root.dataset.keyboard;
    };
  }, []);
}
