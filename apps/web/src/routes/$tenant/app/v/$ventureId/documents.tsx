import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { DocumentsPage } from '@/features/documents/documents-page';
import { documentsQueryOptions } from '@/lib/api/hooks/documents';

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
    context.queryClient.query(documentsQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Documents' }] }),
  component: DocumentsPage,
});
