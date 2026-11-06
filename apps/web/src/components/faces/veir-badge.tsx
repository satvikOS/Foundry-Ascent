import type { PersonaSummary } from '@foundry/contracts';

import { cn } from '@/lib/utils';

/**
 * The static AI marker of a persona in the EIR studio ("AI"): text, not colour, carries the meaning. Founder
 * surfaces show the mentor's name alone (lib/veir).
 */
export function VeirBadge({ kind: _kind, className }: { kind: PersonaSummary['kind']; className?: string }) {
  return (
    <span
      data-slot="ai-badge"
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border border-border-strong px-2 text-[0.6875rem] leading-none font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      AI
    </span>
  );
}
