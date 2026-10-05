import { createFileRoute } from '@tanstack/react-router';

import { DocumentsPage } from '@/features/documents/documents-page';
import { documentsQueryOptions } from '@/lib/api/hooks/documents';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/documents')({
  loader: ({ context, params }) => {
    context.queryClient.query(documentsQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Documents' }] }),
  component: DocumentsPage,
});
