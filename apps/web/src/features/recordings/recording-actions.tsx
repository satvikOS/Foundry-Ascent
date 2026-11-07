import type { RecordingView } from '@foundry/contracts';
import type { RecordingDownloadFile } from '@foundry/contracts/recording-files';
import { ChevronDown, Download, FileText, Film } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVeirName } from '@/features/venture/veir-name';
import { errorMessage } from '@/lib/api/errors';
import { fetchRecordingDownload } from '@/lib/api/hooks/recording-files';
import { useDeleteRecording } from '@/lib/api/hooks/recordings';

import { saveDownload } from './save-download';

/** The recording's file type, as a person knows it ("WebM", "MP4"). */
export function fileType(recording: Pick<RecordingView, 'mimeType'>): string {
  return recording.mimeType.endsWith('webm') ? 'WebM' : recording.mimeType === 'audio/mp4' ? 'M4A' : 'MP4';
}

/**
 * Saves a file of a recording: a presigned GET signed when it is asked for (the server records each one as a
 * download), loaded in a hidden frame. The file is sent as an attachment under its name, and the page is never
 * navigated, so a call, or a take still recording or saving, goes on undisturbed (saveDownload).
 */
function useDownload(recording: RecordingView) {
  const name = useVeirName(recording.ventureId);
  const [busy, setBusy] = useState(false);
  const download = (file: RecordingDownloadFile) => {
    if (busy) return;
    setBusy(true);
    fetchRecordingDownload(recording.id, { file, name })
      .then((saved) => {
        saveDownload(saved.url);
        announce('Download started');
      })
      .catch((error: unknown) => {
        toast.error('The download couldn’t start', { description: errorMessage(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, download };
}

/**
 * Download: the recording (and its transcript, when it has one: a menu of both), saved under a readable name.
 * `compact`: an icon (a list row on a phone keeps its room for the title).
 */
export function DownloadRecording({
  recording,
  accessibleName,
  compact = false,
}: {
  recording: RecordingView;
  /** Says which recording (a row among others). */
  accessibleName: string;
  compact?: boolean;
}) {
  const { busy, download } = useDownload(recording);
  const content = (
    <>
      <Download aria-hidden />
      <span className={compact ? 'hidden sm:inline' : undefined}>Download</span>
    </>
  );
  if (!recording.hasCaptions) {
    return (
      <Button
        variant={compact ? 'ghost' : 'secondary'}
        size="sm"
        aria-label={accessibleName}
        aria-busy={busy || undefined}
        onClick={() => {
          download('recording');
        }}
      >
        {content}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <SimpleTooltip content="Download" disabled={!compact}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={compact ? 'ghost' : 'secondary'}
            size="sm"
            aria-label={accessibleName}
            aria-busy={busy || undefined}
          >
            {content}
            {compact ? null : <ChevronDown aria-hidden className="text-muted-foreground" />}
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem
          className="min-h-9 pointer-coarse:min-h-11"
          onSelect={() => {
            download('recording');
          }}
        >
          <Film aria-hidden />
          Recording
          <span className="ml-auto text-caption text-muted-foreground">{fileType(recording)}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-9 pointer-coarse:min-h-11"
          onSelect={() => {
            download('transcript');
          }}
        >
          <FileText aria-hidden />
          Transcript
          <span className="ml-auto text-caption text-muted-foreground">VTT</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Confirms deleting a recording (and its captions), then deletes it. */
export function DeleteRecordingDialog({
  recording,
  onClose,
  onDeleted,
}: {
  /** The recording to delete (the dialog is open while there is one). */
  recording: RecordingView | null;
  onClose: () => void;
  onDeleted?: (recording: RecordingView) => void;
}) {
  const remove = useDeleteRecording();
  return (
    <AlertDialog
      open={recording !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
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
              if (recording === null) return;
              remove.mutate(recording.id, {
                onSuccess: () => {
                  onClose();
                  onDeleted?.(recording);
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
  );
}
