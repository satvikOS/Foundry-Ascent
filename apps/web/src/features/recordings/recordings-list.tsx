import type { RecordingView } from '@foundry/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { AudioLines, Play, Trash2, Video } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatClock, spokenDuration } from '@/features/calls/use-call-clock';
import { formatBytes, formatDateTime, isoString } from '@/lib/format';

import { DeleteRecordingDialog, DownloadRecording } from './recording-actions';

interface RecordingsListProps {
  items: readonly RecordingView[];
  /** Name each row by its conversation (the Recordings page); a conversation's own list does not. */
  showConversation?: boolean;
  label: string;
}

/** What a recording holds: a picture with sound, or sound only. */
export const KIND_LABEL: Record<RecordingView['kind'], string> = { video: 'Video', audio: 'Sound only' };

/**
 * A person's recordings, latest first: when, which conversation, how long, video or sound only, its size. Watch opens
 * it in its viewer, Download saves it (or its transcript), Delete removes it after confirming.
 */
export function RecordingsList({ items, showConversation = false, label }: RecordingsListProps) {
  const { tenant = '' } = useParams({ strict: false });
  const [deleting, setDeleting] = useState<RecordingView | null>(null);
  return (
    <>
      <ul aria-label={label} className="grid divide-y divide-border">
        {items.map((recording) => {
          const when = formatDateTime(recording.startedAt);
          const KindIcon = recording.kind === 'video' ? Video : AudioLines;
          const title = showConversation
            ? (recording.conversationTitle ?? 'Untitled conversation')
            : `Call · ${when}`;
          return (
            <li key={recording.id} data-recording-id={recording.id} className="flex items-center gap-3 py-3">
              <span
                aria-hidden
                className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-foreground"
              >
                <KindIcon className="size-4" />
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-sm font-medium">{title}</span>
                <span className="flex flex-wrap gap-x-1.5 text-caption text-muted-foreground">
                  {showConversation ? (
                    <>
                      <time dateTime={isoString(recording.startedAt)}>{when}</time>
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  <span className="tabular" aria-hidden>
                    {formatClock(recording.durationMs / 1000)}
                  </span>
                  <span className="sr-only">{spokenDuration(recording.durationMs / 1000)}</span>
                  <span aria-hidden>·</span>
                  <span>{KIND_LABEL[recording.kind]}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular">{formatBytes(recording.bytes)}</span>
                  {recording.hasCaptions ? (
                    <span className="hidden sm:contents">
                      <span aria-hidden>·</span>
                      <span>Transcript</span>
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button asChild variant="ghost" size="sm">
                  <Link
                    to="/$tenant/app/v/$ventureId/recordings/$recordingId"
                    params={{ tenant, ventureId: recording.ventureId, recordingId: recording.id }}
                    aria-label={`Watch the recording from ${when}`}
                  >
                    <Play aria-hidden />
                    <span className="hidden sm:inline">Watch</span>
                  </Link>
                </Button>
                <DownloadRecording
                  recording={recording}
                  accessibleName={`Download the recording from ${when}`}
                  compact
                />
                <SimpleTooltip content="Delete">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete the recording from ${when}`}
                    onClick={() => {
                      setDeleting(recording);
                    }}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </SimpleTooltip>
              </div>
            </li>
          );
        })}
      </ul>
      <DeleteRecordingDialog
        recording={deleting}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </>
  );
}
