import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { DocumentsPage } from '@/features/documents/documents-page';

/** `?source=<knowledge source id>`: the document a citation links to, shown highlighted. */
export interface DocumentsSearch {
  source?: string | undefined;
}

export const Route = createFileRoute('/$tenant/app/v/$ventureId/documents')({
  validateSearch: (search: Record<string, unknown>): DocumentsSearch => {
    const source = z.uuid().safeParse(search.source);
    return { source: source.success ? source.data : undefined };
  },
  loader: ({ context, params }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/documents')
      .then(({ documentsQueryOptions }) => context.queryClient.query(documentsQueryOptions(params.ventureId)))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Documents' }] }),
  component: DocumentsPage,
});
