import { createFileRoute } from '@tanstack/react-router';

import { PathPage } from '@/features/path/path-page';

/** Your path: the venture's stage, its steps and its story. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/path')({
  loader: ({ context, params }) => {
    // Loaded apart: a route's loader is in the first page load, and the path's contract is not needed there.
    void import('@/lib/api/hooks/path')
      .then(({ pathQueryOptions }) => context.queryClient.query(pathQueryOptions(params.ventureId)))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Your path' }] }),
  component: PathPage,
});
