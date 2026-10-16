import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';

import { viewerSearchFor } from './viewer-search';

/*
 * Whatever opens a document is a plain router link to the same page with the viewer's params
 * (`?doc=` or `?src=`, `&passage=`), `state.documentViewer` and `resetScroll={false}`, marked
 * `data-opens-document`: a new history entry (Back closes the viewer), the page keeps its scroll, and it can
 * open in a new tab. Links import nothing from here, so no page's bundle carries the viewer.
 */

/** Loads the viewer's code ahead of a click. */
export function preloadDocumentViewer(): void {
  void import('./viewer-dialog').catch(() => undefined);
}

/** Preloads the viewer when a pointer or focus reaches anything marked `data-opens-document`. */
export function usePreloadOnIntent(): void {
  useEffect(() => {
    let done = false;
    const onIntent = (event: Event) => {
      if (done || !(event.target instanceof Element) || !event.target.closest('[data-opens-document]'))
        return;
      done = true;
      preloadDocumentViewer();
    };
    document.addEventListener('pointerover', onIntent, { passive: true });
    document.addEventListener('focusin', onIntent);
    return () => {
      document.removeEventListener('pointerover', onIntent);
      document.removeEventListener('focusin', onIntent);
    };
  }, []);
}

/**
 * Closes the viewer: back to the page it was opened over when it was opened in the app, otherwise (a link
 * opened straight into it) the same page without the viewer.
 */
export function useCloseDocumentViewer(): () => void {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const openedHere = location.state.documentViewer === true;
  return useCallback(() => {
    if (openedHere && router.history.canGoBack()) {
      router.history.back();
      return;
    }
    void navigate({
      to: '.',
      search: (previous) => viewerSearchFor(previous, null),
      replace: true,
      resetScroll: false,
    });
  }, [navigate, openedHere, router]);
}
