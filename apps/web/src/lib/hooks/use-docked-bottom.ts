import { useCallback, useEffect, useState } from 'react';

/**
 * For content docked to the bottom of the viewport (a sticky composer): keeps the page's
 * `scroll-padding-bottom` equal to the dock's height while it is mounted, so anything scrolled or
 * focused into view (a button reached with Tab, a citation target) lands above the dock instead of
 * behind it (WCAG 2.4.11, focus not obscured). Returns a callback ref for the dock element.
 *
 * Uses the CSSOM (allowed under the strict CSP, unlike style attributes) and restores the previous
 * value on unmount.
 */
export function useDockedBottom(): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!element) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    const apply = () => {
      root.style.scrollPaddingBottom = `${Math.ceil(element.getBoundingClientRect().height)}px`;
    };
    apply();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.scrollPaddingBottom = previous;
    };
  }, [element]);

  return useCallback((next: HTMLElement | null) => {
    setElement(next);
  }, []);
}
