import { useCallback, useEffect, useState } from 'react';

/** The CSS variable that holds the docked element's height (globals.css turns it into the page's scroll padding). */
export const DOCKED_BOTTOM_VAR = '--docked-bottom-height';

/** The CSS variable that holds the status banners' height (the right panel's height leaves room for them). */
export const STATUS_BANNERS_VAR = '--status-banners-height';

/**
 * Measures an element's real height with a ResizeObserver into a CSS variable on the root while it is mounted
 * (0 when it is empty). Uses the CSSOM (allowed under the strict CSP, unlike style attributes) and restores the
 * previous value on unmount. Returns a callback ref for the element.
 */
export function useHeightVariable(name: string): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!element) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue(name);
    const apply = () => {
      root.style.setProperty(name, `${String(Math.ceil(element.getBoundingClientRect().height))}px`);
    };
    apply();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (previous) root.style.setProperty(name, previous);
      else root.style.removeProperty(name);
    };
  }, [element, name]);

  return useCallback((next: HTMLElement | null) => {
    setElement(next);
  }, []);
}

/**
 * For content docked to the bottom of the viewport (a sticky composer): its height in `--docked-bottom-height`.
 * globals.css makes it the page's `scroll-padding-bottom`, so anything scrolled or focused into view (a button reached
 * with Tab, a citation target) lands above the dock instead of behind it (WCAG 2.4.11, focus not obscured), however
 * tall the dock grows (its follow-up chips, a long draft).
 */
export function useDockedBottom(): (element: HTMLElement | null) => void {
  return useHeightVariable(DOCKED_BOTTOM_VAR);
}
