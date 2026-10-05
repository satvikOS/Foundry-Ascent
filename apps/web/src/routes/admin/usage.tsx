import { createFileRoute } from '@tanstack/react-router';

import { UsagePage } from '@/features/admin/usage/usage-page';
import { usageQueryOptions } from '@/lib/api/hooks/admin';

export const Route = createFileRoute('/admin/usage')({
  loader: ({ context }) => {
    context.queryClient.query(usageQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Usage' }] }),
  component: UsagePage,
});
