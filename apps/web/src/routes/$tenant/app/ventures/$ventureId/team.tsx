import { createFileRoute } from '@tanstack/react-router';

import { TeamPage } from '@/features/venture/team-page';
import { teamQueryOptions } from '@/lib/api/hooks/team';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/team')({
  loader: ({ context, params }) => {
    context.queryClient.query(teamQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Team' }] }),
  component: TeamPage,
});
