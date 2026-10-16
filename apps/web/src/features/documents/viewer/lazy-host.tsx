import { lazy, Suspense } from 'react';

const Host = lazy(() =>
  import('./document-viewer-host').then((module) => ({ default: module.DocumentViewerHost })),
);

/**
 * The document viewer over a venture's pages, loaded after the page itself: it renders nothing until the
 * URL names a document, so none of its code (or the router hooks it uses) is on the page's critical path.
 */
export function LazyDocumentViewerHost({ ventureId }: { ventureId: string }) {
  return (
    <Suspense fallback={null}>
      <Host ventureId={ventureId} />
    </Suspense>
  );
}
