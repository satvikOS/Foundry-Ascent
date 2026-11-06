import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * What a page may ask of the app shell's chrome on phones. A page with a header of its own (a
 * conversation) takes over the phone bar: the shell hides its bar while the page claims it, and the page's
 * header opens the navigation sheet instead, so a phone shows one bar, not two.
 */
export interface ShellChrome {
  openNavigation: () => void;
  /** Hides the shell's phone bar until the returned release is called. */
  claimMobileBar: () => () => void;
  /** Shows the breathing ground behind the page (a conversation window) until the returned release is called. */
  claimBreathingGround: () => () => void;
}

export const ShellChromeContext = createContext<ShellChrome | null>(null);

/** Where a page may add one action to the shell's phone bar (beside New chat); null while the bar is not shown. */
export const PhoneBarSlotContext = createContext<HTMLElement | null>(null);

/**
 * Claims the phone bar for the calling page while it is mounted and returns how to open the navigation
 * sheet (null outside the app shell, e.g. in tests).
 */
export function usePageMobileBar(): (() => void) | null {
  const chrome = useContext(ShellChromeContext);
  useLayoutEffect(() => chrome?.claimMobileBar(), [chrome]);
  return chrome?.openNavigation ?? null;
}

/**
 * Puts a page's action into the shell's phone bar (New chat's context panel toggle): rendered by the page, so it
 * keeps the page's context, and shown in the bar only on phones (the bar is hidden from 768 px).
 */
export function PhoneBarAction({ children }: { children: ReactNode }) {
  const slot = useContext(PhoneBarSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/**
 * Shows the shell's breathing ground behind the calling page while it is mounted (the conversation window); nothing
 * outside the app shell (tests).
 */
export function useBreathingGround(): void {
  const chrome = useContext(ShellChromeContext);
  useLayoutEffect(() => chrome?.claimBreathingGround(), [chrome]);
}
