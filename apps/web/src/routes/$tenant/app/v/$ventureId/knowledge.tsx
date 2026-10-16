import { createFileRoute } from '@tanstack/react-router';

import { KnowledgePage } from '@/features/knowledge/knowledge-page';
import { validateKnowledgeSearch } from '@/features/knowledge/search';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';

/**
 * Knowledge: the venture's memory (`?type=decision`, `?status=…`, `?q=…`), the "To review" queue
 * (`?view=proposed`), the vEIR's notebook, conversation digests and evidence (`?view=…`).
 */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/knowledge')({
  validateSearch: validateKnowledgeSearch,
  loader: ({ context, params }) => {
    // Warm the unfiltered list (type chips and the detail lookup); the page renders skeletons meanwhile.
    context.queryClient.query(memoryQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Knowledge' }] }),
  component: KnowledgePage,
});
