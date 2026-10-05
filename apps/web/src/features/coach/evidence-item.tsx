import { MemoryStatus, type EvidenceItem } from '@foundry/contracts';
import { BookOpen, Brain, FileText, Library, Sparkles, type LucideIcon } from 'lucide-react';
import type { Ref } from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FreshnessBadge } from '@/features/venture/freshness';

export const EVIDENCE_KIND: Record<EvidenceItem['kind'], { label: string; icon: LucideIcon }> = {
  memory: { label: 'Venture memory', icon: Brain },
  chunk: { label: 'Venture document', icon: FileText },
  doctrine: { label: 'Program guidance', icon: BookOpen },
  resource: { label: 'Program resource', icon: Library },
  pattern: { label: 'Reviewed pattern', icon: Sparkles },
};

interface EvidenceItemCardProps {
  item: EvidenceItem;
  highlighted?: boolean;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** One retrieved source: key, kind, title, excerpt, relevance, freshness and (for memory) status. */
export function EvidenceItemCard({ item, highlighted = false, className, ref }: EvidenceItemCardProps) {
  const kind = EVIDENCE_KIND[item.kind];
  const Icon = kind.icon;
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
        <span
          className="tabular ml-auto text-xs text-subtle-foreground"
          title="Relevance score from retrieval"
        >
          {formatPercent(Math.max(0, Math.min(1, item.score)))}
          <span className="sr-only"> relevance</span>
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
      </div>
    </article>
  );
}
