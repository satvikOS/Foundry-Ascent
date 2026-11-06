import { createFileRoute } from '@tanstack/react-router';

import { callSearch, type CallKind } from '@/features/calls/call-kind';
import { NewChatPage } from '@/features/chat/new-chat-page';
import { conversationOpenerQueryOptions } from '@/lib/api/hooks/sessions';
import { ventureOverviewQueryOptions } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';

interface NewChatSearch {
  /** Opens a call with the vEIR (`?call=voice|video`; an older `?call=1` is voice); the call screen reads it. */
  call?: CallKind | undefined;
}

/** New chat: the vEIR greets the founder; the first message starts the conversation. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/')({
  validateSearch: (search: Record<string, unknown>): NewChatSearch => ({
    call: callSearch(search),
  }),
  loader: ({ context, params }) => {
    // The starting-point chips come from the overview; read-only roles see no composer or chips.
    if (!canWrite(context.me, params.ventureId)) return;
    context.queryClient.query(ventureOverviewQueryOptions(params.ventureId)).catch(() => undefined);
    // The greeting: fetched on a link's hover too, so New chat rarely waits for it.
    context.queryClient.query(conversationOpenerQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'New chat' }] }),
  component: NewChatPage,
});
