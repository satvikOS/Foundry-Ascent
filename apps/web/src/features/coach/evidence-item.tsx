import { MemoryStatus, type EvidenceItem } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  BookOpen,
  Brain,
  FileText,
  Library,
  ScrollText,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { Ref } from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import { FreshnessBadge } from '@/features/venture/freshness';

interface KindLabel {
  label: string;
  icon: LucideIcon;
}

/**
 * What a cited item is, for the person reading it. A passage says where it comes from by its source's scope:
 * one of the venture's documents, the program's guidance, or the vEIR's own library.
 */
export function evidenceKindLabel(item: Pick<EvidenceItem, 'kind' | 'source'>, veirName?: string): KindLabel {
  switch (item.kind) {
    case 'memory':
      return { label: 'Venture memory', icon: Brain };
    case 'resource':
      return { label: 'Program resource', icon: Library };
    case 'pattern':
      return { label: 'Reviewed pattern', icon: Sparkles };
    case 'chunk':
    case 'doctrine': {
      const scope = item.source?.scope ?? (item.kind === 'doctrine' ? 'persona' : null);
      if (scope === 'venture') return { label: 'Venture document', icon: FileText };
      if (scope === 'persona') {
        return { label: veirName ? `${veirName}’s library` : 'vEIR library', icon: ScrollText };
      }
      if (scope === 'program' || scope === 'public') return { label: 'Program guidance', icon: BookOpen };
      return { label: 'Passage', icon: FileText };
    }
  }
}

interface EvidenceItemCardProps {
  item: EvidenceItem;
  highlighted?: boolean;
  className?: string;
  ref?: Ref<HTMLElement>;
  /** The vEIR's name, for its library ("Corin's vEIR’s library"). */
  veirName?: string;
  /**
   * Where the venture's pages are: a cited passage opens its document or source in the viewer, or links to
   * its row in Evidence.
   */
  venture?: { tenant: string; ventureId: string };
}

const SOURCE_LINK =
  'inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring';

/**
 * Opens the source a passage was cited from: one of the venture's documents, or program and public
 * material, opens in the document viewer at the cited passage; a vEIR's own library (read in the studio)
 * links to its row in Knowledge › Evidence.
 */
function SourceLink({
  source,
  passageId,
  venture,
}: {
  source: NonNullable<EvidenceItem['source']>;
  /** The cited passage (its knowledge chunk). */
  passageId: string;
  venture: { tenant: string; ventureId: string };
}) {
  if (source.scope !== 'persona') {
    // The document viewer opens over the conversation (`?src=…&passage=…`); Back returns to it.
    return (
      <Link
        to="."
        search={(previous) => ({ ...previous, doc: undefined, src: source.id, passage: passageId })}
        state={(previous) => ({ ...previous, documentViewer: true })}
        resetScroll={false}
        data-opens-document
        className={SOURCE_LINK}
      >
        {source.scope === 'venture' ? 'Open document' : 'Read source'}
        <ArrowUpRight aria-hidden className="size-3" />
      </Link>
    );
  }
  return (
    <Link
      to="/$tenant/app/v/$ventureId/knowledge"
      params={venture}
      search={{ view: 'evidence', source: source.id }}
      className={SOURCE_LINK}
    >
      See in Evidence
      <ArrowUpRight aria-hidden className="size-3" />
    </Link>
  );
}

/** One retrieved source: key, kind, title, excerpt, relevance, freshness and (for memory) status. */
export function EvidenceItemCard({
  item,
  highlighted = false,
  className,
  ref,
  veirName,
  venture,
}: EvidenceItemCardProps) {
  const kind = evidenceKindLabel(item, veirName);
  const Icon = kind.icon;
  const source = item.source ?? null;
  const parsedStatus = MemoryStatus.safeParse(item.status);
  const memoryStatus = item.kind === 'memory' && parsedStatus.success ? parsedStatus.data : null;
  return (
    <article
      ref={ref}
      tabIndex={-1}
      id={`evidence-${item.key}`}
      aria-labelledby={`evidence-${item.key}-title`}
      data-highlighted={highlighted || undefined}
      className={cn(
        'scroll-mt-4 rounded-lg border bg-card p-3 outline-none transition-[border-color,box-shadow]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        highlighted ? 'border-foreground/60 ring-1 ring-foreground/30' : 'border-border',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-[18px] items-center rounded-[5px] border border-border-strong bg-muted px-1 font-mono text-[11px] font-medium">
          {item.key}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Icon aria-hidden className="size-3.5" />
          {kind.label}
        </span>
      </div>
      <h4
        id={`evidence-${item.key}-title`}
        className="mt-1.5 text-[13px] leading-5 font-semibold [overflow-wrap:anywhere]"
      >
        {item.title}
      </h4>
      <p className="mt-1 text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {item.excerpt}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <FreshnessBadge date={item.freshnessAt} />
        {memoryStatus ? <StatusBadge kind="memory" status={memoryStatus} /> : null}
        {source && venture ? (
          <span className="ml-auto">
            <SourceLink source={source} passageId={item.refId} venture={venture} />
          </span>
        ) : null}
      </div>
    </article>
  );
}
