import { cn } from '@/lib/utils';

import type { CaptionSize } from './preferences';

interface CallCaptionsProps {
  name: string;
  veir: string | null;
  founder: string | null;
  founderLive: boolean;
  size: CaptionSize;
  /**
   * The call's live region already reads the vEIR's lines to a screen reader (CallLive), so this copy is
   * hidden from it and nothing is read twice.
   */
  readAloud: boolean;
}

const VEIR_SIZE: Record<CaptionSize, string> = {
  sm: 'text-[1.0625rem] sm:text-[1.125rem]',
  md: 'text-[1.25rem] sm:text-[1.375rem]',
  lg: 'text-[1.5rem] sm:text-[1.75rem]',
};

const FOUNDER_SIZE: Record<CaptionSize, string> = {
  sm: 'text-[0.9375rem]',
  md: 'text-[1rem] sm:text-[1.0625rem]',
  lg: 'text-[1.1875rem] sm:text-[1.25rem]',
};

/**
 * Live captions: the vEIR's current sentence (the reading face) and what the founder is saying. Not a live
 * region itself: CallLive's one live region reads the vEIR's lines when there is no voice to talk over, or
 * when the person asked for it.
 */
export function CallCaptions({ name, veir, founder, founderLive, size, readAloud }: CallCaptionsProps) {
  return (
    <section aria-label="Captions" className="mx-auto grid w-full max-w-2xl gap-4 px-2 text-center">
      <p
        aria-hidden={readAloud && veir ? true : undefined}
        className={cn('min-h-[2lh] font-serif leading-[1.5] text-pretty text-foreground', VEIR_SIZE[size])}
      >
        {veir ? (
          <>
            <span className="sr-only">{name}: </span>
            {veir}
          </>
        ) : null}
      </p>
      <p
        className={cn(
          'min-h-[1lh] leading-[1.55] text-pretty text-muted-foreground',
          FOUNDER_SIZE[size],
          founderLive && 'text-subtle-foreground',
        )}
      >
        {founder ? (
          <>
            <span className="label-mono mr-2 align-[0.1em]">You</span>
            {founder}
          </>
        ) : null}
      </p>
    </section>
  );
}
