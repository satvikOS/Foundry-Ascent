import { createFileRoute } from '@tanstack/react-router';

import { ConversationPage } from '@/features/chat/conversation-page';
import { sessionQueryOptions } from '@/lib/api/hooks/sessions';
import { canWrite } from '@/lib/auth/roles';

interface ConversationSearch {
  /** An ended conversation opened at its summary (`?view=digest`; the old `recap` link means the same). */
  view?: 'digest' | undefined;
  /** Opens a call in this conversation (`?call=1`); the call screen reads it. */
  call?: 1 | undefined;
}

export const Route = createFileRoute('/$tenant/app/v/$ventureId/c/$sessionId')({
  validateSearch: (search: Record<string, unknown>): ConversationSearch => ({
    view: search.view === 'digest' || search.view === 'recap' ? 'digest' : undefined,
    call: search.call === 1 || search.call === '1' || search.call === true ? 1 : undefined,
  }),
  loader: ({ context, params }) => {
    // Conversations are read by founders and team only: read-only roles never request them.
    if (!canWrite(context.me, params.ventureId)) return;
    context.queryClient.query(sessionQueryOptions(params.sessionId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Conversation' }] }),
  component: ConversationPage,
});
