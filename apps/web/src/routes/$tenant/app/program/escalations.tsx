import { createFileRoute } from '@tanstack/react-router';

import { EscalationQueuePage } from '@/features/program/escalations/escalation-queue-page';
import { programEscalationsQueryOptions } from '@/lib/api/hooks/program';

export const Route = createFileRoute('/$tenant/app/program/escalations')({
  loader: ({ context }) => {
    context.queryClient.query(programEscalationsQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Escalation queue' }] }),
  component: EscalationQueuePage,
});
