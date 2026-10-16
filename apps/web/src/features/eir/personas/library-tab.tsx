import type { KnowledgeSourceKind, PersonaView } from '@foundry/contracts';
import { Ellipsis, Library, LoaderCircle, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Progress } from '@/components/ui/progress';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { fileRejection } from '@/features/documents/upload-validation';
import { errorMessage } from '@/lib/api/errors';
import { DOCUMENT_ACCEPT } from '@/lib/api/hooks/documents';
import {
  type LibrarySource,
  usePersonaLibrary,
  useRemoveLibrarySource,
  useRetryLibraryUpload,
  useUploadLibraryDocument,
} from '@/lib/api/hooks/veir-pools';
import { documentFailureMessage } from '@/lib/labels';
import { formatNumber, formatRelative, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';

import { AUTHORED_KINDS, isAuthoredKind, SOURCE_KIND_ORDER, SOURCE_KINDS } from './library-labels';
import { LibrarySourceSheet, type LibrarySheetState } from './library-source-sheet';

type KindFilter = 'all' | KnowledgeSourceKind;

function SourceStatus({ source }: { source: LibrarySource }) {
  if (source.status === 'processing') {
    return (
      <Badge variant="muted">
        <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
        Processing
      </Badge>
    );
  }
  if (source.status === 'failed') return <Badge variant="destructive">Failed</Badge>;
  if (source.status === 'stale') return <Badge variant="warning">Stale</Badge>;
  return null;
}

/**
 * Knowledge library: the notes, cases, FAQs, transcripts and documents this vEIR draws on in every venture
 * it coaches (its common pool). Curators write and upload; everyone in the studio can read.
 */
export function LibraryTab({ persona, shortName }: { persona: PersonaView; shortName: string }) {
  const library = usePersonaLibrary(persona.id);
  const upload = useUploadLibraryDocument(persona.id);
  const retry = useRetryLibraryUpload(persona.id);
  const remove = useRemoveLibrarySource(persona.id);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [sheet, setSheet] = useState<LibrarySheetState>({ mode: 'closed' });
  const [removing, setRemoving] = useState<LibrarySource | null>(null);
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canCurate = persona.canCurate === true && persona.status !== 'retired';

  const startUpload = (file: File) => {
    const problem = fileRejection(file);
    if (problem) {
      toast.error(problem.message);
      return;
    }
    setProgress({ name: file.name, percent: 0 });
    upload.mutate(
      {
        file,
        onProgress: ({ percent }) => {
          setProgress({ name: file.name, percent });
        },
      },
      {
        onSuccess: () => {
          announce(`${file.name} uploaded. Processing.`);
        },
        onSettled: () => {
          setProgress(null);
        },
      },
    );
  };

  if (library.isPending) {
    return (
      <LoadingRegion label="Loading the library">
        <Skeleton className="h-64 rounded-xl" />
      </LoadingRegion>
    );
  }
  if (library.isError) {
    return (
      <ErrorState
        error={library.error}
        onRetry={() => void library.refetch()}
        retrying={library.isRefetching}
      />
    );
  }

  const sources = library.data;
  const kinds = SOURCE_KIND_ORDER.filter((kind) => sources.some((s) => s.kind === kind));
  const shown = filter === 'all' ? sources : sources.filter((s) => s.kind === filter);

  const addMenu = canCurate ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus aria-hidden />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {AUTHORED_KINDS.map((kind) => {
          const Icon = SOURCE_KINDS[kind].icon;
          return (
            <DropdownMenuItem
              key={kind}
              onSelect={() => {
                setSheet({ mode: 'create', kind });
              }}
            >
              <Icon aria-hidden />
              {SOURCE_KINDS[kind].label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            fileInput.current?.click();
          }}
        >
          <Upload aria-hidden />
          Upload document…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div className="grid gap-5">
      <input
        ref={fileInput}
        type="file"
        accept={DOCUMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload a document to the library"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) startUpload(file);
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {kinds.length > 1 ? (
          <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-1.5">
            {(['all', ...kinds] as const).map((kind) => {
              const count = kind === 'all' ? sources.length : sources.filter((s) => s.kind === kind).length;
              const selected = filter === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setFilter(kind);
                  }}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-small transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    selected
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                  )}
                >
                  {kind === 'all' ? 'All' : SOURCE_KINDS[kind].plural}
                  <span className="tabular text-caption opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-small text-muted-foreground">{pluralize(sources.length, 'source')}</p>
        )}
        {addMenu}
      </div>

      {progress ? (
        <div className="grid gap-1.5 rounded-lg border border-border px-4 py-3" role="status">
          <p className="text-small">
            Uploading {progress.name} · <span className="tabular">{progress.percent}%</span>
          </p>
          <Progress value={progress.percent} label={`Uploading ${progress.name}`} />
        </div>
      ) : null}
      <MutationErrorAlert error={upload.error} title="The upload didn’t finish" />

      {sources.length === 0 ? (
        <EmptyState
          icon={Library}
          title="The library is empty"
          description={`Notes, cases, FAQs and documents added here shape how ${shortName} coaches every venture.`}
          action={addMenu}
          headingLevel={2}
        />
      ) : (
        <ul
          aria-label="Library sources"
          className="divide-y divide-border rounded-xl border border-border bg-card"
        >
          {shown.map((source) => {
            const def = SOURCE_KINDS[source.kind];
            const Icon = def.icon;
            const failed = source.status === 'failed';
            return (
              <li key={source.id} className="flex items-start gap-3 px-4 py-3.5">
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left text-body font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => {
                        setSheet({
                          mode: canCurate && isAuthoredKind(source.kind) ? 'edit' : 'view',
                          source,
                        });
                      }}
                    >
                      {source.title}
                    </button>
                    <SourceStatus source={source} />
                  </div>
                  {failed ? (
                    <p className="text-small text-destructive">
                      {documentFailureMessage(source.failureReason)}
                    </p>
                  ) : source.summary ? (
                    <p className="line-clamp-1 text-small text-muted-foreground">{source.summary}</p>
                  ) : null}
                  <p className="text-caption text-muted-foreground">
                    {def.label} · updated{' '}
                    <time dateTime={source.updatedAt}>{formatRelative(source.updatedAt)}</time>
                    {source.chunkCount > 0 ? ` · ${formatNumber(source.chunkCount)} passages` : ''}
                  </p>
                </div>
                {canCurate ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${source.title}`}>
                        <Ellipsis aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setSheet({ mode: 'edit', source });
                        }}
                      >
                        <Pencil aria-hidden />
                        {isAuthoredKind(source.kind) ? 'Edit…' : 'Rename…'}
                      </DropdownMenuItem>
                      {failed && source.kind === 'document' ? (
                        <DropdownMenuItem
                          onSelect={() => {
                            retry.mutate(source.id, {
                              onSuccess: () => {
                                announce(`Processing ${source.title} again`);
                              },
                              onError: (error) => {
                                toast.error(errorMessage(error));
                              },
                            });
                          }}
                        >
                          <RotateCcw aria-hidden />
                          Retry processing
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        onSelect={() => {
                          setRemoving(source);
                        }}
                      >
                        <Trash2 aria-hidden />
                        Remove…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <LibrarySourceSheet
        personaId={persona.id}
        shortName={shortName}
        state={sheet}
        onClose={() => {
          setSheet({ mode: 'closed' });
        }}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoving(null);
            remove.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>{shortName} stops drawing on it at once.</AlertDialogDescription>
          </AlertDialogHeader>
          <MutationErrorAlert error={remove.error} title="Not removed" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={remove.isPending}
              loadingText="Removing…"
              onClick={() => {
                if (!removing) return;
                const name = removing.title;
                remove.mutate(removing.id, {
                  onSuccess: () => {
                    toast.success(`Removed “${name}”`);
                    announce(`Removed ${name}`);
                    setRemoving(null);
                  },
                });
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
