import type { EvidenceItem, PathStepView } from '@foundry/contracts';
import { ArrowUpRight, BookOpen } from 'lucide-react';
import type { ReactNode } from 'react';

import { HoverPopover } from '@/components/ui/hover-popover';
import { evidenceKindLabel } from '@/features/coach/evidence-item';
import { cn } from '@/lib/utils';

export type StepCitation = PathStepView['citations'][number];

/** "The Mom Test, chapter 3": what a citation is called wherever it is listed. */
export function citationLabel(citation: Pick<StepCitation, 'title' | 'locator'>): string {
  return citation.locator ? `${citation.title}, ${citation.locator}` : citation.title;
}

/** Sources are links the founder follows out of the app: https only, whatever the payload says. */
function safeUrl(url: string | null): string | null {
  return url !== null && /^https:\/\//i.test(url) ? url : null;
}

/** The passage of the turn's evidence that is this source, when one was retrieved for the reply. */
export function supportingExcerpt(
  citation: Pick<StepCitation, 'title'>,
  evidence: readonly EvidenceItem[],
): string | null {
  const wanted = citation.title.trim().toLowerCase();
  if (wanted.length < 4) return null;
  return evidence.find((item) => item.title.toLowerCase().includes(wanted))?.excerpt ?? null;
}

const LINK =
  'rounded-sm text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring';

function SourceDetail({ citation, excerpt }: { citation: StepCitation; excerpt: string | null }) {
  const url = safeUrl(citation.url);
  return (
    <div className="grid gap-1.5">
      <p className="text-small font-medium [overflow-wrap:anywhere]">{citation.title}</p>
      {citation.authors || citation.locator ? (
        <p className="text-caption text-muted-foreground">
          {[citation.authors, citation.locator].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {excerpt ? (
        <blockquote className="line-clamp-6 border-l-2 border-border-strong pl-2.5 text-small text-muted-foreground">
          {excerpt}
        </blockquote>
      ) : (
        <p className="text-caption text-muted-foreground">The method, in our own words.</p>
      )}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={cn(
            LINK,
            'inline-flex items-center gap-1 justify-self-start text-caption font-medium text-foreground',
          )}
        >
          Open source
          <ArrowUpRight aria-hidden className="size-3" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}

/** One source: its title and chapter. Hover, focus or a tap shows its detail; a click opens its page. */
function SourceItem({ citation, excerpt }: { citation: StepCitation; excerpt: string | null }) {
  const url = safeUrl(citation.url);
  const label = citationLabel(citation);
  return (
    <HoverPopover
      label={`Source: ${label}`}
      content={<SourceDetail citation={citation} excerpt={excerpt} />}
      {...(url ? { onActivate: () => undefined } : {})}
    >
      {(props) =>
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            data-slot="step-source"
            className={cn(LINK, '[overflow-wrap:anywhere]')}
            {...props}
          >
            {label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <button type="button" data-slot="step-source" className={cn(LINK, 'text-left')} {...props}>
            {label}
          </button>
        )
      }
    </HoverPopover>
  );
}

/** What a step's method comes from, on one quiet line. */
export function SourceList({
  citations,
  evidence,
  label = 'Sources',
}: {
  citations: readonly StepCitation[];
  evidence: readonly EvidenceItem[];
  label?: ReactNode;
}) {
  if (citations.length === 0) return null;
  return (
    <div data-slot="step-sources" className="flex items-start gap-2 text-caption text-muted-foreground">
      <BookOpen aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <span className="sr-only">{label}: </span>
        <ul className="flex flex-wrap gap-x-1.5 gap-y-1">
          {citations.map((citation, index) => (
            <li key={`${citation.sourceId}:${citation.locator ?? ''}`} className="inline pointer-coarse:py-1">
              <SourceItem citation={citation} excerpt={supportingExcerpt(citation, evidence)} />
              {index < citations.length - 1 ? <span aria-hidden>;</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** What a citation stands on: the source's kind and title, and the passage retrieved for the reply, as it is. */
export function EvidencePreview({ item, onOpen }: { item: EvidenceItem; onOpen: () => void }) {
  const kind = evidenceKindLabel(item);
  const Icon = kind.icon;
  return (
    <div data-slot="evidence-preview" className="grid gap-1.5">
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        {kind.label}
      </p>
      <p className="text-small font-medium [overflow-wrap:anywhere]">{item.title}</p>
      <blockquote className="line-clamp-6 border-l-2 border-border-strong pl-2.5 text-small text-muted-foreground [overflow-wrap:anywhere]">
        {item.excerpt}
      </blockquote>
      <button
        type="button"
        onClick={onOpen}
        className="justify-self-start rounded-sm text-caption font-medium underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        Open source
      </button>
    </div>
  );
}
