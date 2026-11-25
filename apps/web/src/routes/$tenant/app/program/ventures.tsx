import { createFileRoute } from '@tanstack/react-router';

import { ProgramVenturesPage } from '@/features/program/program-ventures';

export const Route = createFileRoute('/$tenant/app/program/ventures')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/program')
      .then(({ programVenturesQueryOptions }) => context.queryClient.query(programVenturesQueryOptions()))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Ventures' }] }),
  component: ProgramVenturesPage,
});
