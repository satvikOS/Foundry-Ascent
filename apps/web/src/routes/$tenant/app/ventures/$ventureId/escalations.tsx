import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { EscalationsPage } from '@/features/escalations/escalations-page';
import { ventureEscalationsQueryOptions } from '@/lib/api/hooks/escalations';

interface EscalationsSearch {
  /** Selected escalation. */
  id?: string | undefined;
}

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/escalations')({
  validateSearch: (search: Record<string, unknown>): EscalationsSearch => {
    const id = z.uuid().safeParse(search.id);
    return { id: id.success ? id.data : undefined };
  },
  loader: ({ context, params }) => {
    context.queryClient.query(ventureEscalationsQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Escalations' }] }),
  component: EscalationsPage,
});
