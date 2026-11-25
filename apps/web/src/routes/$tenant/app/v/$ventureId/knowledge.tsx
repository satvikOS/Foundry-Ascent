import { createFileRoute } from '@tanstack/react-router';

import { KnowledgePage } from '@/features/knowledge/knowledge-page';
import { validateKnowledgeSearch } from '@/features/knowledge/search';

/**
 * Knowledge: the venture's memory (`?type=decision`, `?q=…`), the vEIR's notebook, conversation digests and
 * evidence (`?view=…`).
 */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/knowledge')({
  validateSearch: validateKnowledgeSearch,
  loader: ({ context, params }) => {
    // Warm the unfiltered list (type chips and the detail lookup); the page renders skeletons meanwhile.
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/memory')
      .then(({ memoryQueryOptions }) => context.queryClient.query(memoryQueryOptions(params.ventureId)))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Knowledge' }] }),
  component: KnowledgePage,
});
