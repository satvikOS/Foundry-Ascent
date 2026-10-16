import { useLocation } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { useCloseDocumentViewer, usePreloadOnIntent } from './use-document-viewer';
import { validateDocumentViewerSearch, viewerTarget, type ViewerTarget } from './viewer-search';

const DocumentViewerDialog = lazy(() => import('./viewer-dialog'));

/**
 * Hosts the document viewer for a venture's pages: it opens whenever the URL names a document (`?doc=`) or
 * a cited source (`?src=`), over whatever page is showing. Its code loads on first use.
 */
export function DocumentViewerHost({ ventureId }: { ventureId: string }) {
  usePreloadOnIntent();
  // The venture's routes pass the viewer's params through untouched; they are checked here.
  const search: Record<string, unknown> = useLocation().search;
  const target = viewerTarget(validateDocumentViewerSearch(search));
  if (target === null) return null;
  return <OpenViewer ventureId={ventureId} target={target} />;
}

function OpenViewer({ ventureId, target }: { ventureId: string; target: ViewerTarget }) {
  const close = useCloseDocumentViewer();
  // Focus goes back where it was when the viewer opened (the row, citation or chip that opened it).
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  return (
    <Suspense
      fallback={
        <div
          role="status"
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 text-small text-white backdrop-blur-[2px]"
        >
          Opening…
        </div>
      }
    >
      <DocumentViewerDialog ventureId={ventureId} target={target} onClose={close} returnFocus={returnFocus} />
    </Suspense>
  );
}
