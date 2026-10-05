import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';

import { ReviewsPage, type ReviewFilter } from '@/features/eir/reviews/reviews-page';
import { reviewQueueQueryOptions } from '@/lib/api/hooks/eir';
import { hasRole } from '@/lib/auth/roles';

interface ReviewsSearch {
  turn?: string | undefined;
  tab?: ReviewFilter | undefined;
}

export const Route = createFileRoute('/$tenant/app/eir/reviews')({
  validateSearch: (search: Record<string, unknown>): ReviewsSearch => ({
    turn: typeof search.turn === 'string' && /^[0-9a-f-]{36}$/i.test(search.turn) ? search.turn : undefined,
    tab: search.tab === 'reviewed' ? 'reviewed' : undefined,
  }),
  loader: ({ context }) => {
    // Only EIRs have a review queue (the API answers 403 to everyone else).
    if (!hasRole(context.me, 'eir')) return;
    context.queryClient.query(reviewQueueQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Calibration reviews' }] }),
  component: ReviewsRoute,
});

function ReviewsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSelect = useCallback(
    (turn: string | undefined) => {
      void navigate({ search: (prev) => ({ ...prev, turn }), replace: true });
    },
    [navigate],
  );
  const onFilterChange = useCallback(
    (tab: ReviewFilter) => {
      void navigate({ search: { tab: tab === 'reviewed' ? 'reviewed' : undefined }, replace: true });
    },
    [navigate],
  );
  return (
    <ReviewsPage
      selectedTurnId={search.turn}
      filter={search.tab ?? 'pending'}
      onSelect={onSelect}
      onFilterChange={onFilterChange}
    />
  );
}
