import { createFileRoute } from '@tanstack/react-router';

import { MemoryExplorer } from '@/features/memory/memory-explorer';
import { validateMemorySearch } from '@/features/memory/search';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/memory')({
  validateSearch: validateMemorySearch,
  loader: ({ context, params }) => {
    // Warm the unfiltered list (used for the detail lookup); the page renders skeletons meanwhile.
    context.queryClient.query(memoryQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Memory' }] }),
  component: MemoryExplorer,
});
