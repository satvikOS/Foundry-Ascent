import { createFileRoute } from '@tanstack/react-router';

import { EscalationQueuePage } from '@/features/program/escalations/escalation-queue-page';

export const Route = createFileRoute('/$tenant/app/program/escalations')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/program')
      .then(({ programEscalationsQueryOptions }) =>
        context.queryClient.query(programEscalationsQueryOptions()),
      )
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Escalation queue' }] }),
  component: EscalationQueuePage,
});
