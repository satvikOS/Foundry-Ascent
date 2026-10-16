import { useLayoutEffect, useRef } from 'react';

/** Controls used just now whose result will replace them (Keep → Kept, Good answer → Thanks, …), by key. */
const handedOff = new Set<string>();

/** Call when a control that its result will replace is used: the result takes keyboard focus when it appears. */
export function handOffFocus(key: string): void {
  handedOff.add(key);
}

/** Whether focus was left on nothing: the page, a removed element, or one that was just disabled. */
function focusLost(): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    !active.isConnected ||
    (active instanceof HTMLButtonElement && active.disabled)
  );
}

/**
 * For the element that replaces a control after it succeeded (give it `tabIndex={-1}`): when it appears for a
 * control used through {@link handOffFocus} and focus was left on nothing, it takes focus, so keyboard and
 * screen-reader users keep their place instead of starting again from the top of the page.
 */
export function useFocusHandoff<T extends HTMLElement>(key: string) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (!handedOff.has(key)) return;
    handedOff.delete(key);
    if (focusLost()) ref.current?.focus({ preventScroll: true });
  }, [key]);
  return ref;
}
