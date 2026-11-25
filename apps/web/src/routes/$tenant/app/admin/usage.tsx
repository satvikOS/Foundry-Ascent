import { createFileRoute } from '@tanstack/react-router';

import { UsagePage } from '@/features/admin/usage/usage-page';

export const Route = createFileRoute('/$tenant/app/admin/usage')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/admin')
      .then(({ usageQueryOptions }) => context.queryClient.query(usageQueryOptions()))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Usage' }] }),
  component: UsagePage,
});
