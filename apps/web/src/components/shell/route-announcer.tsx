import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { announce } from '@/components/a11y/live-announcer';

export const APP_NAME = 'Foundry Ascent';

/** Compose a document title. */
export function documentTitle(title: string | undefined): string {
  return title ? `${title} · ${APP_NAME}` : APP_NAME;
}

/**
 * Document title + route-change focus management (WCAG 2.4.2, 2.4.3).
 *
 * Titles come from each route's `head` option, deepest match wins:
 *   export const Route = createFileRoute('/…')({ head: () => ({ meta: [{ title: 'Memory' }] }) });
 *
 * After a client-side navigation that changes the path (not search-only changes such as filters),
 * focus moves to the page's <h1 data-page-title> (rendered by <PageHeader>) or, failing that, to
 * <main id="main-content"> with the title announced via the live region.
 */
export function RouteAnnouncer() {
  const router = useRouter();
  const title = useRouterState({
    select: (state) => {
      let found: string | undefined;
      for (const match of state.matches) {
        for (const meta of match.meta ?? []) {
          if (meta && 'title' in meta && typeof meta.title === 'string') found = meta.title;
        }
      }
      return found;
    },
  });
  const titleRef = useRef(title);

  useEffect(() => {
    titleRef.current = title;
    document.title = documentTitle(title);
  }, [title]);

  useEffect(() => {
    let first = true;
    return router.subscribe('onResolved', (event) => {
      if (first) {
        first = false;
        return;
      }
      if (!event.pathChanged) return;
      requestAnimationFrame(() => {
        const heading = document.querySelector<HTMLElement>('main [data-page-title]');
        if (heading) {
          heading.focus({ preventScroll: true });
          return;
        }
        const main = document.getElementById('main-content');
        if (main) {
          main.focus({ preventScroll: true });
          announce(titleRef.current ?? APP_NAME);
        }
      });
    });
  }, [router]);

  return null;
}
