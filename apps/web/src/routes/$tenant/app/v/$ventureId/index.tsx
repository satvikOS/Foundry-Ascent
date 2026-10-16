import { createFileRoute } from '@tanstack/react-router';

import { NewChatPage } from '@/features/chat/new-chat-page';
import { ventureOverviewQueryOptions } from '@/lib/api/hooks/ventures';

interface NewChatSearch {
  /** Opens a call with the vEIR (`?call=1`); the call screen reads it. */
  call?: 1 | undefined;
}

/** New chat: the vEIR greets the founder; the first message starts the conversation. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/')({
  validateSearch: (search: Record<string, unknown>): NewChatSearch => ({
    call: search.call === 1 || search.call === '1' || search.call === true ? 1 : undefined,
  }),
  loader: ({ context, params }) => {
    context.queryClient.query(ventureOverviewQueryOptions(params.ventureId)).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'New chat' }] }),
  component: NewChatPage,
});
