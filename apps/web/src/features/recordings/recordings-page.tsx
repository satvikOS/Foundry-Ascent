import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { CirclePlay } from 'lucide-react';

import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { useRecordings } from '@/lib/api/hooks/recordings';

import { RecordingsList } from './recordings-list';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/recordings');

/**
 * Recordings: the person's own recordings of their calls in this venture, latest first, to watch again with their
 * captions without calling the vEIR. Only they can see them; `?r=` opens one.
 */
export function RecordingsPage() {
  const { ventureId } = routeApi.useParams();
  const { r: playing = null } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/$tenant/app/v/$ventureId/recordings' });
  const recordings = useRecordings({ ventureId });
  const play = (id: string | null) => {
    void navigate({ search: id === null ? {} : { r: id }, replace: true });
  };
  return (
    <PageContainer size="narrow">
      <PageHeader title="Recordings" description="Calls you recorded. Only you can watch them." />
      {recordings.isPending ? (
        <HairlineSkeleton rows={3} label="Loading recordings" />
      ) : recordings.isError ? (
        <ErrorState error={recordings.error} onRetry={() => void recordings.refetch()} />
      ) : recordings.data.items.length === 0 ? (
        <EmptyState
          icon={CirclePlay}
          title="No recordings yet"
          description="Press Record during a call to keep one here."
        />
      ) : (
        <RecordingsList
          items={recordings.data.items}
          playing={playing}
          onPlay={play}
          showConversation
          label="Your recordings"
        />
      )}
    </PageContainer>
  );
}
