import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { EscalationsPage } from '@/features/escalations/escalations-page';
import { ventureEscalationsQueryOptions } from '@/lib/api/hooks/escalations';

interface HelpSearch {
  /** Selected help request. */
  id?: string | undefined;
}

/** Human help: requests for a person (EIR, program staff or a specialist), with the sharing consent. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/help')({
  validateSearch: (search: Record<string, unknown>): HelpSearch => {
    const id = z.uuid().safeParse(search.id);
    return { id: id.success ? id.data : undefined };
  },
  loader: ({ context, params }) => {
    context.queryClient.query(ventureEscalationsQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Human help' }] }),
  component: EscalationsPage,
});
