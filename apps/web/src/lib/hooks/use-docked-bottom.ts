import { useCallback, useEffect, useState } from 'react';

/** The CSS variable that holds the docked element's height (globals.css turns it into the page's scroll padding). */
export const DOCKED_BOTTOM_VAR = '--docked-bottom-height';

/**
 * For content docked to the bottom of the viewport (a sticky composer): measures the dock's real height with a
 * ResizeObserver into the `--docked-bottom-height` CSS variable on the root while it is mounted. globals.css makes
 * it the page's `scroll-padding-bottom`, so anything scrolled or focused into view (a button reached with Tab, a
 * citation target) lands above the dock instead of behind it (WCAG 2.4.11, focus not obscured), however tall the
 * dock grows (its follow-up chips, a long draft). Returns a callback ref for the dock element.
 *
 * Uses the CSSOM (allowed under the strict CSP, unlike style attributes) and restores the previous value on unmount.
 */
export function useDockedBottom(): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!element) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue(DOCKED_BOTTOM_VAR);
    const apply = () => {
      root.style.setProperty(
        DOCKED_BOTTOM_VAR,
        `${String(Math.ceil(element.getBoundingClientRect().height))}px`,
      );
    };
    apply();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (previous) root.style.setProperty(DOCKED_BOTTOM_VAR, previous);
      else root.style.removeProperty(DOCKED_BOTTOM_VAR);
    };
  }, [element]);

  return useCallback((next: HTMLElement | null) => {
    setElement(next);
  }, []);
}
