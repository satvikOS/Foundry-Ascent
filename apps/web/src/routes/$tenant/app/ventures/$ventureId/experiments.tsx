import { createFileRoute } from '@tanstack/react-router';

import { ExperimentsView } from '@/features/memory/typed/experiments-view';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/experiments')({
  loader: ({ context, params }) => {
    context.queryClient
      .query(memoryQueryOptions(params.ventureId, { type: 'experiment' }))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Experiments' }] }),
  component: ExperimentsView,
});
