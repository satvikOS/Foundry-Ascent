import { createFileRoute } from '@tanstack/react-router';

import { PrincipalsPage } from '@/features/admin/principals/principals-page';

export const Route = createFileRoute('/$tenant/app/admin/principals')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/admin')
      .then(({ principalsQueryOptions }) => context.queryClient.query(principalsQueryOptions()))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'People & access' }] }),
  component: PrincipalsPage,
});
