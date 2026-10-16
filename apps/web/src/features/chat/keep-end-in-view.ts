import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** How close to the end of the page still counts as "at the end" (rounding, a stray pixel of scroll). */
const AT_END_SLACK_PX = 4;

function atEnd(): boolean {
  const root = document.documentElement;
  return window.scrollY + window.innerHeight >= root.scrollHeight - AT_END_SLACK_PX;
}

/**
 * Keeps the end of a conversation in view when an answer finishes: if the reader was at the end of the page
 * just before (the answer fit, or they followed it down), the page moves with the new end, so the answer's
 * actions and the follow-up chips above the composer are both in view instead of the actions sliding under
 * the composer. A reader who was further up (reading a long answer from its start) is never moved.
 *
 * `changeKey` names what just finished (the latest exchange and its follow-ups). Returns a callback ref for the
 * element whose growth is watched (the conversation, composer included).
 */
export function useKeepEndInView(changeKey: string): (element: HTMLElement | null) => void {
  // Whether the reader was at the end before the latest change (measured on scroll and after every resize).
  const wasAtEnd = useRef(false);
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const onScroll = () => {
      wasAtEnd.current = atEnd();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      observer.current?.disconnect();
    };
  }, []);

  // Runs after the change is in the DOM and before the next resize measurement: `wasAtEnd` still describes the
  // page as it was.
  useLayoutEffect(() => {
    if (!wasAtEnd.current) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  }, [changeKey]);

  return useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(() => {
      wasAtEnd.current = atEnd();
    });
    observer.current.observe(element);
    wasAtEnd.current = atEnd();
  }, []);
}
