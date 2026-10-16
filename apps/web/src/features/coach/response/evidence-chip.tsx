import type { EvidenceItem } from '@foundry/contracts';

import { cn } from '@/lib/utils';

interface EvidenceChipProps {
  /** Evidence key, e.g. "E2". */
  evidenceKey: string;
  /** The evidence item the key refers to (null when it is not available for this turn). */
  item: EvidenceItem | null | undefined;
  /** Opens the source (the conversation's Sources panel). Without it the chip is a plain label. */
  onOpen?: ((key: string) => void) | undefined;
  className?: string;
}

/** Chip shape shared by every citation form, so a streamed key and its final chip are the same size. */
const CHIP =
  'mx-0.5 inline-flex h-[18px] items-center justify-center rounded-[5px] border px-1 align-[2px] font-mono text-[11px] leading-none font-medium not-italic pointer-coarse:h-6 pointer-coarse:min-w-7 pointer-coarse:px-1.5 pointer-coarse:align-middle pointer-coarse:text-xs';

/** A citation in an answer that is still streaming (its sources arrive with the finished answer). */
export function CitationKey({ evidenceKey }: { evidenceKey: string }) {
  return (
    <span data-slot="evidence-chip" className={cn(CHIP, 'border-border bg-muted text-muted-foreground')}>
      {evidenceKey}
    </span>
  );
}

/**
 * Citation chip ("E2"). Opens the source in the conversation's Sources panel. The accessible name includes
 * the source title so screen-reader users hear what is cited, not just a code.
 */
export function EvidenceChip({ evidenceKey, item, onOpen, className }: EvidenceChipProps) {
  // Compact in running text; on touch screens it grows to a 24 px target (WCAG 2.5.8) without a layout jump
  // on desktop.
  const base = CHIP;
  if (!item) {
    return (
      <span
        data-slot="evidence-chip"
        data-missing="true"
        title="This source is not available"
        className={cn(base, 'border-dashed border-border-strong text-muted-foreground', className)}
      >
        {evidenceKey}
        <span className="sr-only"> (source not available)</span>
      </span>
    );
  }
  if (!onOpen) {
    return (
      <span
        data-slot="evidence-chip"
        title={item.title}
        className={cn(base, 'border-border-strong bg-muted text-foreground', className)}
      >
        {evidenceKey}
        <span className="sr-only">: {item.title}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="evidence-chip"
      aria-label={`Evidence ${evidenceKey}: ${item.title}`}
      title={item.title}
      onClick={() => {
        onOpen(evidenceKey);
      }}
      className={cn(
        base,
        'cursor-pointer border-border-strong bg-muted text-foreground transition-colors hover:border-foreground/50 hover:bg-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        className,
      )}
    >
      {evidenceKey}
    </button>
  );
}
