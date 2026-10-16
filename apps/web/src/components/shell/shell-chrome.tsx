import { createContext, useContext, useLayoutEffect } from 'react';

/**
 * What a page may ask of the app shell's chrome on phones. A page with a header of its own (a
 * conversation) takes over the phone bar: the shell hides its bar while the page claims it, and the page's
 * header opens the navigation sheet instead, so a phone shows one bar, not two.
 */
export interface ShellChrome {
  openNavigation: () => void;
  /** Hides the shell's phone bar until the returned release is called. */
  claimMobileBar: () => () => void;
}

export const ShellChromeContext = createContext<ShellChrome | null>(null);

/**
 * Claims the phone bar for the calling page while it is mounted and returns how to open the navigation
 * sheet (null outside the app shell, e.g. in tests).
 */
export function usePageMobileBar(): (() => void) | null {
  const chrome = useContext(ShellChromeContext);
  useLayoutEffect(() => chrome?.claimMobileBar(), [chrome]);
  return chrome?.openNavigation ?? null;
}
