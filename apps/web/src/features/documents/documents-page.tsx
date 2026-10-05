import { MAX_DOCUMENT_BYTES, type DocumentView } from '@foundry/contracts';
import { getRouteApi } from '@tanstack/react-router';
import {
  CircleCheck,
  CircleX,
  File,
  FileText,
  FileType2,
  RotateCcw,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useMemo, useRef, useState, type DragEvent } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
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
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import {
  DOCUMENT_ACCEPT,
  useCompleteDocument,
  useDeleteDocument,
  useDocuments,
} from '@/lib/api/hooks/documents';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatBytes, formatDateTime, formatNumber, formatRelative, isoString } from '@/lib/format';
import { cn } from '@/lib/utils';

import { SUPPORTED_FORMATS_LABEL, validateUploadFiles, type UploadRejection } from './upload-validation';
import { useUploadQueue, type UploadItem } from './use-upload-queue';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/documents');

const TYPE_ICON: Record<DocumentView['contentType'], { icon: LucideIcon; label: string }> = {
  'application/pdf': { icon: FileType2, label: 'PDF' },
  'text/plain': { icon: FileText, label: 'Text' },
  'text/markdown': { icon: FileText, label: 'Markdown' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { icon: File, label: 'Word' },
};

const IN_FLIGHT = new Set<DocumentView['status']>(['pending_upload', 'processing']);

function Dropzone({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hintId = useId();

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    onFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      data-testid="dropzone"
      onDragEnter={(event) => {
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
        dragging ? 'border-foreground/60 bg-accent/60' : 'border-border-strong bg-card',
      )}
    >
      <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted">
        <Upload aria-hidden className="size-5" />
      </span>
      <div>
        <p className="text-sm font-medium">
          {dragging ? 'Drop to upload' : 'Drag files here, or choose them'}
        </p>
        <p id={hintId} className="mt-1 text-[13px] text-muted-foreground">
          {SUPPORTED_FORMATS_LABEL} · up to {formatBytes(MAX_DOCUMENT_BYTES)} each · stays private to this
          venture
        </p>
      </div>
      <Button
        variant="secondary"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={() => inputRef.current?.click()}
      >
        Choose files
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          onFiles(files);
        }}
      />
    </div>
  );
}

function UploadRow({
  item,
  onCancel,
  onRetry,
  onDismiss,
}: {
  item: UploadItem;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const label =
    item.status === 'queued'
      ? 'Waiting'
      : item.status === 'uploading'
        ? `Uploading · ${item.progress}%`
        : item.status === 'finishing'
          ? 'Finishing…'
          : item.status === 'done'
            ? 'Uploaded — processing'
            : item.status === 'cancelled'
              ? 'Cancelled'
              : 'Failed';
  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        {item.status === 'done' ? (
          <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
        ) : item.status === 'failed' ? (
          <CircleX aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : (
          <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.file.name}</span>
        <span className="tabular shrink-0 text-xs text-muted-foreground">{formatBytes(item.file.size)}</span>
        <span className="w-36 shrink-0 text-right text-xs text-muted-foreground">{label}</span>
        {item.status === 'queued' || item.status === 'uploading' ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Cancel upload of ${item.file.name}`}
            onClick={onCancel}
          >
            <X aria-hidden />
          </Button>
        ) : item.status === 'failed' || item.status === 'cancelled' ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-xs" aria-label={`Retry ${item.file.name}`} onClick={onRetry}>
              <RotateCcw aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${item.file.name} from the list`}
              onClick={onDismiss}
            >
              <X aria-hidden />
            </Button>
          </span>
        ) : (
          <span className="size-7 shrink-0" />
        )}
      </div>
      {item.status === 'uploading' || item.status === 'finishing' ? (
        <Progress
          value={item.status === 'finishing' ? null : item.progress}
          label={`Upload progress for ${item.file.name}`}
        />
      ) : null}
      {item.error ? <p className="text-[13px] text-destructive">{item.error}</p> : null}
    </li>
  );
}

