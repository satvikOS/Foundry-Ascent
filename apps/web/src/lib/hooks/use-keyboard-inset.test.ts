import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keyboardInset, KEYBOARD_INSET_VAR, useKeyboardInset } from './use-keyboard-inset';

describe('keyboardInset', () => {
  it('is the part of the layout viewport the keyboard covers', () => {
    // An iPhone 390 x 844 with its keyboard up: 336 px of the page hidden under it.
    expect(keyboardInset(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(336);
    // Safari panned the visible part down to the focused field: the keyboard covers less of the layout viewport.
    expect(keyboardInset(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(216);
  });

  it('is 0 with no keyboard, browser chrome, a resized page or a pinch zoom', () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0, scale: 1 })).toBe(0);
    // A collapsing toolbar is not a keyboard.
    expect(keyboardInset(844, { height: 790, offsetTop: 0, scale: 1 })).toBe(0);
    // Chrome on Android resized the page for its keyboard (interactive-widget=resizes-content).
    expect(keyboardInset(508, { height: 508, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(844, { height: 300, offsetTop: 200, scale: 2 })).toBe(0);
  });
});

describe('useKeyboardInset', () => {
  const root = document.documentElement;
  afterEach(() => {
    vi.unstubAllGlobals();
    root.style.removeProperty(KEYBOARD_INSET_VAR);
    delete root.dataset.keyboard;
  });

  it('keeps --keyboard-inset and data-keyboard in step with the visual viewport', () => {
    const listeners = new Map<string, () => void>();
    const viewport = {
      height: window.innerHeight,
      offsetTop: 0,
      scale: 1,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    vi.stubGlobal('visualViewport', viewport);
    // Frames run when the test says (as a browser runs them after the event).
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const nextFrame = () => {
      for (const callback of frames.splice(0)) callback(0);
    };
    const { unmount } = renderHook(() => {
      useKeyboardInset();
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('0px');
    expect(root.dataset.keyboard).toBeUndefined();

    act(() => {
      viewport.height = window.innerHeight - 300;
      listeners.get('resize')?.();
      nextFrame();
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('300px');
    expect(root.dataset.keyboard).toBe('open');

    act(() => {
      viewport.height = window.innerHeight;
      listeners.get('resize')?.();
      nextFrame();
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('0px');
    expect(root.dataset.keyboard).toBeUndefined();

    unmount();
    expect(listeners.size).toBe(0);
    expect(root.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('');
  });
});
