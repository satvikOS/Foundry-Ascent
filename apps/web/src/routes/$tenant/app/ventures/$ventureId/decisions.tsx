import { createFileRoute } from '@tanstack/react-router';

import { DecisionsView } from '@/features/memory/typed/decisions-view';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/decisions')({
  loader: ({ context, params }) => {
    context.queryClient
      .query(memoryQueryOptions(params.ventureId, { type: 'decision' }))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Decisions' }] }),
  component: DecisionsView,
});
