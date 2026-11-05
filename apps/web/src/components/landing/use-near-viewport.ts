import { useEffect, useState, type RefObject } from 'react';

/**
 * True once the element comes within `rootMargin` of the viewport, and from then on (it loads what it needs once).
 * With `idleMs`, also true after the page has been idle that long, so content further down is ready before anyone
 * scrolls or follows an anchor to it. True at once where IntersectionObserver is missing.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  { rootMargin = '200px', idleMs }: { rootMargin?: string; idleMs?: number } = {},
): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (near || !element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (idleMs !== undefined) {
      const ready = () => {
        setNear(true);
      };
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(ready, { timeout: idleMs });
      } else {
        timer = setTimeout(ready, idleMs);
      }
    }
    return () => {
      observer.disconnect();
      if (idle !== undefined) window.cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, [ref, near, rootMargin, idleMs]);

  return near;
}
