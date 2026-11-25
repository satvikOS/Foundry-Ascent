import type { TurnGuidance } from '@foundry/contracts';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';

import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { cn } from '@/lib/utils';

import { TurnStepCard } from './step-card';

/**
 * The step during a call: a panel at the right of the call screen on a wide screen, and one line under its header that
 * unfolds elsewhere, so it never covers the face, the captions or the controls.
 */
export function CallStep({
  guidance,
  tenant,
  ventureId,
}: {
  guidance: TurnGuidance;
  tenant: string;
  ventureId: string;
}) {
  const wide = useMediaQuery(BREAKPOINTS.xl);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (guidance.step === null) return null;
  const card = (
    <TurnStepCard
      guidance={guidance}
      tenant={tenant}
      ventureId={ventureId}
      canEdit
      latest
      dense
      className="border-0 bg-transparent p-0"
    />
  );
  if (wide) {
    return (
      <aside
        aria-label="Next step"
        data-slot="call-step"
        className="glass absolute top-16 right-4 z-10 max-h-[calc(100%-13rem)] w-72 overflow-y-auto rounded-2xl border border-(--glass-border) p-4"
      >
        {card}
      </aside>
    );
  }
  return (
    <section
      aria-label="Next step"
      data-slot="call-step"
      className="glass mx-4 mt-2 min-w-0 rounded-2xl border border-(--glass-border) px-3.5 sm:mx-auto sm:w-full sm:max-w-xl"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="fa-call-focus flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl text-left text-small"
      >
        <span className="shrink-0 text-muted-foreground">Next step</span>
        <span data-slot="next-step" className="min-w-0 flex-1 truncate font-medium">
          {guidance.step.title}
        </span>
        <ChevronDown
          aria-hidden
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div id={id} className="max-h-[40dvh] overflow-y-auto pb-3.5">
          {card}
        </div>
      ) : null}
    </section>
  );
}
