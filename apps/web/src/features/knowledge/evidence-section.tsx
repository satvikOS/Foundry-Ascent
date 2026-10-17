import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BookOpen, Brain, FileText, Library, Lightbulb, ScrollText, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { getStatusDefinition } from '@/components/ui/status-badge';
import { useDocuments } from '@/lib/api/hooks/documents';
import { useMemory } from '@/lib/api/hooks/memory';
import { sessionQueryOptions, sessionsQueryOptions } from '@/lib/api/hooks/sessions';
import { lastActivity } from '@/lib/conversations';
import { documentFailureMessage } from '@/lib/labels';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FreshnessBadge, freshnessLevel } from '@/features/venture/freshness';

import { buildEvidenceSources, type EvidenceSource, type ProgramSourceKind } from './evidence';

/** How many recent conversations are scanned for citations. */
export const RECENT_CONVERSATIONS = 5;

type SourceFilter = 'all' | EvidenceSource['kind'];

const FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'document', label: 'Documents' },
  { value: 'memory', label: 'Memory' },
  { value: 'program', label: 'Program' },
];

function programLabel(kind: ProgramSourceKind, veirName: string): { label: string; icon: LucideIcon } {
  switch (kind) {
    case 'guidance':
      return { label: 'Program guidance', icon: BookOpen };
    case 'library':
      return { label: `${veirName}’s library`, icon: ScrollText };
    case 'resource':
      return { label: 'Program resource', icon: Library };
    case 'lesson':
      return { label: 'Lesson', icon: Lightbulb };
  }
}

interface EvidenceSectionProps {
  ventureId: string;
  tenant: string;
  veirName: string;
  /** Conversations are read only by the team; others see sources without citation counts. */
  canReadConversations: boolean;
  /** Knowledge source a citation linked to (`?source=`): its row is shown highlighted. */
  highlight?: string | undefined;
}

/**
 * Everything the vEIR can cite for the venture (documents, kept memory) and the program sources it
 * cited lately, with freshness and how many recent answers cited each one. Documents and program material
 * open in the document viewer.
 */
