import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AT_END_SLACK_PX,
  followsAfterScroll,
  hiddenBelowDock,
  useKeepEndInView,
  type KeepEndInView,
} from './keep-end-in-view';

/*
 * A page in numbers: the viewport is 800 px tall, the composer dock at its bottom is `dock` px tall, and the
 * conversation's column ends `end` px down the document. The page scrolls the window (`scrollY`), as the app does;
 * `window.scrollBy` moves it and fires `scroll`, like a browser. ResizeObservers are captured so a test can say
 * "the conversation grew".
 */
const VIEWPORT = 800;
const page = { end: 600, dock: 120, scrollY: 0 };
const observers: ResizeObserverCallback[] = [];
const RealResizeObserver = window.ResizeObserver;
const scrollBy = vi.fn();

function setScroll(y: number): void {
  const max = Math.max(0, page.end + page.dock - VIEWPORT);
  page.scrollY = Math.max(0, Math.min(y, max));
  window.dispatchEvent(new Event('scroll'));
}

/** The conversation grows (or the dock does): the page's ResizeObservers fire, as after layout. */
function grow(change: Partial<Pick<typeof page, 'end' | 'dock'>>): void {
  Object.assign(page, change);
  act(() => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  });
}

function element(rect: () => Partial<DOMRect>): HTMLElement {
  const node = document.createElement('div');
  node.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0, ...rect() }) as DOMRect;
  return node;
}

beforeEach(() => {
  Object.assign(page, { end: 600, dock: 120, scrollY: 0 });
  observers.length = 0;
  scrollBy.mockReset();
  scrollBy.mockImplementation(({ top }: { top: number }) => {
    setScroll(page.scrollY + top);
  });
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback);
    }
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  };
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => page.scrollY });
  Object.defineProperty(window, 'scrollBy', { configurable: true, writable: true, value: scrollBy });
});
afterEach(() => {
  window.ResizeObserver = RealResizeObserver;
});

interface Props {
  changeKey: string;
  streaming: boolean;
}

/** Mounts the hook with the conversation, its column (ending at `page.end`) and the dock attached. */
function mount(initial: Props = { changeKey: 'idle', streaming: false }) {
  const hook = renderHook((props: Props) => useKeepEndInView(props), { initialProps: initial });
  const attach = (refs: KeepEndInView) => {
    act(() => {
      refs.conversationRef(element(() => ({ height: page.end })));
      refs.dockRef(element(() => ({ height: page.dock })));
      refs.endRef(element(() => ({ bottom: page.end - page.scrollY })));
    });
  };
  attach(hook.result.current);
  return hook;
}

/** Pixels of the end hidden below the dock now. */
const hiddenNow = () => hiddenBelowDock(page.end - page.scrollY, VIEWPORT, page.dock);

describe('hiddenBelowDock', () => {
  it('measures against the dock’s real height', () => {
    expect(hiddenBelowDock(900, 800, 200)).toBe(300);
    expect(hiddenBelowDock(600, 800, 200)).toBe(0);
    expect(hiddenBelowDock(500, 800, 120)).toBe(-180);
  });
});

describe('followsAfterScroll', () => {
  it('arriving at the end follows it, however the page got there', () => {
    expect(followsAfterScroll(false, { from: 0, to: 400, hidden: 0 })).toBe(true);
    expect(followsAfterScroll(false, { from: 900, to: 400, hidden: AT_END_SLACK_PX })).toBe(true);
  });

  it('scrolling up away from the end stops following', () => {
    expect(followsAfterScroll(true, { from: 900, to: 600, hidden: 300 })).toBe(false);
  });

  it('moving down short of the end (the page brought to a message just sent) changes nothing', () => {
    expect(followsAfterScroll(true, { from: 100, to: 300, hidden: 500 })).toBe(true);
    expect(followsAfterScroll(false, { from: 100, to: 300, hidden: 500 })).toBe(false);
  });
});

describe('useKeepEndInView', () => {
  it('keeps a streaming answer’s end above the dock as it grows past it (LAB-U1)', () => {
    const hook = mount();
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 1400 });
    // 1400 − (800 − 120): the end lands exactly above the dock.
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 720, behavior: 'instant' });
    expect(hiddenNow()).toBe(0);
    grow({ end: 2100 });
    expect(hiddenNow()).toBe(0);
  });

  it('when it finishes, its end clears the composer grown by long chips', () => {
    const hook = mount();
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 1400 });
    // The chips arrive with the stored answer: the dock grows from 120 to 290 px in the same commit.
    page.dock = 290;
    page.end = 1650;
    hook.rerender({ changeKey: 'completed|t1|3', streaming: false });
    expect(hiddenNow()).toBe(0);
  });

  it('a reader who scrolls up while it streams is never moved, until they come back to the end', () => {
    const hook = mount();
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 1400 });
    expect(hiddenNow()).toBe(0);
    // The wheel turns up: the page has not moved yet when the next unit arrives.
    act(() => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 }));
    });
    scrollBy.mockClear();
    grow({ end: 1700 });
    hook.rerender({ changeKey: 'completed|t1|3', streaming: false });
    expect(scrollBy).not.toHaveBeenCalled();
    // Back at the end, the page follows it again.
    hook.rerender({ changeKey: 'streaming|t2', streaming: true });
    act(() => {
      setScroll(page.end + page.dock - VIEWPORT);
    });
    grow({ end: 2300 });
    expect(hiddenNow()).toBe(0);
  });

  it('a scroll up (a link to something earlier) stops following too', () => {
    const hook = mount();
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 1400 });
    act(() => {
      setScroll(200);
    });
    scrollBy.mockClear();
    grow({ end: 1800 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('a wheel turned up on a page that cannot scroll does not stop following', () => {
    const hook = mount();
    act(() => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 }));
    });
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 1400 });
    expect(hiddenNow()).toBe(0);
  });

  it('nothing moves when the page grows while no answer streams (the reader opened something at the end)', () => {
    mount();
    grow({ end: 1400 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('an end hidden only by the dock is not "at the end", whichever part attaches first', () => {
    page.end = 750;
    const hook = renderHook((props: Props) => useKeepEndInView(props), {
      initialProps: { changeKey: 'idle', streaming: false },
    });
    act(() => {
      // React attaches the column's ref before the dock's (it comes first in the page).
      hook.result.current.endRef(element(() => ({ bottom: page.end - page.scrollY })));
      hook.result.current.dockRef(element(() => ({ height: page.dock })));
    });
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 1400 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('a message sent from further up follows its answer from then on', () => {
    page.end = 3000;
    const hook = mount();
    // Mounted at the top of a long conversation: not following.
    grow({ end: 3100 });
    hook.rerender({ changeKey: 'streaming', streaming: true });
    grow({ end: 3200 });
    expect(scrollBy).not.toHaveBeenCalled();
    act(() => {
      hook.result.current.follow();
    });
    grow({ end: 3300 });
    expect(hiddenNow()).toBe(0);
  });
});
