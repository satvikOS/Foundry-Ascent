import { MAX_DOCUMENT_BYTES, type DocumentView } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
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
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';

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
import { HairlineSkeleton } from '@/components/ui/page-section';
import { Progress } from '@/components/ui/progress';
import { getStatusDefinition } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import {
  DOCUMENT_ACCEPT,
  isInFlight,
  isStaleUpload,
  useCompleteDocument,
  useDeleteDocument,
  useDocuments,
} from '@/lib/api/hooks/documents';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatBytes, formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { documentFailureMessage } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { sentenceStart, useVeirName } from '@/features/venture/veir-name';

import { isUnfinishedUpload, resumableUpload } from './unfinished-uploads';
import { DOCUMENTS_ORIGIN, isActiveUpload, type QueuedUpload, type UploadItem } from './upload-queue';
import { SUPPORTED_FORMATS_LABEL, validateUploadFiles, type UploadRejection } from './upload-validation';
import { useVentureUploads } from './venture-uploads';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/documents');

const TYPE_ICON: Record<DocumentView['contentType'], { icon: LucideIcon; label: string }> = {
  'application/pdf': { icon: FileType2, label: 'PDF' },
  'text/plain': { icon: FileText, label: 'Text' },
  'text/markdown': { icon: FileText, label: 'Markdown' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { icon: File, label: 'Word' },
};

const FORMATS_HINT = `${SUPPORTED_FORMATS_LABEL}, up to ${formatBytes(MAX_DOCUMENT_BYTES)} each.`;

function uploadLabel(item: UploadItem): string {
  switch (item.status) {
    case 'queued':
      return 'Waiting';
    case 'uploading':
      return `Uploading · ${item.progress}%`;
    case 'finishing':
      return 'Finishing…';
    case 'done':
      return 'Uploaded, processing';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
  }
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
  return (
    <li className="grid gap-2 py-3">
      <div className="flex items-center gap-3">
        {item.status === 'done' ? (
          <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
        ) : item.status === 'failed' ? (
          <CircleX aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : (
          <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.file.name}</span>
        <span className="shrink-0 text-caption text-muted-foreground">{uploadLabel(item)}</span>
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
      {item.error ? <p className="text-small text-destructive">{item.error}</p> : null}
    </li>
  );
}

/**
 * A file picked to finish an unfinished upload: the server signed that upload for the document's own file
 * (its size and type), so only that file can go into it. Anything else is explained instead.
 */
export function reuploadChoice(
  files: readonly File[],
  doc: DocumentView,
  now = Date.now(),
): { accepted: QueuedUpload } | { rejected: UploadRejection } | null {
  const { accepted, rejected } = validateUploadFiles(files.slice(0, 1));
  const problem = rejected[0];
  if (problem) return { rejected: problem };
  const candidate = accepted[0];
  if (!candidate) return null;
  const resume = resumableUpload(candidate, [doc], now);
  if (resume) return { accepted: { ...candidate, resume } };
  return {
    rejected: {
      name: candidate.file.name,
      code: 'different_file',
      message: `This isn’t ${doc.filename} (${formatBytes(doc.sizeBytes)}). Choose that file to finish its upload, or use Upload files to add this one.`,
    },
  };
}

/**
 * Documents: the venture's files the vEIR can cite. One action (upload, by button or by dropping files
 * on the page), the venture's uploads while they run (from here or from a conversation's composer), and
 * the files as hairline rows that update while they are processed; a file's name opens it in the document
 * viewer. Retry on a document whose file never arrived asks for that file again and uploads it into the
 * same document.
 */
export function DocumentsPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  // A citation links here with its knowledge source: that document is shown highlighted.
  const { source: linkedSource } = routeApi.useSearch();
  const canEdit = canWrite(me, ventureId);
  const veirName = useVeirName(ventureId);
  const documents = useDocuments(ventureId);
  const queue = useVentureUploads(ventureId);
  const remove = useDeleteDocument(ventureId);
  const complete = useCompleteDocument(ventureId);
  const [rejections, setRejections] = useState<UploadRejection[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<DocumentView | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Retry on an unfinished upload: the file picker for that document's file, and the document it is for.
  const reuploadRef = useRef<HTMLInputElement | null>(null);
  const reuploadFor = useRef<DocumentView | null>(null);
  const hintId = useId();

  const rows = useMemo(
    () =>
      (documents.data ?? [])
        .filter((d) => d.status !== 'deleted')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [documents.data],
  );
  // Uploads left unfinished are neither waited for nor counted (the list stops polling for them).
  const processing = rows.filter((d) => isInFlight(d)).length;
  // Documents an upload in the queue is going into right now (a retry of one left unfinished long ago).
  const uploadingInto = useMemo(
    () =>
      new Set(
        queue.items.flatMap((item) => (isActiveUpload(item) && item.resume ? [item.resume.documentId] : [])),
      ),
    [queue.items],
  );
  const linked = linkedSource === undefined ? null : (rows.find((d) => d.sourceId === linkedSource) ?? null);

  const onFiles = (files: File[]) => {
    if (files.length === 0) return;
    // A file whose earlier upload never finished goes into that document again, not a second one.
    const existing = [
      ...rows.filter((d) => d.status !== 'failed' && !isUnfinishedUpload(d)).map((d) => d.filename),
      ...queue.activeNames,
    ];
    const result = validateUploadFiles(files, { existingNames: existing });
    setRejections(result.rejected);
    queue.add(
      result.accepted.map((candidate) => ({ ...candidate, resume: resumableUpload(candidate, rows) })),
      DOCUMENTS_ORIGIN,
    );
    if (result.rejected.length > 0) {
      announce(
        `${pluralize(result.rejected.length, 'file')} can’t be uploaded. See the list for reasons.`,
        'assertive',
      );
    }
  };

  const dropHandlers = canEdit
    ? {
        onDragEnter: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          depth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          onFiles(Array.from(event.dataTransfer.files));
        },
      }
    : {};

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

  /** The file never arrived, so completing cannot help: ask for the file and upload it into the document. */
  const askForFile = (doc: DocumentView) => {
    reuploadFor.current = doc;
    reuploadRef.current?.click();
  };

  const onReuploadFile = (files: File[]) => {
    const doc = reuploadFor.current;
    reuploadFor.current = null;
    const choice = doc ? reuploadChoice(files, doc) : null;
    if (!choice) return;
    if ('rejected' in choice) {
      setRejections([choice.rejected]);
      announce('That file can’t finish this upload. See the list for the reason.', 'assertive');
      return;
    }
    setRejections([]);
    queue.add([choice.accepted], DOCUMENTS_ORIGIN);
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
    <PageContainer className="relative max-w-4xl" {...dropHandlers}>
      <PageHeader
        title="Documents"
        description={`Files ${veirName} can cite. Private to this venture.`}
        actions={
          canEdit ? (
            <Button aria-describedby={hintId} onClick={() => inputRef.current?.click()}>
              <Upload aria-hidden />
              Upload files
            </Button>
          ) : null
        }
      />
      {canEdit ? (
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
      ) : null}
      {canEdit ? (
        <input
          ref={reuploadRef}
          type="file"
          accept={DOCUMENT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            onReuploadFile(files);
          }}
        />
      ) : null}

      {dragging ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/50 bg-background/85"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <Upload className="size-4" />
            Drop to upload
          </p>
        </div>
      ) : null}

      {rejections.length > 0 || queue.items.length > 0 ? (
        <section aria-label="Uploads" className="mb-6 grid gap-3">
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
                    <span className="font-medium text-foreground">{r.name || 'Unnamed file'}</span>:{' '}
                    {r.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {queue.items.length > 0 ? (
            <ul aria-label="Upload queue" className="divide-y divide-border border-y border-border">
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

      {processing > 0 ? (
        <p className="mb-3 text-small text-muted-foreground" role="status" aria-live="polite">
          Processing {pluralize(processing, 'file')}…
        </p>
      ) : null}

      {linkedSource !== undefined && documents.isSuccess && linked === null ? (
        <p className="mb-3 text-small text-muted-foreground" role="status">
          The document that passage came from is no longer here.
        </p>
      ) : null}

      {documents.isError ? (
        <ErrorState error={documents.error} onRetry={() => void documents.refetch()} headingLevel={2} />
      ) : documents.isPending ? (
        <HairlineSkeleton rows={3} label="Loading documents…" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          headingLevel={2}
          title="No documents yet"
          description={
            canEdit
              ? `Upload notes, decks or research for ${veirName} to cite.`
              : `${sentenceStart(veirName)} cites the documents the team uploads here.`
          }
        />
      ) : (
        <ul aria-label="Venture documents" className="divide-y divide-border border-y border-border">
          {rows.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              highlighted={linked?.id === doc.id}
              canEdit={canEdit}
              uploading={uploadingInto.has(doc.id)}
              retrying={complete.isPending && complete.variables === doc.id}
              deleting={remove.isPending && remove.variables === doc.id}
              onRetry={() => {
                if (isUnfinishedUpload(doc)) askForFile(doc);
                else retryProcessing(doc);
              }}
              onDelete={() => {
                setConfirmDelete(doc);
              }}
            />
          ))}
        </ul>
      )}

      {canEdit ? (
        <p id={hintId} className="mt-4 text-caption text-subtle-foreground">
          {FORMATS_HINT} You can also drop files on this page.
        </p>
      ) : null}

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
              {sentenceStart(veirName)} can no longer cite it. Memory that referenced it is kept.
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

function DocumentRow({
  doc,
  highlighted,
  canEdit,
  uploading,
  retrying,
  deleting,
  onRetry,
  onDelete,
}: {
  doc: DocumentView;
  /** A citation linked to this document. */
  highlighted: boolean;
  canEdit: boolean;
  /** The upload queue is uploading into this document now. */
  uploading: boolean;
  retrying: boolean;
  deleting: boolean;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const row = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!highlighted) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [highlighted]);
  const type = TYPE_ICON[doc.contentType];
  const Icon = type.icon;
  // An upload left unfinished long ago is not "Uploading": it won't move on by itself (unless it is being
  // retried right now).
  const stale = isStaleUpload(doc) && !uploading;
  const status = getStatusDefinition('document', doc.status);
  const label = stale ? 'Upload didn’t finish' : status.label;
  const failed = doc.status === 'failed' || stale;
  const nameId = `document-${doc.id}`;
  return (
    <li
      ref={row}
      aria-labelledby={nameId}
      aria-current={highlighted ? 'true' : undefined}
      data-highlighted={highlighted || undefined}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-2 py-3.5 transition-colors',
        highlighted && 'rounded-md bg-accent/60',
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      <div className="grid min-w-0 gap-0.5">
        <p id={nameId} className="flex min-w-0 text-[15px] font-medium">
          {/* Opens the document viewer over this page (a link: it can also open in a new tab). */}
          <Link
            to="."
            search={(previous) => ({ ...previous, doc: doc.id, src: undefined, passage: undefined })}
            state={(previous) => ({ ...previous, documentViewer: true })}
            resetScroll={false}
            data-opens-document
            title={doc.filename}
            className={cn(
              'min-w-0 truncate rounded-sm underline decoration-transparent underline-offset-[3px]',
              'transition-colors hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            {doc.filename}
          </Link>
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-subtle-foreground">
          <span className={cn(failed && 'font-medium text-destructive')}>{label}</span>
          {doc.status === 'ready' ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular">{pluralize(doc.chunkCount, 'passage')}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>{type.label}</span>
          <span aria-hidden>·</span>
          <span className="tabular">{formatBytes(doc.sizeBytes)}</span>
          <span aria-hidden>·</span>
          <span>
            {doc.uploadedBy.displayName},{' '}
            <time dateTime={isoString(doc.createdAt)} title={formatDateTime(doc.createdAt)}>
              {formatRelative(doc.createdAt)}
            </time>
          </span>
        </p>
        {failed ? (
          <p className="text-small text-destructive">
            {documentFailureMessage(stale ? 'upload_incomplete' : doc.failureReason)}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex items-center gap-1">
          {(doc.status === 'failed' || stale) && !uploading ? (
            <Button size="xs" variant="ghost" loading={retrying} onClick={onRetry}>
              <RotateCcw aria-hidden />
              Retry
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete ${doc.filename}`}
            disabled={deleting}
            onClick={onDelete}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ) : null}
    </li>
  );
}
