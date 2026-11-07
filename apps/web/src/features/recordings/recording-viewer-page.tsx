import type { RecordingView } from '@foundry/contracts';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, MessageSquareText, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, spokenDuration } from '@/features/calls/use-call-clock';
import { formatBytes, formatDateTime } from '@/lib/format';

import { DeleteRecordingDialog, DownloadRecording } from './recording-actions';
import { RecordingPlayer, useRecordingReplay } from './recording-player';
import { KIND_LABEL } from './recordings-list';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/recordings_/$recordingId');

/**
 * One recording in its own page: the replay large, its transcript beside it following along (a line jumps to it),
 * and what can be done with it: Download (the recording or its transcript), Open conversation, Delete. Replay reads
 * the files from the recordings store; nothing here calls the vEIR or any model.
 */
export function RecordingViewerPage() {
  const { tenant, ventureId, recordingId } = routeApi.useParams();
  const replay = useRecordingReplay(recordingId);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<RecordingView | null>(null);
  const recording = replay.data?.recording ?? null;

  return (
    <PageContainer size="wide">
      <nav aria-label="Breadcrumb" className="pb-4">
        <Link
          to="/$tenant/app/v/$ventureId/recordings"
          params={{ tenant, ventureId }}
          className="inline-flex min-h-8 items-center gap-1 rounded-md pr-2 text-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Recordings
        </Link>
      </nav>
      {replay.isPending ? (
        <div role="status" aria-label="Loading the recording" className="grid gap-6">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="aspect-video w-full rounded-2xl lg:w-[calc(100%-23rem)]" />
        </div>
      ) : recording === null ? (
        <ErrorState
          error={replay.error}
          title="This recording couldn’t be opened"
          onRetry={() => void replay.refetch()}
        />
      ) : (
        <>
          <PageHeader
            title={recording.conversationTitle ?? 'Call recording'}
            className="pb-6"
            actions={
              <>
                <DownloadRecording recording={recording} accessibleName="Download" />
                <Button asChild variant="secondary" size="sm">
                  <Link
                    to="/$tenant/app/v/$ventureId/c/$sessionId"
                    params={{ tenant, ventureId, sessionId: recording.sessionId }}
                  >
                    <MessageSquareText aria-hidden />
                    Open conversation
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDeleting(recording);
                  }}
                >
                  <Trash2 aria-hidden />
                  <span className="max-sm:sr-only">Delete</span>
                </Button>
              </>
            }
          >
            <p className="-mt-3 flex flex-wrap gap-x-1.5 text-small text-muted-foreground">
              <span>{formatDateTime(recording.startedAt)}</span>
              <span aria-hidden>·</span>
              <span className="tabular" aria-hidden>
                {formatClock(recording.durationMs / 1000)}
              </span>
              <span className="sr-only">{spokenDuration(recording.durationMs / 1000)}</span>
              <span aria-hidden>·</span>
              <span>{KIND_LABEL[recording.kind]}</span>
              <span aria-hidden>·</span>
              <span className="tabular">{formatBytes(recording.bytes)}</span>
            </p>
          </PageHeader>
          <RecordingPlayer recording={recording} autoPlay />
        </>
      )}
      <DeleteRecordingDialog
        recording={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDeleted={() => {
          void navigate({ to: '/$tenant/app/v/$ventureId/recordings', params: { tenant, ventureId } });
        }}
      />
    </PageContainer>
  );
}
