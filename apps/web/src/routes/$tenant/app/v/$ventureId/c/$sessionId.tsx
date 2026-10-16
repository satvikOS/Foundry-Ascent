import { createFileRoute } from '@tanstack/react-router';

import { SessionPage } from '@/features/coach/session-canvas';
import { sessionQueryOptions } from '@/lib/api/hooks/sessions';

interface ConversationSearch {
  /** Ended conversations: show the recap (default) or the transcript. */
  view?: 'recap' | 'transcript' | undefined;
  /** Opens a call in this conversation (`?call=1`); the call screen reads it. */
  call?: 1 | undefined;
}

export const Route = createFileRoute('/$tenant/app/v/$ventureId/c/$sessionId')({
  validateSearch: (search: Record<string, unknown>): ConversationSearch => ({
    view: search.view === 'recap' || search.view === 'transcript' ? search.view : undefined,
    call: search.call === 1 || search.call === '1' || search.call === true ? 1 : undefined,
  }),
  loader: ({ context, params }) => {
    context.queryClient.query(sessionQueryOptions(params.sessionId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Conversation' }] }),
  component: SessionPage,
});
