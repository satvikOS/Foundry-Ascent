import { CoachMode } from '@foundry/contracts';
import { createFileRoute } from '@tanstack/react-router';

import { SessionsPage } from '@/features/coach/sessions-page';
import { sessionsQueryOptions } from '@/lib/api/hooks/sessions';

interface CoachSearch {
  /** Opens the start-session dialog with this mode preselected. */
  start?: CoachMode | undefined;
}

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/coach/')({
  validateSearch: (search: Record<string, unknown>): CoachSearch => {
    const mode = CoachMode.safeParse(search.start);
    return { start: mode.success ? mode.data : undefined };
  },
  loader: ({ context, params }) => {
    context.queryClient.query(sessionsQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Coach' }] }),
  component: SessionsPage,
});
