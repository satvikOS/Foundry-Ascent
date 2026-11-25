import { UserRoundPen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useVenturePath } from '@/lib/api/hooks/path';
import { safeStorage } from '@/lib/storage';

import { IntakeForm } from './intake-form';

/** Skipped in this browser, per venture (a flag, never what they would have written). */
const skipKey = (ventureId: string) => `fa.path.intake-skipped.${ventureId}`;

/** Whether the venture has a path with nobody's intake on it, and this person has not skipped it here. */
export function useIntakeWanted(ventureId: string, enabled: boolean): { wanted: boolean; skip: () => void } {
  const path = useVenturePath(ventureId, { enabled });
  const [skipped, setSkipped] = useState(() => safeStorage.get(skipKey(ventureId)) === '1');
  return {
    wanted: enabled && !skipped && path.data?.intake === null,
    skip: () => {
      safeStorage.set(skipKey(ventureId), '1');
      setSkipped(true);
    },
  };
}

/**
 * The intake, in the conversation: one quiet row (Start or Skip) that unfolds to six short fields, all optional. It sits
 * in the transcript, so typing to the mentor is never in its way, and it takes no focus by itself.
 */
export function IntakeCard({
  ventureId,
  personaName,
  enabled,
}: {
  ventureId: string;
  personaName: string;
  enabled: boolean;
}) {
  const { wanted, skip } = useIntakeWanted(ventureId, enabled);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  // They pressed Start: the first field, with the whole form in view above the composer.
  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    card?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  if (saved) {
    return (
      <p role="status" className="text-small text-muted-foreground" data-slot="intake-saved">
        Saved. Edit it in Your path.
      </p>
    );
  }
  if (!wanted) return null;
  return (
    <section
      ref={cardRef}
      aria-label="About you"
      data-slot="intake-card"
      data-print="hide"
      className="grid gap-4 rounded-2xl border border-border-card bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <UserRoundPen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-40 flex-1 text-small text-pretty">
          <span className="font-medium">Help {personaName} plan with you.</span>{' '}
          <span className="text-muted-foreground">Six short answers, all optional.</span>
        </p>
        {open ? null : (
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={false}
              onClick={() => {
                setOpen(true);
              }}
            >
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={skip}>
              Skip
            </Button>
          </div>
        )}
      </div>
      {open ? (
        <IntakeForm
          ventureId={ventureId}
          initial={null}
          fields="short"
          cancelLabel="Skip"
          onSaved={() => {
            setSaved(true);
          }}
          onCancel={skip}
        />
      ) : null}
    </section>
  );
}