export function EvidenceSection({
  ventureId,
  tenant,
  veirName,
  canReadConversations,
  highlight,
}: EvidenceSectionProps) {
  const documents = useDocuments(ventureId);
  const memory = useMemory(ventureId, { status: 'confirmed' });
  // Conversations are team-only (the list answers 403 to everyone else), so only the team asks.
  const sessions = useQuery({
    ...sessionsQueryOptions(ventureId),
    enabled: canReadConversations,
    select: (data) => data.items,
  });
  const [filter, setFilter] = useState<SourceFilter>('all');

  const recent = useMemo(
    () =>
      [...(sessions.data ?? [])]
        .filter((session) => session.turnCount > 0)
        .sort((a, b) => lastActivity(b) - lastActivity(a))
        .slice(0, RECENT_CONVERSATIONS),
    [sessions.data],
  );
  const details = useQueries({ queries: recent.map((session) => sessionQueryOptions(session.id)) });
  const turns = details.flatMap((detail) => detail.data?.turns ?? []);
  const countsPending = canReadConversations && (sessions.isPending || details.some((d) => d.isPending));

  const sources = buildEvidenceSources({
    documents: documents.data ?? [],
    memory: memory.data ?? [],
    turns,
  });
  const shown = sources.filter((source) => filter === 'all' || source.kind === filter);
  const cited = sources.filter((source) => source.citations > 0).length;
  const stale = sources.filter((source) => freshnessLevel(source.freshnessAt) === 'stale').length;

  if (documents.isPending || memory.isPending) return <HairlineSkeleton rows={4} label="Loading sources…" />;
  const error = documents.error ?? memory.error;
  if (error) {
    return (
      <ErrorState
        error={error}
        headingLevel={2}
        onRetry={() => {
          void documents.refetch();
          void memory.refetch();
        }}
      />
    );
  }
  if (sources.length === 0) {
    return (
      <EmptyState
        icon={Library}
        headingLevel={2}
        title="Nothing to cite yet"
        action={
          <Link
            to="/$tenant/app/v/$ventureId/documents"
            params={{ tenant, ventureId }}
            className="text-small font-medium underline underline-offset-4"
          >
            Upload documents
          </Link>
        }
      />
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Source" className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => {
                setFilter(option.value);
              }}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center rounded-full border px-3 text-[13px] transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                filter === option.value
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-small text-muted-foreground" role="status" aria-live="polite">
          {pluralize(shown.length, 'source')}
          {canReadConversations && !countsPending ? ` · ${cited} cited lately` : ''}
          {stale > 0 ? ` · ${stale} stale` : ''}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="border-y border-border py-6 text-center text-small text-muted-foreground">
          No sources of this kind.
        </p>
      ) : (
        <ul aria-label="Sources" className="divide-y divide-border border-y border-border">
          {shown.map((source) => (
            <SourceRow
              key={source.key}
              source={source}
              tenant={tenant}
              ventureId={ventureId}
              veirName={veirName}
              showCitations={canReadConversations && !countsPending}
              highlighted={highlight !== undefined && source.sourceId === highlight}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceRow({
  source,
  tenant,
  ventureId,
  veirName,
  showCitations,
  highlighted,
}: {
  source: EvidenceSource;
  tenant: string;
  ventureId: string;
  veirName: string;
  showCitations: boolean;
  highlighted: boolean;
}) {
  const row = useRef<HTMLLIElement | null>(null);
  // A citation opened this source: bring its row into view once.
  useEffect(() => {
    if (!highlighted) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [highlighted]);
  const program = source.programKind ? programLabel(source.programKind, veirName) : null;
  const Icon =
    source.kind === 'document' ? FileText : source.kind === 'memory' ? Brain : (program?.icon ?? BookOpen);
  const kindLabel =
    source.kind === 'document'
      ? 'Document'
      : source.kind === 'memory'
        ? 'Memory'
        : (program?.label ?? 'Program');
  const linkClass =
    'truncate font-medium underline decoration-transparent underline-offset-[3px] hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring';

  let title: ReactNode = <span className="truncate font-medium">{source.title}</span>;
  if (source.memory) {
    title = (
      <Link
        to="/$tenant/app/v/$ventureId/knowledge"
        params={{ tenant, ventureId }}
        search={{ m: source.memory.id }}
        className={linkClass}
      >
        {source.title}
      </Link>
    );
  } else if (source.document || (source.programKind === 'guidance' && source.sourceId)) {
    // Documents and program or public material open in the document viewer (a vEIR's own library is read
    // in the studio, so its rows stay plain).
    const documentId = source.document?.id;
    const sourceId = documentId === undefined ? (source.sourceId ?? undefined) : undefined;
    title = (
      <Link
        to="."
        search={(previous) => ({ ...previous, doc: documentId, src: sourceId, passage: undefined })}
        state={(previous) => ({ ...previous, documentViewer: true })}
        resetScroll={false}
        data-opens-document
        className={linkClass}
      >
        {source.title}
      </Link>
    );
  }

  const document = source.document;
  const excerpt = document
    ? document.status === 'ready'
      ? pluralize(document.chunkCount, 'searchable passage')
      : document.status === 'failed'
        ? documentFailureMessage(document.failureReason)
        : getStatusDefinition('document', document.status).label
    : source.excerpt;

  return (
    <li
      ref={row}
      data-highlighted={highlighted || undefined}
      aria-current={highlighted ? 'true' : undefined}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2 py-3.5 transition-colors',
        highlighted && 'rounded-md bg-accent/60',
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      <div className="flex min-w-0 items-center gap-2 text-[15px]">{title}</div>
      {excerpt ? (
        <p className="col-start-2 line-clamp-2 text-small text-muted-foreground [overflow-wrap:anywhere]">
          {excerpt}
        </p>
      ) : null}
      <div className="col-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-subtle-foreground">
        <span>{kindLabel}</span>
        <FreshnessBadge date={source.freshnessAt} />
        {showCitations && source.citations > 0 ? (
          <span>Cited in {pluralize(source.citations, 'answer')}</span>
        ) : null}
      </div>
    </li>
  );
}
