import { createFileRoute } from '@tanstack/react-router';

import { ResourcesPage } from '@/features/program/resources/resources-page';

export const Route = createFileRoute('/$tenant/app/program/resources')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/program')
      .then(({ resourcesQueryOptions }) => context.queryClient.query(resourcesQueryOptions()))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Resources' }] }),
  component: ResourcesPage,
});
