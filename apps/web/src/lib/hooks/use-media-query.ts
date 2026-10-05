import { useCallback, useSyncExternalStore } from 'react';

/** Subscribe to a CSS media query. Returns `fallback` where matchMedia is unavailable. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', listener);
      return () => {
        mql.removeEventListener('change', listener);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback;
    return window.matchMedia(query).matches;
  }, [query, fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}

/** Tailwind breakpoints (keep in sync with the default theme). */
export const BREAKPOINTS = {
  md: '(min-width: 48rem)',
  lg: '(min-width: 64rem)',
  xl: '(min-width: 80rem)',
} as const;

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
