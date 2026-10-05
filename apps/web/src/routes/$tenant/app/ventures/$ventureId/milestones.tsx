import { createFileRoute } from '@tanstack/react-router';

import { MilestonesView } from '@/features/memory/typed/milestones-view';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/milestones')({
  loader: ({ context, params }) => {
    context.queryClient
      .query(memoryQueryOptions(params.ventureId, { type: 'milestone' }))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Milestones' }] }),
  component: MilestonesView,
});
