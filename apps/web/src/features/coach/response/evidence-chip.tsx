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

/**
 * Chip shape shared by every citation form, so a streamed key and its final chip are the same size: a small,
 * quiet raised number, like a footnote, rather than a code in a box (in a conversation "E4" read as machine
 * output). Side by side ([E1][E2]) the chips sit 24 px apart, centre to centre, as WCAG 2.5.8 asks of small
 * targets; on touch screens each grows to a 24 px target.
 */
const CHIP =
  'mx-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 align-[0.35em] font-sans text-[10px] leading-none font-medium tabular-nums not-italic pointer-coarse:h-6 pointer-coarse:min-w-6 pointer-coarse:px-1.5 pointer-coarse:align-middle pointer-coarse:text-xs';

/** The number shown for a key ("E4" → "4"). */
export function citationNumber(evidenceKey: string): string {
  return evidenceKey.replace(/^E/, '');
}

/**
 * The citation's name as assistive technology says it, starting with the number on screen ("Source 4: …"), so
 * speech input ("click 4") reaches it (WCAG 2.5.3 Label in Name).
 */
export function citationName(evidenceKey: string, title?: string): string {
  const name = `Source ${citationNumber(evidenceKey)}`;
  return title === undefined ? name : `${name}: ${title}`;
}

/** A citation in an answer that is still streaming (its sources arrive with the finished answer). */
export function CitationKey({ evidenceKey }: { evidenceKey: string }) {
  return (
    <span data-slot="evidence-chip" className={cn(CHIP, 'bg-muted text-muted-foreground')}>
      <span aria-hidden>{citationNumber(evidenceKey)}</span>
      <span className="sr-only"> ({citationName(evidenceKey)})</span>
    </span>
  );
}

/**
 * Citation chip (shows "2" for E2). Opens the source in the conversation's Sources panel. Its accessible name starts
 * with the number it shows and includes the source title, so screen-reader users hear what is cited.
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
        className={cn(base, 'border border-dashed border-border-strong text-muted-foreground', className)}
      >
        <span aria-hidden>{citationNumber(evidenceKey)}</span>
        <span className="sr-only"> ({citationName(evidenceKey)} not available)</span>
      </span>
    );
  }
  if (!onOpen) {
    return (
      <span
        data-slot="evidence-chip"
        title={item.title}
        className={cn(base, 'bg-muted text-muted-foreground', className)}
      >
        <span aria-hidden>{citationNumber(evidenceKey)}</span>
        <span className="sr-only"> ({citationName(evidenceKey, item.title)})</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="evidence-chip"
      aria-label={citationName(evidenceKey, item.title)}
      title={item.title}
      onClick={() => {
        onOpen(evidenceKey);
      }}
      className={cn(
        base,
        'cursor-pointer bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        className,
      )}
    >
      {citationNumber(evidenceKey)}
    </button>
  );
}
