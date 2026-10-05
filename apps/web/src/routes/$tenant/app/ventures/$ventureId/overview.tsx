import { createFileRoute } from '@tanstack/react-router';

import { OverviewPage } from '@/features/venture/overview-page';
import { ventureOverviewQueryOptions } from '@/lib/api/hooks/ventures';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/overview')({
  loader: ({ context, params }) => {
    context.queryClient.query(ventureOverviewQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Overview' }] }),
  component: OverviewPage,
});
