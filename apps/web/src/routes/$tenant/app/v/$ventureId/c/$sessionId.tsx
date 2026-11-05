import { createFileRoute } from '@tanstack/react-router';

import { callSearch, type CallKind } from '@/features/calls/call-kind';
import { ConversationPage } from '@/features/chat/conversation-page';
import { sessionQueryOptions } from '@/lib/api/hooks/sessions';
import { canWrite } from '@/lib/auth/roles';

interface ConversationSearch {
  /** An ended conversation opened at its summary (`?view=digest`; the old `recap` link means the same). */
  view?: 'digest' | undefined;
  /** Opens a call in this conversation (`?call=voice|video`; an older `?call=1` is voice); the call screen reads it. */
  call?: CallKind | undefined;
}

export const Route = createFileRoute('/$tenant/app/v/$ventureId/c/$sessionId')({
  validateSearch: (search: Record<string, unknown>): ConversationSearch => ({
    view: search.view === 'digest' || search.view === 'recap' ? 'digest' : undefined,
    call: callSearch(search),
  }),
  loader: ({ context, params }) => {
    // Conversations are read by founders and team only: read-only roles never request them.
    if (!canWrite(context.me, params.ventureId)) return;
    context.queryClient.query(sessionQueryOptions(params.sessionId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Conversation' }] }),
  component: ConversationPage,
});
