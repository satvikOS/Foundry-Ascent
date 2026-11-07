import type { RecordingView } from '@foundry/contracts';
import { AudioLines, Play, Trash2, Video, X } from 'lucide-react';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useDeleteRecording } from '@/lib/api/hooks/recordings';
import { formatDateTime, isoString } from '@/lib/format';
import { cn } from '@/lib/utils';

import { recordingClock, spokenLength } from './record-control';
import { RecordingPlayer } from './recording-player';

interface RecordingsListProps {
  items: readonly RecordingView[];
  /** The recording playing (its player opens under its row). */
  playing: string | null;
  onPlay: (id: string | null) => void;
  /** Name each row by its conversation (the Recordings page); a conversation's own list does not. */
  showConversation?: boolean;
  label: string;
}

/**
 * A person's recordings: when, how long, sound or video, captions; Play opens the player under the row (only one
 * plays at a time) and Delete removes it after confirming.
 */
export function RecordingsList({
  items,
  playing,
  onPlay,
  showConversation = false,
  label,
}: RecordingsListProps) {
  const [deleting, setDeleting] = useState<RecordingView | null>(null);
  const remove = useDeleteRecording();
  return (
    <>
      <ul aria-label={label} className="grid divide-y divide-border">
        {items.map((recording) => {
          const open = playing === recording.id;
          const when = formatDateTime(recording.createdAt);
          const KindIcon = recording.kind === 'video' ? Video : AudioLines;
          const title = showConversation
            ? (recording.conversationTitle ?? 'Untitled conversation')
            : `Call · ${when}`;
          return (
            <li key={recording.id} data-recording-id={recording.id} className="grid gap-3 py-3">
              <div className="flex items-center gap-3">
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
                        <time dateTime={isoString(recording.createdAt)}>{when}</time>
                        <span aria-hidden>·</span>
                      </>
                    ) : null}
                    <span className="tabular" aria-hidden>
                      {recordingClock(recording.durationMs / 1000)}
                    </span>
                    <span className="sr-only">{spokenLength(recording.durationMs / 1000)}</span>
                    {recording.hasCaptions ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>Captions</span>
                      </>
                    ) : null}
                  </span>
                </div>
                <Button
                  variant={open ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-expanded={open}
                  aria-label={open ? `Close the recording from ${when}` : `Play the recording from ${when}`}
                  onClick={() => {
                    onPlay(open ? null : recording.id);
                  }}
                >
                  {open ? <X aria-hidden /> : <Play aria-hidden />}
                  <span className="hidden sm:inline">{open ? 'Close' : 'Play'}</span>
                </Button>
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
              </div>
              {open ? <RecordingPlayer recording={recording} autoPlay className={cn('pb-2')} /> : null}
            </li>
          );
        })}
      </ul>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
            <AlertDialogDescription>
              The recording and its captions are deleted for good. The conversation stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={remove.isPending}
              loadingText="Deleting…"
              onClick={() => {
                const target = deleting;
                if (!target) return;
                remove.mutate(target.id, {
                  onSuccess: () => {
                    if (playing === target.id) onPlay(null);
                    setDeleting(null);
                    toast.success('Recording deleted');
                    announce('Recording deleted');
                  },
                  onError: (error) => {
                    toast.error('Couldn’t delete the recording', { description: errorMessage(error) });
                  },
                });
              }}
            >
              Delete recording
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
