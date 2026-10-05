import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';

import { InboxPage, type InboxFilter } from '@/features/eir/inbox/inbox-page';
import { inboxEscalationsQueryOptions } from '@/lib/api/hooks/escalations';

interface InboxSearch {
  id?: string | undefined;
  tab?: InboxFilter | undefined;
}

export const Route = createFileRoute('/$tenant/app/eir/inbox')({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    id: typeof search.id === 'string' && /^[0-9a-f-]{36}$/i.test(search.id) ? search.id : undefined,
    tab: search.tab === 'closed' ? 'closed' : undefined,
  }),
  loader: ({ context }) => {
    context.queryClient.query(inboxEscalationsQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Escalation inbox' }] }),
  component: InboxRoute,
});

function InboxRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSelect = useCallback(
    (id: string | undefined) => {
      void navigate({ search: (prev) => ({ ...prev, id }), replace: true });
    },
    [navigate],
  );
  const onFilterChange = useCallback(
    (tab: InboxFilter) => {
      void navigate({ search: { tab: tab === 'closed' ? 'closed' : undefined }, replace: true });
    },
    [navigate],
  );
  return (
    <InboxPage
      selectedId={search.id}
      filter={search.tab ?? 'open'}
      onSelect={onSelect}
      onFilterChange={onFilterChange}
    />
  );
}
