import { createFileRoute } from '@tanstack/react-router';

import { ResourcesPage } from '@/features/program/resources/resources-page';
import { resourcesQueryOptions } from '@/lib/api/hooks/program';

export const Route = createFileRoute('/$tenant/app/program/resources')({
  loader: ({ context }) => {
    context.queryClient.query(resourcesQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Resources' }] }),
  component: ResourcesPage,
});
