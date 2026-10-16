import { ArrowUp } from 'lucide-react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { cn } from '@/lib/utils';

function EvidenceKey({ k }: { k: string }) {
  return (
    <span className="mx-0.5 inline-flex h-[1.125rem] items-center rounded-[0.25rem] border border-border-strong bg-muted px-1 align-[0.1em] font-mono text-[0.625rem] font-medium text-foreground not-italic">
      {k}
    </span>
  );
}

/**
 * CSS-only product illustration for the landing hero: a short conversation with a vEIR — a founder's
 * question, an answer in the vEIR's voice with cited evidence, a memory it would like to keep, and the
 * disclosure line. Decorative; exposed to assistive technology as one described image. All content is
 * synthetic. Rendered in its final state (no entrance animation), so first paint shows it.
 */
export function ProductPreview({ className }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="Illustration: a founder asks their vEIR, Corin, whether to raise now or finish a paid pilot; Corin answers in plain prose citing evidence E1 and E2, asks one sharp question, and offers to remember a decision."
      className={cn('relative', className)}
    >
      <div
        aria-hidden
        className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-lg select-none"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-3">
          <PersonaAvatar name="Corin" size="sm" decorative />
          <span className="text-small font-medium">Corin</span>
          <span className="rounded-full border border-border-strong px-1.5 font-mono text-[0.5625rem] leading-4 tracking-[0.08em] text-muted-foreground uppercase">
            vEIR · AI
          </span>
          <span className="ml-auto text-caption text-muted-foreground">Helio Grid</span>
        </div>

        <div className="grid gap-5 px-5 pt-5 pb-4">
          <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-small">
            Should we raise a pre-seed now, or finish the paid pilot first?
          </p>

          <div className="grid gap-3 font-serif text-[0.9375rem] leading-[1.6] text-foreground">
            <p>
              Finish the pilot first, Amara. Two sites signed letters of intent last month
              <EvidenceKey k="E1" />, and converting even one to paid use changes the conversation with
              investors
              <EvidenceKey k="E2" />.
            </p>
            <p>
              One question before you decide: <em>what would a site have to see in week six to pay?</em>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-border-strong px-3.5 py-2.5 text-caption">
            <span className="min-w-0 flex-1 text-muted-foreground">
              Corin would like to remember:{' '}
              <span className="text-foreground">finish the pilot before the round</span>
            </span>
            <span className="rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground">
              Keep
            </span>
            <span className="text-muted-foreground">Not now</span>
          </div>
        </div>

        <div className="mx-5 mb-3 flex items-center gap-2 rounded-xl border border-border-strong px-3.5 py-2.5">
          <span className="flex-1 text-small text-muted-foreground">Message Corin…</span>
          <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ArrowUp className="size-3.5" />
          </span>
        </div>
        <p className="px-5 pb-4 text-center text-[0.6875rem] text-muted-foreground">
          Corin is an AI built from an EIR’s approved doctrine and style. Not the EIR.
        </p>
      </div>
    </div>
  );
}
