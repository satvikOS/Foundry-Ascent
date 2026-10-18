import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** How close to the end still counts as "at the end" (rounding, a stray pixel of scroll). */
export const AT_END_SLACK_PX = 4;

/** Keys that scroll the page up (outside a text field). */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * How far the end of the conversation (the bottom edge of its column, `endBottom`, in viewport pixels) lies below
 * what the reader can see above the composer dock: the viewport less the dock's real height. Positive: hidden by
 * that many pixels; zero or less: in view.
 */
export function hiddenBelowDock(endBottom: number, viewportHeight: number, dockHeight: number): number {
  return endBottom - (viewportHeight - dockHeight);
}

/**
 * Whether the reader still follows the end of the conversation after a scroll: arriving at the end (by any means)
 * follows it; scrolling up away from it (the wheel, a swipe, a key, a link to something earlier) stops; any other
 * scroll (the page brought down to a message just sent) changes nothing.
 */
export function followsAfterScroll(
  following: boolean,
  move: { from: number; to: number; hidden: number },
): boolean {
  if (move.hidden <= AT_END_SLACK_PX) return true;
  if (move.to < move.from - 1) return false;
  return following;
}

export interface KeepEndInView {
  /** The conversation, composer included: observed as it grows (the answer streaming in, chips, the saved line). */
  conversationRef: (element: HTMLElement | null) => void;
  /** The conversation's column, whose bottom edge is the end the reader follows. */
  endRef: (element: HTMLElement | null) => void;
  /** The composer dock: its real height is what can hide the end. */
  dockRef: (element: HTMLElement | null) => void;
  /** A message was just sent: follow its answer's end as it grows, until the reader scrolls away. */
  follow: () => void;
}

/**
 * Keeps the end of a conversation in view above the composer while an answer comes in and when it finishes: its
 * last lines, then its actions, and the follow-up chips the composer gains at that moment, however long the answer
 * and however tall the composer grows (LAB-U1: a four-paragraph answer and long chips left the actions behind the
 * composer). The page follows the end from the moment a message is sent (or whenever the reader is at the end) and
 * stops as soon as the reader scrolls up away from it: someone reading the answer from its start is never moved.
 *
 * The page moves only while an answer streams in (`streaming`) or when `changeKey` changes (what just finished:
 * the latest exchange, its follow-ups, its saved line), never because the reader opened something at the end.
 * Distances are measured against the dock's real height, read from its box as it is now.
 */
export function useKeepEndInView({
  changeKey,
  streaming,
}: {
  changeKey: string;
  streaming: boolean;
}): KeepEndInView {
  const conversation = useRef<HTMLElement | null>(null);
  const end = useRef<HTMLElement | null>(null);
  const dock = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const following = useRef(false);
  const lastScrollY = useRef(0);
  const streamingNow = useRef(streaming);

  /** Pixels of the conversation's end hidden below the dock (or the viewport, when there is no dock). */
  const hidden = useCallback((): number => {
    const column = end.current;
    if (!column) return 0;
    return hiddenBelowDock(
      column.getBoundingClientRect().bottom,
      window.innerHeight,
      dock.current?.getBoundingClientRect().height ?? 0,
    );
  }, []);

  const reveal = useCallback(() => {
    const by = hidden();
    if (by > 1) window.scrollBy({ top: by, behavior: 'instant' });
  }, [hidden]);

  useLayoutEffect(() => {
    streamingNow.current = streaming;
  }, [streaming]);

  useEffect(() => {
    lastScrollY.current = window.scrollY;
    let touchY: number | null = null;
    const onScroll = () => {
      const to = window.scrollY;
      following.current = followsAfterScroll(following.current, {
        from: lastScrollY.current,
        to,
        hidden: hidden(),
      });
      lastScrollY.current = to;
    };
    // The reader's own move up (when the page can go up) stops the following at once: a wheel or a swipe scrolls
    // over several frames, and a unit streamed in before the first of them must not pull the page back down.
    const stop = () => {
      if (window.scrollY > 0) following.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stop();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && y > touchY + 2) stop();
      touchY = y ?? touchY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      if (UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) stop();
    };
    const onResize = () => {
      if (following.current) reveal();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [hidden, reveal]);

  // Runs after the change is in the DOM and before it is painted, so the reader never sees the end hidden.
  useLayoutEffect(() => {
    if (following.current) reveal();
  }, [changeKey, reveal]);

  /** (Re)observes whichever parts are mounted: growth while an answer streams keeps its end in view. */
  const observe = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    if (typeof ResizeObserver === 'undefined') return;
    const targets = [conversation.current, end.current, dock.current].filter(
      (element): element is HTMLElement => element !== null,
    );
    if (targets.length === 0) return;
    const next = new ResizeObserver(() => {
      if (following.current && streamingNow.current) reveal();
    });
    for (const target of targets) next.observe(target);
    observer.current = next;
  }, [reveal]);

  const conversationRef = useCallback(
    (element: HTMLElement | null) => {
      conversation.current = element;
      observe();
    },
    [observe],
  );
  /**
   * Where the reader starts, measured again as each part attaches (the column may attach before the dock): following
   * when the end of the conversation is in view above the dock.
   */
  const start = useCallback(() => {
    if (end.current) following.current = hidden() <= AT_END_SLACK_PX;
  }, [hidden]);
  const endRef = useCallback(
    (element: HTMLElement | null) => {
      end.current = element;
      start();
      observe();
    },
    [start, observe],
  );
  const dockRef = useCallback(
    (element: HTMLElement | null) => {
      dock.current = element;
      start();
      observe();
    },
    [start, observe],
  );
  const follow = useCallback(() => {
    following.current = true;
  }, []);

  return { conversationRef, endRef, dockRef, follow };
}
