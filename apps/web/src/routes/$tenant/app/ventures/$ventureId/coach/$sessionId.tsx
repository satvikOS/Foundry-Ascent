import { createFileRoute } from '@tanstack/react-router';

import { SessionPage } from '@/features/coach/session-canvas';
import { sessionQueryOptions } from '@/lib/api/hooks/sessions';

interface SessionSearch {
  /** Ended sessions: show the recap (default) or the transcript. */
  view?: 'recap' | 'transcript' | undefined;
}

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/coach/$sessionId')({
  validateSearch: (search: Record<string, unknown>): SessionSearch => ({
    view: search.view === 'recap' || search.view === 'transcript' ? search.view : undefined,
  }),
  loader: ({ context, params }) => {
    context.queryClient.query(sessionQueryOptions(params.sessionId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Session' }] }),
  component: SessionPage,
});
