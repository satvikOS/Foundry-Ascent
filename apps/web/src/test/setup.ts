import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

const noop = (): void => undefined;

// jsdom lacks these browser APIs used by Radix and our hooks.
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

if (!('ResizeObserver' in window)) {
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: class {
      observe = noop;
      unobserve = noop;
      disconnect = noop;
    },
  });
}

for (const method of ['scrollIntoView', 'hasPointerCapture', 'releasePointerCapture'] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { writable: true, value: () => false });
  }
}

// jsdom implements window.scrollTo as a stub that logs "Not implemented"; routers and dialogs call it.
Object.defineProperty(window, 'scrollTo', { writable: true, value: noop });