export function DocumentsPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  const canEdit = canWrite(me, ventureId);
  const documents = useDocuments(ventureId);
  const queue = useUploadQueue(ventureId);
  const remove = useDeleteDocument(ventureId);
  const complete = useCompleteDocument(ventureId);
  const [rejections, setRejections] = useState<UploadRejection[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<DocumentView | null>(null);

  const rows = useMemo(
    () =>
      (documents.data ?? [])
        .filter((d) => d.status !== 'deleted')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [documents.data],
  );
  const processing = rows.filter((d) => IN_FLIGHT.has(d.status)).length;

  const onFiles = (files: File[]) => {
    if (files.length === 0) return;
    const existing = [
      ...rows.filter((d) => d.status !== 'failed').map((d) => d.filename),
      ...queue.activeNames,
    ];
    const result = validateUploadFiles(files, { existingNames: existing });
    setRejections(result.rejected);
    queue.add(result.accepted);
    if (result.rejected.length > 0) {
      announce(
        `${result.rejected.length} file${result.rejected.length === 1 ? '' : 's'} can’t be uploaded. See the list for reasons.`,
        'assertive',
      );
    }
  };

  const deleteDocument = (doc: DocumentView) => {
    setConfirmDelete(null);
    remove.mutate(doc.id, {
      onSuccess: () => {
        toast.success('Document deleted');
        announce('Document deleted');
      },
      onError: (error) => {
        toast.error('Couldn’t delete the document', { description: errorMessage(error) });
      },
    });
  };

  const retryProcessing = (doc: DocumentView) => {
    complete.mutate(doc.id, {
      onSuccess: () => {
        toast.success('Processing restarted');
      },
      onError: (error) => {
        toast.error('Couldn’t restart processing', { description: errorMessage(error) });
      },
    });
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Documents"
        description="Files Foundry Guide can cite as evidence. They’re split into searchable passages; only people on this venture can see them."
      />

      {canEdit ? (
        <section aria-label="Upload documents" className="mb-6 grid gap-3">
          <Dropzone onFiles={onFiles} disabled={false} />
          {rejections.length > 0 ? (
            <Alert
              variant="destructive"
              title={
                rejections.length === 1
                  ? 'One file wasn’t uploaded'
                  : `${rejections.length} files weren’t uploaded`
              }
              action={
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setRejections([]);
                  }}
                >
                  Dismiss
                </Button>
              }
            >
              <ul className="mt-1 grid gap-0.5">
                {rejections.map((r, index) => (
                  <li key={`${r.name}-${index}`}>
                    <span className="font-medium text-foreground">{r.name || 'Unnamed file'}</span> —{' '}
                    {r.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {queue.items.length > 0 ? (
            <ul
              aria-label="Uploads"
              className="divide-y divide-border rounded-xl border border-border bg-card"
            >
              {queue.items.map((item) => (
                <UploadRow
                  key={item.id}
                  item={item}
                  onCancel={() => {
                    queue.cancel(item.id);
                  }}
                  onRetry={() => {
                    queue.retry(item.id);
                  }}
                  onDismiss={() => {
                    queue.dismiss(item.id);
                  }}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Venture documents</h2>
        {processing > 0 ? (
          <p className="text-[13px] text-muted-foreground" role="status" aria-live="polite">
            {processing} processing — this list updates automatically
          </p>
        ) : null}
      </div>

      {documents.isError ? (
        <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
      ) : documents.isPending ? (
        <div aria-busy="true" className="overflow-hidden rounded-xl border border-border bg-card">
          <span className="sr-only" role="status">
            Loading documents…
          </span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description="Upload interview notes, pitch decks or research. Foundry Guide cites them as evidence, and you can see exactly which passage it used."
        />
      ) : (
        <Table aria-label="Venture documents">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Passages</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((doc) => {
              const type = TYPE_ICON[doc.contentType];
              const Icon = type.icon;
              return (
                <TableRow key={doc.id}>
                  <TableCell className="max-w-[24rem]">
                    <div className="flex items-center gap-2">
                      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium" title={doc.filename}>
                        {doc.filename}
                      </span>
                      <span className="shrink-0 text-xs text-subtle-foreground">{type.label}</span>
                    </div>
                    {doc.status === 'failed' ? (
                      <p className="mt-0.5 pl-6 text-xs text-destructive">
                        {doc.failureReason ?? 'Text couldn’t be extracted from this file.'}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="document" status={doc.status} withTitle />
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {doc.status === 'ready' ? (
                      formatNumber(doc.chunkCount)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right whitespace-nowrap">
                    {formatBytes(doc.sizeBytes)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {doc.uploadedBy.displayName} ·{' '}
                    <time dateTime={isoString(doc.createdAt)} title={formatDateTime(doc.createdAt)}>
                      {formatRelative(doc.createdAt)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {canEdit ? (
                      <span className="inline-flex items-center gap-1">
                        {doc.status === 'failed' ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            loading={complete.isPending && complete.variables === doc.id}
                            onClick={() => {
                              retryProcessing(doc);
                            }}
                          >
                            <RotateCcw aria-hidden />
                            Retry
                          </Button>
                        ) : null}
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Delete ${doc.filename}`}
                          disabled={remove.isPending && remove.variables === doc.id}
                          onClick={() => {
                            setConfirmDelete(doc);
                          }}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              Its passages are removed from search immediately, so Foundry Guide can no longer cite it. Memory
              that referenced it keeps its source note.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDelete) deleteDocument(confirmDelete);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
