import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { EscalationsPage } from '@/features/escalations/escalations-page';
import { ventureEscalationsQueryOptions } from '@/lib/api/hooks/escalations';
import { canWrite } from '@/lib/auth/roles';

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
    // Only founders and the team read the venture's requests (the API answers 403 to everyone else).
    if (!canWrite(context.me, params.ventureId)) return;
    context.queryClient.query(ventureEscalationsQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Human help' }] }),
  component: EscalationsPage,
});
