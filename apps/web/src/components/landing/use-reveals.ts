import { useEffect, type RefObject } from 'react';

/**
 * One IntersectionObserver for the page's section reveals: each `[data-reveal]` element gains `.is-in` once,
 * the first time it is in view, and the CSS animates it (landing.css). The root only gets `.reveal-ready` (which
 * hides what has not been revealed) after this runs, so first paint, a failed script and anything already on
 * screen show in their final state. Under reduced motion the CSS never hides anything.
 */
export function useReveals(root: RefObject<HTMLElement | null>, ready: boolean): void {
  useEffect(() => {
    const element = root.current;
    if (!ready || !element || typeof IntersectionObserver === 'undefined') return undefined;
    const pending = [...element.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-in)')];
    // What is already on screen (or above it) is never hidden.
    const fold = window.innerHeight;
    for (const node of pending) {
      if (node.getBoundingClientRect().top < fold) node.classList.add('is-in');
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    for (const node of pending) if (!node.classList.contains('is-in')) observer.observe(node);
    element.classList.add('reveal-ready');
    return () => {
      observer.disconnect();
    };
  }, [root, ready]);
}
