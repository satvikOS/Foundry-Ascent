import { createFileRoute } from '@tanstack/react-router';

import { PrincipalsPage } from '@/features/admin/principals/principals-page';
import { principalsQueryOptions } from '@/lib/api/hooks/admin';

export const Route = createFileRoute('/admin/principals')({
  loader: ({ context }) => {
    context.queryClient.query(principalsQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Principals' }] }),
  component: PrincipalsPage,
});
