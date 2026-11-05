import { createFileRoute } from '@tanstack/react-router';

import { VenturePage } from '@/features/venture/venture-settings-page';
import { teamQueryOptions } from '@/lib/api/hooks/team';

/** The Venture page: profile (name, one-liner, stage), current goal and team. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/settings')({
  loader: ({ context, params }) => {
    context.queryClient.query(teamQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Venture' }] }),
  component: VenturePage,
});
