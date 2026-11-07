import { getRouteApi } from '@tanstack/react-router';
import { CirclePlay } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { useRecordingPages } from '@/lib/api/hooks/recording-pages';

import { RecordingsList } from './recordings-list';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/recordings');

/**
 * Recordings: the person's own recordings of their calls in this venture, latest first, to watch again with their
 * transcript (each in its own viewer) or download, without calling the vEIR. Only they can see them. A page at a time:
 * Show older reaches every recording still kept (a year's worth).
 */
export function RecordingsPage() {
  const { ventureId } = routeApi.useParams();
  const recordings = useRecordingPages(ventureId);
  const items = useMemo(() => recordings.data?.pages.flatMap((page) => page.items) ?? [], [recordings.data]);
  return (
    <PageContainer size="narrow">
      <PageHeader title="Recordings" description="Calls you recorded. Only you can watch them." />
      {recordings.isPending ? (
        <HairlineSkeleton rows={3} label="Loading recordings" />
      ) : recordings.isError && !recordings.isFetchNextPageError ? (
        <ErrorState error={recordings.error} onRetry={() => void recordings.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CirclePlay}
          title="No recordings yet"
          description="Press Record during a call to keep one here."
        />
      ) : (
        <div className="grid gap-4">
          <RecordingsList items={items} showConversation label="Your recordings" />
          {recordings.hasNextPage ? (
            <Button
              variant="secondary"
              className="justify-self-center"
              onClick={() => void recordings.fetchNextPage()}
              loading={recordings.isFetchingNextPage}
              loadingText="Loading…"
            >
              Show older recordings
            </Button>
          ) : null}
          {recordings.isFetchNextPageError ? (
            // The recordings already shown stay; only the failed page is reported.
            <ErrorState
              size="sm"
              error={recordings.error}
              title="Couldn’t load older recordings"
              onRetry={() => void recordings.fetchNextPage()}
            />
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
