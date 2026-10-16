import { FileText, Paperclip, RotateCcw, X } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { DOCUMENT_ACCEPT, useDocuments } from '@/lib/api/hooks/documents';
import { cn } from '@/lib/utils';
import { SUPPORTED_FORMATS_LABEL, validateUploadFiles } from '@/features/documents/upload-validation';
import { useUploadQueue, type UploadItem } from '@/features/documents/use-upload-queue';

/**
 * Attach from the composer: files go into the venture's Documents through the same upload queue as the
 * Documents page, so the vEIR can cite them once they are processed. Nothing is attached to the message
 * itself; the tray under the message box shows each upload until it is done.
 */
export function useComposerAttachments(ventureId: string) {
  const queue = useUploadQueue(ventureId);
  const documents = useDocuments(ventureId);
  const { add } = queue;
  const existing = useMemo(
    () => [
      ...(documents.data ?? []).filter((doc) => doc.status !== 'failed').map((doc) => doc.filename),
      ...queue.activeNames,
    ],
    [documents.data, queue.activeNames],
  );
  const attach = useCallback(
    (files: readonly File[]) => {
      const { accepted, rejected } = validateUploadFiles(files, { existingNames: existing });
      for (const rejection of rejected) toast.error(rejection.name, { description: rejection.message });
      add(accepted);
    },
    [add, existing],
  );
  // Queued, uploading or finishing: leaving the page now would cancel it.
  const uploading = queue.items.some(
    (item) => item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing',
  );
  return {
    items: queue.items,
    uploading,
    attach,
    cancel: queue.cancel,
    retry: queue.retry,
    dismiss: queue.dismiss,
  };
}

export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <SimpleTooltip content={`Add documents (${SUPPORTED_FORMATS_LABEL})`}>
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          className="rounded-full"
          aria-label="Add documents"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <Paperclip aria-hidden />
        </Button>
      </SimpleTooltip>
      <input
        ref={input}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

function statusText(item: UploadItem): string {
  switch (item.status) {
    case 'queued':
      return 'Waiting';
    case 'uploading':
      return `${item.progress}%`;
    case 'finishing':
      return 'Finishing';
    case 'done':
      return 'Added to Documents';
    case 'failed':
      return item.error ?? 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Uploads started from the composer, inside the message box above the text. */
export function AttachmentTray({
  items,
  onCancel,
  onRetry,
  onDismiss,
}: {
  items: readonly UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Documents being added" className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((item) => {
        const active = item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing';
        const failed = item.status === 'failed';
        return (
          <li
            key={item.id}
            className={cn(
              'flex max-w-full min-w-0 items-center gap-2 rounded-xl border bg-background py-1.5 pr-1 pl-2.5',
              failed ? 'border-destructive/50' : 'border-border',
            )}
          >
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="grid min-w-0 leading-tight">
              <span className="truncate text-small font-medium">{item.file.name}</span>
              <span
                className={cn('truncate text-caption', failed ? 'text-destructive' : 'text-muted-foreground')}
              >
                {statusText(item)}
              </span>
            </span>
            {failed ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Try ${item.file.name} again`}
                onClick={() => {
                  onRetry(item.id);
                }}
              >
                <RotateCcw aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={active ? `Cancel ${item.file.name}` : `Remove ${item.file.name}`}
              onClick={() => {
                if (active) onCancel(item.id);
                else onDismiss(item.id);
              }}
            >
              <X aria-hidden />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
