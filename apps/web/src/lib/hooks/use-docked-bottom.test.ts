import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DOCKED_BOTTOM_VAR, useDockedBottom } from './use-docked-bottom';

const observers: ResizeObserverCallback[] = [];
const RealResizeObserver = window.ResizeObserver;

beforeEach(() => {
  observers.length = 0;
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback);
    }
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  };
});
afterEach(() => {
  window.ResizeObserver = RealResizeObserver;
  document.documentElement.style.removeProperty(DOCKED_BOTTOM_VAR);
});

const value = () => document.documentElement.style.getPropertyValue(DOCKED_BOTTOM_VAR);

describe('useDockedBottom', () => {
  it('keeps the dock’s real height in a CSS variable as it grows and shrinks, and clears it when it goes', () => {
    let height = 131.2;
    const dock = document.createElement('div');
    dock.getBoundingClientRect = () => ({ height }) as DOMRect;
    const { result, unmount } = renderHook(() => useDockedBottom());
    act(() => {
      result.current(dock);
    });
    expect(value()).toBe('132px');
    // Long follow-up chips arrive: the dock grows, and the variable with it.
    height = 176;
    act(() => {
      for (const callback of observers) callback([], {} as ResizeObserver);
    });
    expect(value()).toBe('176px');
    unmount();
    expect(value()).toBe('');
  });

  it('the stylesheet makes it the page’s scroll padding, so focus and scroll targets land above the dock', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, '..', '..', 'styles', 'globals.css'), 'utf8');
    const html = /\n {2}html \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(html).toContain(`scroll-padding-bottom: var(${DOCKED_BOTTOM_VAR});`);
    expect(css).toContain(`${DOCKED_BOTTOM_VAR}: 0px;`);
  });
});
