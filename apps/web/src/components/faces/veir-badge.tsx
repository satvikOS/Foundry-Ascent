import type { PersonaSummary } from '@foundry/contracts';

import { cn } from '@/lib/utils';

/**
 * The marker that travels with a vEIR's name: "vEIR · AI" for an EIR persona, "AI" for the neutral
 * guide. Text, not colour, carries the meaning.
 */
export function VeirBadge({ kind, className }: { kind: PersonaSummary['kind']; className?: string }) {
  return (
    <span
      data-slot="veir-badge"
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border border-border-strong px-2 font-mono text-[0.625rem] leading-none font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      {kind === 'eir_persona' ? 'vEIR · AI' : 'AI'}
    </span>
  );
}
